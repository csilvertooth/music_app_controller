"""The Apple Music Control integration."""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform, CONF_HOST, CONF_PORT, EVENT_HOMEASSISTANT_START
from homeassistant.core import HomeAssistant
import voluptuous as vol
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send

from aiohttp import web
import aiohttp
from homeassistant.components.http import HomeAssistantView
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from urllib.parse import quote

# Imports for cache in thumb proxy
from time import monotonic
from collections import OrderedDict
import hashlib
import os
import json
import time
from pathlib import Path
import shutil
import base64
import asyncio
from homeassistant.components.frontend import (
    async_register_built_in_panel,
    async_remove_panel,
)


from .const import DOMAIN, CONF_SHOW_PANEL

# Signal constant for AirPlay device discovery (used by switch/number platforms)
SIGNAL_AIRPLAY_DEVICES = "apple_music_airplay_devices"

_LOGGER = logging.getLogger(__name__)

_BLANK_PNG = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAoMBgQ2QY1QAAAAASUVORK5CYII="
)

PLATFORMS: list[str] = [Platform.MEDIA_PLAYER, Platform.SWITCH, Platform.NUMBER]


# Sidebar/panel constants
SIDEBAR_PATH = "music-app-controller"   # must contain a hyphen
SIDEBAR_TITLE = "Music Controller"
SIDEBAR_ICON = "mdi:apple"

# Serve the panel JS via a single-file mapping (Alarmo-style)
PANEL_MODULE_URL = f"/{DOMAIN}-panel/music-controller-panel.js"

import re

async def _read_js_asset_version(hass: HomeAssistant) -> str:
    """Async-safe read of panel JS version or file mtime (executor)."""
    js_path = hass.config.path("custom_components", DOMAIN, "frontend", "dist", "music-controller-panel.js")

    def _read_head_or_mtime() -> str:
        try:
            try:
                with open(js_path, "r", encoding="utf-8") as f:
                    head = f.read(4096)
                m = re.search(r"MUSIC_CONTROLLER_JS_VERSION\s*=\s*['\"]([^'\"]+)['\"]", head)
                if m and m.group(1):
                    return str(m.group(1))
            except Exception:
                pass
            try:
                st = os.stat(js_path)
                return str(int(st.st_mtime))
            except Exception:
                pass
        except Exception:
            pass
        return "unknown"

    try:
        return await hass.async_add_executor_job(_read_head_or_mtime)
    except Exception:
        return "unknown"


def _register_static(hass: HomeAssistant) -> None:
    """Idempotently serve built assets at /apple_music_panel.

    If HTTP isn’t ready yet, retry once when Home Assistant starts.
    """
    store = hass.data.setdefault(DOMAIN, {})
    # We may have previously registered the base static dir but not the icon aliases.
    # Do not return early; instead attempt (re)registering aliases idempotently.
    already = bool(store.get("_static_registered"))

    static_dir = Path(__file__).parent / "frontend" / "dist"
    if not static_dir.is_dir():
        _LOGGER.debug("apple_music: no frontend/dist at %s; skipping static mapping", static_dir)
        return

    def _do_register(_event=None):
        try:
            if not store.get("_static_registered"):
                hass.http.register_static_path("/apple_music_panel", str(static_dir), cache_headers=True)
            # Also expose a top-level icon.png at a unique URL so it doesn't
            # conflict with the dist folder routing
            try:
                root_icon = Path(__file__).parent / "icon.png"
                if root_icon.is_file():
                    hass.http.register_static_path("/apple_music_icon.png", str(root_icon), cache_headers=True)
                    # Provide a compatibility alias so existing UI that expects
                    # /apple_music_panel/icon.png also works if the file exists only at the root
                    hass.http.register_static_path("/apple_music_panel/icon.png", str(root_icon), cache_headers=True)
                # Defer to async API to register the brand assets at the exact URLs HA expects
                try:
                    hass.async_create_task(_async_register_brand_assets(hass))
                except Exception:
                    pass
            except Exception:
                pass
            store["_static_registered"] = True
            _LOGGER.debug("apple_music: serving /apple_music_panel from %s", static_dir)
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("apple_music: static path not ready (%s)", e)

    # Try now; if HTTP stack not ready yet, retry once on HA start
    try:
        _do_register()
    except Exception:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_START, _do_register)


# Expose the panel JS at a stable URL (Alarmo-style)
async def _register_panel_assets(hass: HomeAssistant) -> None:
    """Expose the panel JS at a stable URL (Alarmo-style)."""
    from homeassistant.components.http import StaticPathConfig
    root_dir = hass.config.path("custom_components", DOMAIN, "frontend", "dist")
    js_file = os.path.join(root_dir, "music-controller-panel.js")
    # Register a single-file static path; idempotent across restarts
    await hass.http.async_register_static_paths(
        [StaticPathConfig(PANEL_MODULE_URL, js_file, cache_headers=False)]
    )
    # Best-effort: load our module in all frontends so custom cards work anywhere.
    # Older/newer HA versions expose either add_extra_js_url() or async_add_extra_js_url().
    try:
        from homeassistant.components import frontend as _fe  # type: ignore
        _ver = await _read_js_asset_version(hass)
        _url = f"{PANEL_MODULE_URL}?v={_ver}" if _ver and _ver != "unknown" else PANEL_MODULE_URL
        fn = getattr(_fe, "async_add_extra_js_url", None) or getattr(_fe, "add_extra_js_url", None)
        if fn:
            if fn.__name__.startswith("async"):
                await fn(hass, _url)  # type: ignore[misc]
            else:
                fn(hass, _url)  # type: ignore[misc]
    except Exception:
        # If this API is unavailable in this HA version, the module will still load when the panel is opened
        pass


async def _apply_sidebar_panel(hass: HomeAssistant) -> None:
    """(Re)register the custom sidebar panel that loads our JS (Alarmo-style)."""
    from homeassistant.components import panel_custom
    # Remove first to avoid Overwriting panel error on reconfigure
    try:
        async_remove_panel(hass, SIDEBAR_PATH)
    except Exception:
        pass

    # Ensure our panel JS is served at a stable URL
    try:
        await _register_panel_assets(hass)
    except Exception as e:
        _LOGGER.warning("apple_music: failed to register panel assets: %s", e)

    # (Optional) keep directory static mapping for any future assets
    _register_static(hass)

    # Register the panel that loads our module URL and web component
    _ver = await _read_js_asset_version(hass)
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="music-controller-panel",  # must match customElements.define in JS
        frontend_url_path=SIDEBAR_PATH,               # /music-app-controller
        module_url=(f"{PANEL_MODULE_URL}?v={_ver}" if _ver and _ver != "unknown" else PANEL_MODULE_URL),  # cache-bust on changes
        sidebar_title=SIDEBAR_TITLE,
        sidebar_icon=SIDEBAR_ICON,
        require_admin=False,
        config={},
    )


async def _broadcast_local_sse(hass: HomeAssistant, event: str, payload: dict) -> None:
    """Broadcast a small SSE frame to all locally-registered clients.

    Frames are written best-effort; dead clients are pruned silently.
    """
    clients = hass.data.get(DOMAIN, {}).get("sse_clients") or set()
    if not clients:
        return
    data = json.dumps({"event": event, "data": payload})
    frame = f"event: {event}\ndata: {data}\n\n".encode("utf-8")
    stale = []
    for resp in list(clients):
        try:
            await resp.write(frame)
        except Exception:
            stale.append(resp)
    for resp in stale:
        try:
            clients.discard(resp)
        except Exception:
            pass


async def _async_register_brand_assets(hass: HomeAssistant) -> None:
    """Register brand images so they resolve under /static/icons/custom_integrations/apple_music/*.png.

    This complements HA's automatic discovery by explicitly exposing the files,
    which helps in environments where the frontend hasn't indexed them yet.
    """
    from homeassistant.components.http import StaticPathConfig
    base = Path(__file__).parent
    items: list[StaticPathConfig] = []
    for fname in ("icon.png", "logo.png", "dark_icon.png", "dark_logo.png"):
        fpath = base / fname
        if fpath.is_file():
            url = f"/static/icons/custom_integrations/{DOMAIN}/{fname}"
            items.append(StaticPathConfig(url, str(fpath), cache_headers=True))
    if items:
        try:
            await hass.http.async_register_static_paths(items)
            _LOGGER.debug("apple_music: registered brand assets: %s", ", ".join(i.url_path for i in items))
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("apple_music: brand asset registration failed: %s", e)

async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Apple Music Control integration."""
    hass.data.setdefault(DOMAIN, {})
    # Make sure our custom panel assets are served at /apple_music_static/*
    _register_static(hass)
    # Also register brand assets independently of frontend build presence
    try:
        hass.async_create_task(_async_register_brand_assets(hass))
    except Exception:
        # If HTTP not ready yet, retry once at start
        try:
            hass.bus.async_listen_once(EVENT_HOMEASSISTANT_START, lambda _e: hass.async_create_task(_async_register_brand_assets(hass)))
        except Exception:
            pass
    return True

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Apple Music Control from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    host = entry.options.get(CONF_HOST, entry.data.get(CONF_HOST, "localhost"))
    port = entry.options.get(CONF_PORT, entry.data.get(CONF_PORT, 7766))
    base_url = f"http://{host}:{port}"
    hass.data[DOMAIN][entry.entry_id] = {"host": host, "port": port, "base_url": base_url}
    hass.data[DOMAIN]["config"] = {"host": host, "port": port, "base_url": base_url}
    # Serve static panel assets & optionally register the sidebar panel
    _register_static(hass)
    # Ensure brand images are exposed even if frontend build folder is absent
    try:
        await _async_register_brand_assets(hass)
    except Exception:
        pass
    show_panel = entry.options.get(CONF_SHOW_PANEL, True)
    if show_panel:
        await _apply_sidebar_panel(hass)
    else:
        try:
            async_remove_panel(hass, SIDEBAR_PATH)
        except Exception:
            pass

    # Register lightweight proxy endpoints used by the custom panel
    for key, view_cls in (
        ("devices_view", AppleMusicDevicesProxyView),
        ("current_devices_view", AppleMusicCurrentDevicesProxyView),
        ("device_volumes_view", AppleMusicDeviceVolumesProxyView),
        ("device_volume_view", AppleMusicDeviceVolumeProxyView),
        ("set_devices_view", AppleMusicSetDevicesProxyView),
        ("status_view", AppleMusicStatusProxyView),
        ("shuffle_view", AppleMusicShuffleProxyView),
        ("events_view", AppleMusicEventsProxyView),
        ("panel_info_view", AppleMusicPanelInfoView),
        ("queue_artist_shuffled_view", AppleMusicQueueArtistShuffledProxyView),
        ("generic_view", AppleMusicGenericProxyView),
    ):
        if hass.data[DOMAIN].get(key) is None:
            inst = view_cls(hass)
            hass.http.register_view(inst)
            hass.data[DOMAIN][key] = inst

    # Register UI redirect view once so dashboards can iframe without hardcoding IP
    if not hass.data[DOMAIN].get("_ui_view_registered"):
        try:
            hass.http.register_view(AppleMusicUIRedirectView(hass))
            hass.data[DOMAIN]["_ui_view_registered"] = True
            _LOGGER.debug("apple_music: UI redirect view available at /api/apple_music/ui")
        except Exception as e:
            _LOGGER.debug("apple_music: UI redirect view already registered or failed: %s", e)

    # Removed thumbnail proxy view; thumbnails referenced directly from controller

    # Initialize local SSE client registry for optional local events
    store = hass.data.setdefault(DOMAIN, {})
    store.setdefault("sse_clients", set())

    # One-time migration: move legacy thumbs cache to new location
    try:
        old_dir = hass.config.path(".storage/apple_music_thumbs")
        new_dir = hass.config.path(".storage/music_controller/thumbs")
        if os.path.isdir(old_dir):
            # If new dir is empty or missing, migrate
            need_move = True
            if os.path.isdir(new_dir):
                try:
                    need_move = len(os.listdir(new_dir)) == 0
                except Exception:
                    need_move = True
            if need_move:
                Path(new_dir).parent.mkdir(parents=True, exist_ok=True)
                try:
                    # Move contents of old_dir into new_dir, preserve structure
                    for name in os.listdir(old_dir):
                        src = os.path.join(old_dir, name)
                        dst = os.path.join(new_dir, name)
                        try:
                            if os.path.isdir(src):
                                shutil.move(src, dst)
                            else:
                                Path(new_dir).mkdir(parents=True, exist_ok=True)
                                shutil.move(src, dst)
                        except Exception:
                            pass
                    # Cleanup old directory
                    shutil.rmtree(old_dir, ignore_errors=True)
                    _LOGGER.info("apple_music: migrated legacy cache %s -> %s", old_dir, new_dir)
                except Exception as e:
                    _LOGGER.warning("apple_music: legacy cache migration failed: %s", e)
    except Exception:
        pass

    # Note: Artwork caching and related services were removed.

    # Force (re)discovery/creation of AirPlay switches & numbers
    SERVICE_SYNC_AIRPLAY_ENTITIES = "sync_airplay_entities"

    async def _svc_sync_airplay_entities(call):
        """Fetch /devices from backend and broadcast to platforms to (re)create entities."""
        # Resolve current base URL from stored config
        cfg = hass.data.get(DOMAIN, {}).get("config") or {}
        base = cfg.get("base_url")
        if not base:
            host, port = cfg.get("host"), cfg.get("port")
            if host and port:
                base = f"http://{host}:{port}"
        if not base:
            _LOGGER.warning("sync_airplay_entities: backend base URL is unknown")
            return

        session = async_get_clientsession(hass)
        try:
            async with session.get(f"{base}/devices", timeout=10) as resp:
                if resp.status != 200:
                    _LOGGER.warning("/devices returned HTTP %s", resp.status)
                    return
                names = await resp.json()
                if not isinstance(names, list):
                    _LOGGER.warning("/devices returned non-list payload: %s", names)
                    return
        except Exception as e:
            _LOGGER.warning("sync_airplay_entities: error fetching /devices: %s", e)
            return

        # Store and broadcast
        hass.data.setdefault(DOMAIN, {})["last_devices"] = names
        try:
            async_dispatcher_send(hass, SIGNAL_AIRPLAY_DEVICES, names)
        except Exception:
            # Platforms might not be listening yet; that's ok
            pass
        _LOGGER.info("Synced %d AirPlay device(s): %s", len(names), ", ".join(names))

    hass.services.async_register(
        DOMAIN,
        SERVICE_SYNC_AIRPLAY_ENTITIES,
        _svc_sync_airplay_entities,
    )

    # Domain-level service to set a single AirPlay device's volume (0-100)
    SERVICE_SET_DEVICE_VOLUME = "set_device_volume"
    SET_DEVICE_VOLUME_SCHEMA = vol.Schema({
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("device"): str,
        vol.Required("level"): vol.All(int, vol.Range(min=0, max=100)),
    })

    async def _svc_set_device_volume(call):
        device = call.data["device"]
        level = int(call.data["level"])
        player = hass.data.get(DOMAIN, {}).get("player_ref")
        if player and hasattr(player, "async_set_device_volume"):
            await player.async_set_device_volume(device, level)
            return
        # (Optional) fallback could call the backend directly if needed

    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_DEVICE_VOLUME,
        _svc_set_device_volume,
        schema=SET_DEVICE_VOLUME_SCHEMA,
    )

    # Refresh all per-device volume sliders by reading backend once
    SERVICE_REFRESH_DEVICE_VOLUMES = "refresh_device_volumes"

    async def _svc_refresh_device_volumes(call):
        player = hass.data.get(DOMAIN, {}).get("player_ref")
        if player and hasattr(player, "async_refresh_device_volumes"):
            await player.async_refresh_device_volumes()

    hass.services.async_register(
        DOMAIN,
        SERVICE_REFRESH_DEVICE_VOLUMES,
        _svc_refresh_device_volumes,
    )

    # Purge album/thumbnail artwork cache on the backend (exposed for panel + users)
    SERVICE_PURGE_ALBUM_CACHE = "purge_album_cache"

    async def _svc_purge(path: str):
        base = None
        try:
            base = AppleMusicStatusProxyView(hass)._resolve_base_url()  # type: ignore[arg-type]
        except Exception:
            base = None
        if not base:
            return
        session = async_get_clientsession(hass)
        try:
            async with session.post(f"{base}{path}") as resp:
                await resp.read()
        except Exception:
            # Best-effort; ignore failures
            return

    async def _svc_purge_album_cache(call):
        await _svc_purge("/purge_album_cache")

    hass.services.async_register(DOMAIN, SERVICE_PURGE_ALBUM_CACHE, _svc_purge_album_cache)

    # Start SSE listener to push real-time state into HA
    try:
        await _maybe_start_sse_listener(hass, entry)
    except Exception as e:  # pragma: no cover
        _LOGGER.debug("apple_music: SSE listener failed to start: %s", e)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True
class _AppleMusicProxyBase(HomeAssistantView):
    """Base for forwarding requests to the controller at host:port from config entry."""

    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    def _resolve_base_url(self) -> str | None:
        # Prefer live player ref if set by media_player platform
        player = self.hass.data.get(DOMAIN, {}).get("player_ref")
        if player and hasattr(player, "_base_url"):
            return getattr(player, "_base_url")
        cfg = self.hass.data.get(DOMAIN, {}).get("config") or {}
        base = cfg.get("base_url")
        if base:
            return base
        host, port = cfg.get(CONF_HOST), cfg.get(CONF_PORT)
        if host and port:
            return f"http://{host}:{port}"
        return None

    async def _proxy(self, request: web.Request, path: str, method: str = "GET") -> web.StreamResponse:
        base = self._resolve_base_url()
        if not base:
            return web.Response(status=404, text="apple_music not configured")
        url = f"{base}{path}"
        # pass through body & headers for mutating methods
        session = async_get_clientsession(self.hass)
        json_payload = None
        data = None
        if method in {"POST", "PUT", "PATCH"}:
            ctype = request.headers.get("Content-Type", "")
            if "json" in ctype.lower():
                try:
                    json_payload = await request.json()
                except Exception:
                    json_payload = None
            if json_payload is None:
                data = await request.read()

        headers = {k: v for k, v in request.headers.items() if k.lower() not in {"host", "authorization", "cookie"}}
        async with session.request(
            method, url, headers=headers, json=json_payload, data=data, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            body = await resp.read()
            ctype = resp.headers.get("Content-Type") or resp.headers.get("content-type")
            out_headers = {"Content-Type": ctype} if ctype else {}
            return web.Response(status=resp.status, body=body, headers=out_headers)


class AppleMusicDevicesProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/devices"
    name = "apple_music:devices"
    async def get(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/devices", method="GET")


class AppleMusicCurrentDevicesProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/current_devices"
    name = "apple_music:current_devices"
    async def get(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/current_devices", method="GET")


class AppleMusicDeviceVolumesProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/device_volumes"
    name = "apple_music:device_volumes"
    async def get(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/device_volumes", method="GET")


class AppleMusicDeviceVolumeProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/device_volume"
    name = "apple_music:device_volume"
    async def get(self, request: web.Request) -> web.StreamResponse:
        # Preserve query string (?device=...)
        qs = request.rel_url.query_string
        path = "/device_volume" + (f"?{qs}" if qs else "")
        return await self._proxy(request, path, method="GET")

    async def post(self, request: web.Request) -> web.StreamResponse:
        qs = request.rel_url.query_string
        path = "/device_volume" + (f"?{qs}" if qs else "")
        return await self._proxy(request, path, method="POST")

    async def put(self, request: web.Request) -> web.StreamResponse:
        qs = request.rel_url.query_string
        path = "/device_volume" + (f"?{qs}" if qs else "")
        return await self._proxy(request, path, method="PUT")


class AppleMusicSetDevicesProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/set_devices"
    name = "apple_music:set_devices"
    async def post(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/set_devices", method="POST")


class AppleMusicStatusProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/status"
    name = "apple_music:status"
    async def get(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/status", method="GET")

class AppleMusicShuffleProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/shuffle"
    name = "apple_music:shuffle"

    async def get(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/shuffle", method="GET")

    async def post(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/shuffle", method="POST")


class AppleMusicQueueArtistShuffledProxyView(_AppleMusicProxyBase):
    url = "/api/apple_music/queue_artist_shuffled"
    name = "apple_music:queue_artist_shuffled"

    async def post(self, request: web.Request) -> web.StreamResponse:
        return await self._proxy(request, "/queue_artist_shuffled", method="POST")


class AppleMusicEventsProxyView(_AppleMusicProxyBase):
    """Proxy server-sent events from the controller with streaming semantics.

    The generic proxy is not suitable for SSE because it buffers the body.
    """
    url = "/api/apple_music/events"
    name = "apple_music:events"

    async def get(self, request: web.Request) -> web.StreamResponse:
        import asyncio
        base = self._resolve_base_url()
        if not base:
            return web.Response(status=404, text="apple_music not configured")

        url = f"{base}/events"
        session = async_get_clientsession(self.hass)
        try:
            upstream = await session.get(
                url,
                headers={"Accept": "text/event-stream"},
                timeout=aiohttp.ClientTimeout(sock_read=None, total=None),
            )
        except Exception as e:
            _LOGGER.debug("SSE connect failed: %s", e)
            return web.Response(status=502, text="upstream unavailable")

        # If upstream didn't accept, forward status/body once
        if upstream.status != 200:
            try:
                body = await upstream.read()
            except Exception:
                body = b""
            ctype = upstream.headers.get("Content-Type") or upstream.headers.get("content-type") or "text/plain"
            return web.Response(status=upstream.status, body=body, headers={"Content-Type": ctype})

        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
        await resp.prepare(request)
        # Register this response as a local SSE client so we can push local events
        try:
            clients = self.hass.data.get(DOMAIN, {}).setdefault("sse_clients", set())
            clients.add(resp)
        except Exception:
            pass

        try:
            async for chunk in upstream.content.iter_chunked(1024):
                if not chunk:
                    await asyncio.sleep(0)
                    continue
                await resp.write(chunk)
        except asyncio.CancelledError:
            pass
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("SSE proxy stream error: %s", e)
        finally:
            try:
                upstream.close()
            except Exception:
                pass
            try:
                await resp.write_eof()
            except Exception:
                pass
            # Remove from local clients
            try:
                clients = self.hass.data.get(DOMAIN, {}).get("sse_clients")
                if clients and resp in clients:
                    clients.discard(resp)
            except Exception:
                pass
        return resp



class AppleMusicGenericProxyView(_AppleMusicProxyBase):
    """Catch-all proxy so new server endpoints work without code changes.
    Registered after specific views so it won't shadow them.
    """
    url = "/api/apple_music/{path:.*}"
    name = "apple_music:any"

    async def _forward(self, request: web.Request, method: str, path: str) -> web.StreamResponse:
        qs = request.rel_url.query_string
        p = f"/{path}" if path else ""
        if qs:
            p = f"{p}?{qs}"
        return await self._proxy(request, p, method=method)

    async def get(self, request: web.Request, path: str) -> web.StreamResponse:
        return await self._forward(request, "GET", path)

    async def post(self, request: web.Request, path: str) -> web.StreamResponse:
        return await self._forward(request, "POST", path)

    async def put(self, request: web.Request, path: str) -> web.StreamResponse:
        return await self._forward(request, "PUT", path)



    async def patch(self, request: web.Request, path: str) -> web.StreamResponse:
        return await self._forward(request, "PATCH", path)

    async def delete(self, request: web.Request, path: str) -> web.StreamResponse:
        return await self._forward(request, "DELETE", path)


class AppleMusicPanelInfoView(HomeAssistantView):
    url = "/api/apple_music/panel_info"
    name = "apple_music:panel_info"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.StreamResponse:
        from aiohttp import web
        # Read manifest version to align Panel Version with integration version
        manifest_ver = "unknown"
        try:
            mpath = self.hass.config.path("custom_components", DOMAIN, "manifest.json")
            def _read_manifest() -> str:
                try:
                    with open(mpath, "r", encoding="utf-8") as f:
                        return str((json.load(f).get("version") or "unknown"))
                except Exception:
                    return "unknown"
            manifest_ver = await self.hass.async_add_executor_job(_read_manifest)
        except Exception:
            pass
        asset_ver = await _read_js_asset_version(self.hass) or "unknown"
        return web.json_response({
            "panel_version": manifest_ver,
            "asset_version": asset_ver,
        })

# AppleMusicThumbProxyView must be at top-level for use in async_setup_entry

class AppleMusicUIRedirectView(HomeAssistantView):
    """Redirect /api/apple_music/ui[?entry_id=...] to the controller's /ui."""

    url = "/api/apple_music/ui"
    name = "api:apple_music:ui"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.StreamResponse:
        domain_data = self.hass.data.get(DOMAIN) or {}
        entry_id = request.query.get("entry_id")

        base_url = None
        if entry_id and isinstance(domain_data.get(entry_id), dict):
            base_url = domain_data[entry_id].get("base_url")
        if not base_url:
            # Pick the first configured entry that has a base_url
            for _eid, data in domain_data.items():
                if isinstance(data, dict) and data.get("base_url"):
                    base_url = data["base_url"]
                    break

        if not base_url:
            return web.Response(status=404, text="apple_music UI not available: no configured base_url")

        raise web.HTTPFound(f"{base_url}/ui")

async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        # Remove our sidebar panel when the config entry is unloaded
        try:
            async_remove_panel(hass, SIDEBAR_PATH)
        except Exception:
            pass
        # Cancel SSE task if running
        try:
            tasks = hass.data.get(DOMAIN, {}).get("_sse_tasks") or {}
            task = tasks.pop(entry.entry_id, None)
            if task:
                task.cancel()
        except Exception:
            pass
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok


async def _maybe_start_sse_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Start a per-entry SSE listener to update HA state instantly."""
    store = hass.data.setdefault(DOMAIN, {})
    all_tasks = store.setdefault("_sse_tasks", {})
    if entry.entry_id in all_tasks:
        return

    async def _runner():
        import asyncio
        session = async_get_clientsession(hass)

        def _resolve_base_url() -> str | None:
            player = hass.data.get(DOMAIN, {}).get("player_ref")
            if player and hasattr(player, "_base_url"):
                return getattr(player, "_base_url")
            cfg = hass.data.get(DOMAIN, {}).get("config") or {}
            base = cfg.get("base_url")
            if base:
                return base
            host, port = cfg.get("host"), cfg.get("port")
            if host and port:
                return f"http://{host}:{port}"
            return None

        async def _apply_now(now: dict, token: str | None = None):
            """Apply now-playing dict to the player entity and write state."""
            player = hass.data.get(DOMAIN, {}).get("player_ref")
            if not player:
                return
            try:
                from homeassistant.components.media_player import MediaPlayerState as _MPState
                state = (now.get("state") or "").lower()
                if state == "playing":
                    player._state = _MPState.PLAYING
                elif state == "paused":
                    player._state = _MPState.PAUSED
                elif state == "stopped":
                    player._state = _MPState.IDLE
                # Titles
                player._attr_media_title = now.get("title") or None
                player._attr_media_artist = now.get("artist") or None
                player._attr_media_album_name = now.get("album") or None
                # Dur / pos / vol
                dur = now.get("duration")
                pos = now.get("position")
                vol = now.get("volume")
                if isinstance(dur, (int, float)):
                    player._attr_media_duration = int(dur)
                if isinstance(pos, (int, float)):
                    player._attr_media_position = float(pos)
                    from homeassistant.util import dt as _dt
                    player._attr_media_position_updated_at = _dt.utcnow()
                if isinstance(vol, (int, float)):
                    try:
                        player._volume_level = max(0.0, min(1.0, float(vol) / 100.0))
                    except Exception:
                        pass
                # Bump image hash (include token if provided); exclude duration to avoid churn
                import hashlib as _hashlib
                key = f"{player._attr_media_title or ''}|{player._attr_media_artist or ''}|{player._attr_media_album_name or ''}|{token or ''}"
                try:
                    player._attr_media_image_hash = _hashlib.md5(key.encode("utf-8", "ignore")).hexdigest()
                except Exception:
                    player._attr_media_image_hash = None
                # Expose latest artwork token to the entity so media image fetch can use it
                try:
                    player._last_artwork_token = token
                except Exception:
                    pass
                # Provide a direct, same-origin artwork URL for built-in cards
                try:
                    url = "/api/apple_music/artwork"
                    params = []
                    if token:
                        params.append(f"tok={token}")
                    if player._attr_media_image_hash:
                        params.append(f"cache={player._attr_media_image_hash}")
                    if params:
                        url = url + "?" + "&".join(params)
                    player._attr_entity_picture_local = url
                    player._attr_entity_picture = url
                except Exception:
                    pass
            except Exception as e:  # pragma: no cover
                _LOGGER.debug("apply_now failed: %s", e)
            try:
                player.async_write_ha_state()
            except Exception:
                pass
            # Note: artwork persistence/caching removed from HA integration

        async def _apply_airplay(arr: list[dict]):
            player = hass.data.get(DOMAIN, {}).get("player_ref")
            if not player:
                return
            try:
                names = [str(d.get("name")) for d in (arr or []) if d and d.get("name")]
                player._devices = names
                active = [str(d.get("name")) for d in (arr or []) if d and d.get("name") and d.get("active")]
                player._selected_devices = [n for n in active if n in names] or active
                # Per-device volumes
                vols = {}
                for d in arr or []:
                    try:
                        nm = d.get("name")
                        vv = d.get("volume")
                        if nm and isinstance(vv, (int, float)):
                            vols[str(nm)] = int(vv)
                    except Exception:
                        pass
                if vols:
                    bucket = hass.data.get(DOMAIN, {}).get("volume_entities") or {}
                    for name, level in vols.items():
                        ent = bucket.get(name)
                        if ent and level is not None and hasattr(ent, "async_apply_backend_value"):
                            try:
                                await ent.async_apply_backend_value(level)
                            except Exception:  # pragma: no cover
                                pass
            except Exception as e:  # pragma: no cover
                _LOGGER.debug("apply_airplay failed: %s", e)
            try:
                player.async_write_ha_state()
            except Exception:
                pass

        backoff = 1.0
        while True:
            base = _resolve_base_url()
            if not base:
                await asyncio.sleep(5)
                continue
            url = f"{base}/events"
            try:
                async with session.get(
                    url,
                    headers={"Accept": "text/event-stream"},
                    timeout=aiohttp.ClientTimeout(sock_read=None, total=None),
                ) as resp:
                    if resp.status != 200:
                        await asyncio.sleep(min(30, backoff))
                        backoff = min(30, backoff * 2)
                        continue
                    backoff = 1.0
                    data_buf = []
                    event_name = None
                    while True:
                        line_b = await resp.content.readline()
                        if not line_b:
                            # connection ended
                            break
                        try:
                            line = line_b.decode("utf-8", "ignore").rstrip("\r\n")
                        except Exception:
                            line = ""
                        if not line:
                            # dispatch event
                            raw = "\n".join(data_buf).strip()
                            data_buf = []
                            evt = event_name or "message"
                            event_name = None
                            if not raw:
                                continue
                            try:
                                msg = json.loads(raw)
                            except Exception:
                                continue
                            try:
                                ev = (msg.get("event") or evt or "").lower()
                                payload = msg.get("data")
                                if ev == "now":
                                    token = msg.get("artwork_token") or (payload or {}).get("artwork_token")
                                    await _apply_now(payload or {}, token)
                                elif ev == "snapshot":
                                    token = (msg.get("artwork_token") or (payload or {}).get("artwork_token"))
                                    await _apply_now((payload or {}).get("now") or {}, token)
                                    air = (payload or {}).get("airplay")
                                    if isinstance(air, list):
                                        await _apply_airplay(air)
                                elif ev == "airplay_full":
                                    if isinstance(payload, list):
                                        await _apply_airplay(payload)
                                elif ev == "master_volume":
                                    if isinstance(payload, (int, float)):
                                        await _apply_now({"volume": payload})
                            except Exception as e:  # pragma: no cover
                                _LOGGER.debug("SSE apply error: %s", e)
                            continue
                        if line.startswith(":"):
                            continue
                        if line.startswith("data:"):
                            data_buf.append(line[5:].lstrip())
                            continue
                        if line.startswith("event:"):
                            event_name = line[6:].strip()
                            continue
                        # ignore other SSE fields (id, retry)
            except asyncio.CancelledError:
                break
            except Exception as e:
                _LOGGER.debug("SSE loop error: %s", e)
                await asyncio.sleep(min(30, backoff))
                backoff = min(30, backoff * 2)

    task = hass.loop.create_task(_runner())
    store.setdefault("_sse_tasks", {})[entry.entry_id] = task
