"""The Apple Music Control integration."""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform, CONF_HOST, CONF_PORT
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

from .const import DOMAIN

# Signal constant for AirPlay device discovery (used by switch/number platforms)
SIGNAL_AIRPLAY_DEVICES = "apple_music_airplay_devices"

_LOGGER = logging.getLogger(__name__)

_BLANK_PNG = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAoMBgQ2QY1QAAAAASUVORK5CYII="
)

PLATFORMS: list[str] = [Platform.MEDIA_PLAYER, Platform.SWITCH, Platform.NUMBER]

async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Apple Music Control integration."""
    hass.data.setdefault(DOMAIN, {})
    return True

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Apple Music Control from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    host = entry.options.get(CONF_HOST, entry.data.get(CONF_HOST, "localhost"))
    port = entry.options.get(CONF_PORT, entry.data.get(CONF_PORT, 5000))
    base_url = f"http://{host}:{port}"
    hass.data[DOMAIN][entry.entry_id] = {"host": host, "port": port, "base_url": base_url}
    hass.data[DOMAIN]["config"] = {"host": host, "port": port, "base_url": base_url}
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    class AppleMusicThumbProxyView(HomeAssistantView):
        url = "/api/apple_music/thumb/{kind}/{name:.*}"
        name = "api:apple_music:thumb"
        requires_auth = True

        def __init__(self, hass: HomeAssistant) -> None:
            self.hass = hass
            # Simple in-memory LRU cache for thumbnails (key=(kind,name))
            self._cache: "OrderedDict[tuple[str,str], tuple[float, bytes, str, str]]" = OrderedDict()
            self._cache_ttl: float = 300.0   # seconds
            self._cache_max: int = 300       # entries
            # Persistent on-disk cache (survives restarts)
            self._disk_cache_dir: str = self.hass.config.path(".storage/apple_music_thumbs")
            self._disk_ttl: float | None = None  # None = no expiry
            try:
                Path(self._disk_cache_dir).mkdir(parents=True, exist_ok=True)
            except Exception:
                pass

        def _resolve_base_url(self) -> str | None:
            # Prefer the live player reference if available
            player = self.hass.data.get(DOMAIN, {}).get("player_ref")
            if player and hasattr(player, "_base_url"):
                return getattr(player, "_base_url")
            # Fallback to stored config
            cfg = self.hass.data.get(DOMAIN, {}).get("config") or {}
            base = cfg.get("base_url")
            if base:
                return base
            host, port = cfg.get("host"), cfg.get("port")
            if host and port:
                return f"http://{host}:{port}"
            return None

        def _cache_get(self, kind: str, name: str):
            key = (kind, name)
            now = monotonic()
            entry = self._cache.get(key)
            if not entry:
                return None
            exp, data, ctype, etag = entry
            if now >= exp:
                # expired
                try:
                    del self._cache[key]
                except Exception:
                    pass
                return None
            # refresh LRU order
            self._cache.move_to_end(key)
            return data, ctype, etag

        def _cache_put(self, kind: str, name: str, data: bytes, ctype: str):
            key = (kind, name)
            # compute strong ETag from bytes
            etag = hashlib.sha1(data).hexdigest()
            exp = monotonic() + self._cache_ttl
            self._cache[key] = (exp, data, ctype, etag)
            self._cache.move_to_end(key)
            # evict oldest if over capacity
            while len(self._cache) > self._cache_max:
                self._cache.popitem(last=False)
            return etag

        def _slug(self, name: str) -> str:
            # Safe filename using percent-encoding; avoid path traversal
            return quote(name, safe="")

        def _disk_paths(self, kind: str, name: str) -> tuple[str, str]:
            kdir = os.path.join(self._disk_cache_dir, kind)
            # For thumbs, pretty-print into a size subfolder when key uses the pattern "<size>x/<name>"
            if kind.endswith("_thumb") and isinstance(name, str):
                # Expect key_name like "128x/<album>"
                if "x/" in name:
                    size_prefix, _, rest = name.partition("x/")
                    if size_prefix.isdigit() and rest:
                        kdir = os.path.join(kdir, size_prefix)
                        name = rest
            try:
                Path(kdir).mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
            slug = self._slug(name)
            meta = os.path.join(kdir, f"{slug}.json")
            data = os.path.join(kdir, f"{slug}.bin")
            return meta, data

        def _disk_load(self, kind: str, name: str, allow_stale: bool = False):
            meta_path, data_path = self._disk_paths(kind, name)
            try:
                with open(meta_path, "r", encoding="utf-8") as mf:
                    meta = json.load(mf)
                etag = meta.get("etag")
                ctype = meta.get("ctype", "image/jpeg")
                exp = meta.get("exp")
                if exp is not None and not allow_stale:
                    try:
                        now = time.time()
                        if now >= float(exp):
                            return None
                    except Exception:
                        pass
                with open(data_path, "rb") as df:
                    data = df.read()
                if not data:
                    return None
                return data, ctype, etag
            except Exception:
                return None

        def _disk_save(self, kind: str, name: str, data: bytes, ctype: str, etag: str):
            meta_path, data_path = self._disk_paths(kind, name)
            meta = {"etag": etag, "ctype": ctype}
            if getattr(self, "_disk_ttl", None):
                try:
                    meta["exp"] = time.time() + float(self._disk_ttl)  # optional expiry if a TTL is set
                except Exception:
                    pass
            try:
                with open(data_path, "wb") as df:
                    df.write(data)
                with open(meta_path, "w", encoding="utf-8") as mf:
                    json.dump(meta, mf)
            except Exception:
                pass

        async def get(self, request: web.Request, kind: str, name: str) -> web.StreamResponse:
            base = self._resolve_base_url()
            if not base:
                return web.Response(status=404)

            kind = (kind or "").lower()
            size: int | None = None
            # Handle legacy thumb URLs where size was part of the path: /thumb/album_thumb/128/<name>
            # In that case, `name` arrives as "128/<name>". Extract the size and clean the name.
            if kind.endswith("_thumb") and name and "/" in name:
                first_seg, _, rest = name.partition("/")
                if first_seg.isdigit() and rest:
                    try:
                        size = int(first_seg)
                    except Exception:
                        size = None
                    name = rest
            if kind == "album":
                endpoint = "artwork_album"
            elif kind == "playlist":
                endpoint = "artwork_playlist"
            elif kind == "artist":
                endpoint = "artwork_artist"
            elif kind == "icon":
                endpoint = "icon"
            elif kind in ("album_thumb", "playlist_thumb", "artist_thumb"):
                # If size was not extracted from legacy path, read it from query (?sz=128 or ?size=128)
                if size is None:
                    try:
                        size = int(request.query.get("sz") or request.query.get("size") or 128)
                    except Exception:
                        size = 128
                size = max(16, min(512, int(size)))
                endpoint = {
                    "album_thumb": "artwork_album_thumb",
                    "playlist_thumb": "artwork_playlist_thumb",
                    "artist_thumb": "artwork_artist_thumb",
                }[kind]
            else:
                return web.Response(status=404)

            # Include size in cache key for thumbs so different sizes don't collide
            key_name = f"{size}x/{name}" if kind.endswith("_thumb") else name
            inm = request.headers.get("If-None-Match")

            # 1) Disk cache (fresh)
            disk_hit = self._disk_load(kind, key_name, allow_stale=True)
            if disk_hit:
                data, ctype, etag = disk_hit
                self._cache_put(kind, key_name, data, ctype)
                if inm and inm == etag:
                    return web.Response(status=304, headers={
                        "ETag": etag,
                        "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                    })
                return web.Response(body=data, headers={
                    "Content-Type": ctype,
                    "ETag": etag,
                    "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                })

            # 2) Memory cache
            cached = self._cache_get(kind, key_name)
            if cached:
                data, ctype, etag = cached
                if inm and inm == etag:
                    return web.Response(status=304, headers={
                        "ETag": etag,
                        "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                    })
                return web.Response(body=data, headers={
                    "Content-Type": ctype,
                    "ETag": etag,
                    "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                })

            session = async_get_clientsession(self.hass)

            # 3) META preflight (skip for icon)
            if endpoint != "icon":
                try:
                    if kind.endswith("_thumb"):
                        meta_url = f"{base}/{endpoint}_meta/{size}/{quote(name)}"
                    else:
                        meta_url = f"{base}/{endpoint}_meta/{quote(name)}"
                    async with session.get(meta_url, timeout=aiohttp.ClientTimeout(total=2)) as mresp:
                        if mresp.status == 200:
                            meta = await mresp.json()
                            etag = meta.get("etag")
                            ctype = meta.get("ctype") or "image/jpeg"
                            if etag:
                                stale = self._disk_load(kind, key_name, allow_stale=True)
                                if stale:
                                    sdata, sctype, setag = stale
                                    if setag == etag:
                                        self._cache_put(kind, key_name, sdata, sctype)
                                        if inm and inm == etag:
                                            return web.Response(status=304, headers={
                                                "ETag": etag,
                                                "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                                            })
                                        return web.Response(body=sdata, headers={
                                            "Content-Type": sctype,
                                            "ETag": etag,
                                            "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                                        })
                except Exception:
                    pass

            # 4) Fetch bytes from backend and cache
            try:
                fetch_url = (
                    f"{base}/{endpoint}/{size}/{quote(name)}"
                    if kind.endswith("_thumb")
                    else f"{base}/{endpoint}/{quote(name)}"
                )
                async with session.get(fetch_url, timeout=aiohttp.ClientTimeout(total=2)) as resp:
                    if resp.status != 200:
                        return web.Response(status=resp.status)
                    data = await resp.read()
                    if not data:
                        return web.Response(status=404)
                    ctype = resp.headers.get("Content-Type") or resp.headers.get("content-type") or "image/jpeg"
                    etag = self._cache_put(kind, key_name, data, ctype)
                    self._disk_save(kind, key_name, data, ctype, etag)
                    return web.Response(body=data, headers={
                        "Content-Type": ctype,
                        "ETag": etag,
                        "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                    })
            except Exception:
                # Backend failed; try serving stale disk cache if available
                stale = self._disk_load(kind, key_name, allow_stale=True)
                if stale:
                    data, ctype, etag = stale
                    return web.Response(body=data, headers={
                        "Content-Type": ctype,
                        "ETag": etag,
                        "Cache-Control": "public, max-age=31536000, stale-while-revalidate=300",
                        "Warning": "110 - stale artwork served",
                    })
                return web.Response(
                    body=_BLANK_PNG,
                    headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=60"},
                    status=200,
                )

    view = hass.data[DOMAIN].get("thumb_view")
    if view is None:
        view = AppleMusicThumbProxyView(hass)
        hass.http.register_view(view)
        hass.data[DOMAIN]["thumb_view"] = view
    # Service to purge browse-media thumbnail caches (memory + disk)
    SERVICE_PURGE_THUMB_CACHE = "purge_thumb_cache"

    async def _svc_purge_thumb_cache(call):
        view = hass.data.get(DOMAIN, {}).get("thumb_view")
        # Clear in-memory LRU
        try:
            if view and hasattr(view, "_cache"):
                view._cache.clear()
        except Exception:  # pragma: no cover
            pass
        # Clear persistent disk cache
        try:
            cache_dir = getattr(view, "_disk_cache_dir", None)
            if cache_dir:
                shutil.rmtree(cache_dir, ignore_errors=True)
                Path(cache_dir).mkdir(parents=True, exist_ok=True)
        except Exception as e:  # pragma: no cover
            _LOGGER.warning("purge_thumb_cache: disk cleanup error: %s", e)

    hass.services.async_register(
        DOMAIN,
        SERVICE_PURGE_THUMB_CACHE,
        _svc_purge_thumb_cache,
    )

    # Service to purge full-size album/playlist/artist artwork (keeps thumbnails)
    SERVICE_PURGE_ALBUM_CACHE = "purge_album_cache"

    async def _svc_purge_album_cache(call):
        view = hass.data.get(DOMAIN, {}).get("thumb_view")
        # Clear in-memory entries for non-thumb kinds
        try:
            if view and hasattr(view, "_cache"):
                for k in list(view._cache.keys()):
                    kind = k[0]
                    if not kind.endswith("_thumb"):
                        try:
                            del view._cache[k]
                        except Exception:
                            pass
        except Exception as e:  # pragma: no cover
            _LOGGER.warning("purge_album_cache: memory cleanup error: %s", e)
        # Clear persistent disk cache for album/artist/playlist/icon kinds
        try:
            cache_dir = getattr(view, "_disk_cache_dir", None)
            if cache_dir:
                for kind in ("album", "artist", "playlist", "icon"):
                    shutil.rmtree(os.path.join(cache_dir, kind), ignore_errors=True)
            # Recreate base dir to ensure structure exists
            if cache_dir:
                Path(cache_dir).mkdir(parents=True, exist_ok=True)
        except Exception as e:  # pragma: no cover
            _LOGGER.warning("purge_album_cache: disk cleanup error: %s", e)

    hass.services.async_register(
        DOMAIN,
        SERVICE_PURGE_ALBUM_CACHE,
        _svc_purge_album_cache,
    )

    # Force (re)discovery/creation of AirPlay switches & numbers
    SERVICE_SYNC_AIRPLAY_ENTITIES = "sync_airplay_entities"

    async def _svc_sync_airplay_entities(call):
        """Fetch /devices from backend and broadcast to platforms to (re)create entities."""
        # Reuse the proxy view's logic to resolve current base URL
        view = hass.data.get(DOMAIN, {}).get("thumb_view")
        base = None
        if view and hasattr(view, "_resolve_base_url"):
            try:
                base = view._resolve_base_url()
            except Exception:
                base = None
        if not base:
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
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True

async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok
