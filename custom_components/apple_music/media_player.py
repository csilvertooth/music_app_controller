"""Support for Apple Music media player."""
from __future__ import annotations
import asyncio

import logging
from async_timeout import timeout
from urllib.parse import quote
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from typing import Any
import time
import hashlib
from homeassistant.util import dt as dt_util

from homeassistant.components.media_player import (
    MediaPlayerEntity,
    MediaPlayerState,
    MediaPlayerEntityFeature,
    BrowseMedia,
    SearchMedia,
    SearchMediaQuery,
)
from homeassistant.components.media_player.const import MediaType, MediaClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers import entity_platform
import voluptuous as vol
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

from datetime import timedelta

# Reduce poll latency so HA clients refresh closer to real-time
SCAN_INTERVAL = timedelta(seconds=3)

async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Apple Music media player from a config entry."""
    apple_music_player = AppleMusicPlayer(hass, config_entry)
    async_add_entities([apple_music_player])

    # Expose the player to the domain-level service
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["player_ref"] = apple_music_player

    # Register a per-entity service to set multiple AirPlay devices at once
    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service(
        "set_selected_airplay_devices",
        {vol.Required("devices"): vol.All(cv.ensure_list, [str])},
        "async_set_selected_airplay_devices",
    )

class AppleMusicPlayer(MediaPlayerEntity):
    """Representation of Apple Music media player."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the Apple Music player."""
        self._entry = entry
        self._host = entry.options.get(CONF_HOST, entry.data.get(CONF_HOST, "localhost"))
        self._port = entry.options.get(CONF_PORT, entry.data.get(CONF_PORT, 7766))
        self._base_url = f"http://{self._host}:{self._port}"
        self._state = MediaPlayerState.IDLE
        self._volume_level = 0.5
        self._playlists = []
        self._albums = []
        self._artists = []
        self._songs = []
        self._devices = []
        self._selected_devices = []
        self._current_media = None
        self._attr_name = "Music Controller Player"
        # Stable unique_id tied to the config entry, so IP/port changes won't replace the entity
        self._attr_unique_id = f"apple_music_player_{entry.entry_id}"
        # Group under the same device as switches/numbers
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, "server")},
            name="Music Controller",
            manufacturer="Apple",
            model="Music + AirPlay",
        )
        self._session = async_get_clientsession(hass)
        self._attr_should_poll = True
        # Now Playing attributes
        self._attr_media_image_remotely_accessible = False
        self._attr_media_image_hash = None
        self._attr_media_title = None
        self._attr_media_artist = None
        self._attr_media_album_name = None
        self._attr_media_duration = None
        self._attr_media_position = None
        self._attr_supported_features = (
            MediaPlayerEntityFeature.PLAY_MEDIA
            | MediaPlayerEntityFeature.PLAY
            | MediaPlayerEntityFeature.PAUSE
            | MediaPlayerEntityFeature.STOP
            | MediaPlayerEntityFeature.VOLUME_SET
            | MediaPlayerEntityFeature.BROWSE_MEDIA
            | MediaPlayerEntityFeature.SELECT_SOURCE
            | MediaPlayerEntityFeature.NEXT_TRACK
            | MediaPlayerEntityFeature.PREVIOUS_TRACK
            | MediaPlayerEntityFeature.SEARCH_MEDIA
        )

    @property
    def suggested_object_id(self) -> str:
        # Enforce media_player.music_control_player for new setups
        return "music_control_player"
    def _search_results_to_browse(
        self,
        data: dict[str, Any],
        allowed: set[MediaClass] | None,
    ) -> list[BrowseMedia]:
        """Convert backend search results (dict) to a list of BrowseMedia items."""
        if not isinstance(data, dict):
            return []

        # Map server keys to MediaClass and to our content_id prefixes
        key_map: list[tuple[str, MediaClass, str]] = [
            ("albums", MediaClass.ALBUM, "album:"),
            ("artists", MediaClass.ARTIST, "artist:"),
            ("playlists", MediaClass.PLAYLIST, "playlist:"),
            ("songs", MediaClass.TRACK, "song:"),  # prefer "songs"
            ("tracks", MediaClass.TRACK, "song:"),  # fallback key name
        ]

        # If allowed is provided, only include those classes
        results: list[BrowseMedia] = []
        for key, mclass, prefix in key_map:
            if allowed and mclass not in allowed:
                continue
            items = data.get(key)
            if not isinstance(items, list):
                continue
            for item in items:
                # item can be a string name or a dict with more metadata
                if isinstance(item, str):
                    title = item
                elif isinstance(item, dict):
                    title = item.get("name") or item.get("title") or item.get("id") or "Unknown"
                else:
                    continue

                # Build a thumbnail if we recognize the class
                thumb = None
                if mclass is MediaClass.ALBUM:
                    thumb = f"/api/apple_music/thumb/album/{quote(title)}"

                # By default, search results should be expandable for containers and playable for tracks
                can_expand = mclass in (MediaClass.ALBUM, MediaClass.ARTIST, MediaClass.PLAYLIST)
                can_play = mclass in (MediaClass.TRACK, MediaClass.PLAYLIST)

                results.append(
                    BrowseMedia(
                        title=title,
                        media_class=mclass,
                        media_content_id=f"{prefix}{title}",
                        media_content_type=MediaType.MUSIC if can_play else "library",
                        can_play=can_play,
                        can_expand=can_expand,
                        thumbnail=thumb,
                    )
                )
        return results

    async def async_search_media(self, query: SearchMediaQuery) -> SearchMedia:
        """Search the library via the standard Home Assistant interface.

        Tries the backend `/search` endpoint first, with optional filtering by media class.
        Falls back to client-side filtering of cached lists if the backend does not provide search.
        """
        term = (getattr(query, "search_query", None) or "").strip()
        if not term:
            return SearchMedia(result=[])

        # Build allowed classes set, if provided
        allowed: set[MediaClass] | None = None
        try:
            mf = getattr(query, "media_filter_classes", None)
            if mf:
                allowed = set(mf)
        except Exception:  # pragma: no cover
            allowed = None

        # Try server-side search first
        results: list[BrowseMedia] = []
        try:
            params: dict[str, str] = {"q": term}
            if allowed:
                type_map = {
                    MediaClass.ALBUM: "album",
                    MediaClass.ARTIST: "artist",
                    MediaClass.TRACK: "song",
                    MediaClass.PLAYLIST: "playlist",
                }
                wanted = sorted({type_map[c] for c in allowed if c in type_map})
                if wanted:
                    params["types"] = ",".join(wanted)
            async with timeout(10):
                async with self._session.get(f"{self._base_url}/search", params=params) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        results = self._search_results_to_browse(data, allowed)
                    else:
                        _LOGGER.debug("/search returned HTTP %s", resp.status)
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("/search failed, falling back to local search: %s", e)

        # Fallback: client-side search over cached lists
        if not results:
            term_low = term.lower()
            # Ensure caches exist
            try:
                if not self._albums:
                    self._albums = await self._get_json("/albums")
            except Exception:  # pragma: no cover
                pass
            try:
                if not self._artists:
                    self._artists = await self._get_json("/artists")
            except Exception:  # pragma: no cover
                pass
            try:
                if not self._playlists:
                    self._playlists = await self._get_json("/playlists")
            except Exception:  # pragma: no cover
                pass

            local: dict[str, list[str]] = {}
            if not allowed or MediaClass.ALBUM in allowed:
                local["albums"] = [a for a in (self._albums or []) if term_low in str(a).lower()]
            if not allowed or MediaClass.ARTIST in allowed:
                local["artists"] = [a for a in (self._artists or []) if term_low in str(a).lower()]
            if not allowed or MediaClass.PLAYLIST in allowed:
                local["playlists"] = [p for p in (self._playlists or []) if term_low in str(p).lower()]

            results = self._search_results_to_browse(local, allowed)

        return SearchMedia(result=results)

        self._last_device_vol_sync = 0.0

    async def _get_json(self, path: str):
        """GET JSON from the backend with a 10s timeout."""
        async with timeout(10):
            async with self._session.get(f"{self._base_url}{path}") as resp:
                resp.raise_for_status()
                return await resp.json()

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "available_devices": self._devices,
            "selected_devices": self._selected_devices,
        }

    @property
    def state(self) -> MediaPlayerState:
        return self._state

    @property
    def volume_level(self) -> float:
        return self._volume_level

    @property
    def source_list(self) -> list[str]:
        return self._devices

    @property
    def source(self) -> str | None:
        if not self._selected_devices:
            return None
        return self._selected_devices[0]

    async def async_select_source(self, source: str) -> None:
        """Select a single AirPlay device from the available list and apply it in Music immediately."""
        devices = self._devices or []
        if source in devices:
            self._selected_devices = [source]
            # Apply to Apple Music now
            try:
                async with timeout(10):
                    async with self._session.post(
                        f"{self._base_url}/set_devices",
                        json={"devices": source},
                    ) as resp:
                        if resp.status != 200:
                            _LOGGER.warning("/set_devices failed: %s", await resp.text())
            except Exception as e:  # pragma: no cover
                _LOGGER.debug("/set_devices exception: %s", e)
            self.async_write_ha_state()
            await self._maybe_refresh_device_volumes()
        else:
            _LOGGER.warning("Unknown AirPlay device requested: %s", source)

    async def async_set_selected_airplay_devices(self, devices: list[str]) -> None:
        """Set multiple AirPlay output devices and apply immediately in Music."""
        # Only keep devices that are actually available right now
        valid = [d for d in (devices or []) if d in (self._devices or [])]
        # De-duplicate while preserving order
        seen = set()
        self._selected_devices = [d for d in valid if not (d in seen or seen.add(d))]
        csv = ",".join(self._selected_devices)
        _LOGGER.debug("Selected AirPlay devices set to: %s", self._selected_devices)

        # Apply to Apple Music now
        if csv:
            try:
                async with timeout(10):
                    async with self._session.post(
                        f"{self._base_url}/set_devices",
                        json={"devices": csv},
                    ) as resp:
                        if resp.status != 200:
                            _LOGGER.warning("/set_devices failed: %s", await resp.text())
            except Exception as e:  # pragma: no cover
                _LOGGER.debug("/set_devices exception: %s", e)

        self.async_write_ha_state()
        await self._maybe_refresh_device_volumes()

    async def async_browse_media(self, media_content_type: str | None = None, media_content_id: str | None = None) -> BrowseMedia:
        """Browse the media library, returning BrowseMedia objects."""
        if media_content_id:
            if media_content_id == "playlists":
                # Fetch on-demand if empty
                if not self._playlists:
                    async with timeout(10):
                        async with self._session.get(f"{self._base_url}/playlists") as resp:
                            resp.raise_for_status()
                            self._playlists = await resp.json()
                children = [
                    BrowseMedia(
                        title=f"🎧 {p}",
                        media_class=MediaClass.DIRECTORY,
                        media_content_id=f"playlist:{p}",
                        media_content_type="library",
                        can_play=False,
                        can_expand=True,
                    )
                    for p in self._playlists
                ]
            elif media_content_id == "albums":
                # Fetch on-demand if empty
                if not self._albums:
                    async with timeout(10):
                        async with self._session.get(f"{self._base_url}/albums") as resp:
                            resp.raise_for_status()
                            self._albums = await resp.json()
                children = [
                    BrowseMedia(
                        title=f"💿 {a}",
                        media_class=MediaClass.ALBUM,
                        media_content_id=f"album:{a}",
                        media_content_type="library",
                        can_play=False,
                        can_expand=True,
                        thumbnail=f"/api/apple_music/thumb/album/{quote(a)}",
                    )
                    for a in self._albums
                ]
            elif media_content_id == "artists":
                # Fetch on-demand if empty
                if not self._artists:
                    async with timeout(10):
                        async with self._session.get(f"{self._base_url}/artists") as resp:
                            resp.raise_for_status()
                            self._artists = await resp.json()
                children = [
                    BrowseMedia(
                        title=f"👤 {a}",
                        media_class=MediaClass.DIRECTORY,
                        media_content_id=f"artist:{a}",
                        media_content_type="library",
                        can_play=False,
                        can_expand=True,
                    )
                    for a in self._artists
                ]
            elif media_content_id.startswith("playlist:"):
                playlist = media_content_id.replace("playlist:", "")
                async with timeout(10):
                    async with self._session.get(f"{self._base_url}/songs/{quote(playlist)}") as resp:
                        resp.raise_for_status()
                        self._songs = await resp.json()
                children = [
                    BrowseMedia(
                        title="Play playlist",
                        media_class=MediaClass.PLAYLIST,
                        media_content_id=f"play_playlist:{playlist}",
                        media_content_type=MediaType.MUSIC,
                        can_play=True,
                        can_expand=False,
                    ),
                    BrowseMedia(
                        title="Shuffle play",
                        media_class=MediaClass.PLAYLIST,
                        media_content_id=f"shuffle_playlist:{playlist}",
                        media_content_type=MediaType.MUSIC,
                        can_play=True,
                        can_expand=False,
                    ),
                ] + [
                    BrowseMedia(
                        title=f"{idx:02d}. {s}",
                        media_class=MediaClass.TRACK,
                        media_content_id=f"song:{s}||playlist={playlist}||idx={idx}",
                        media_content_type=MediaType.MUSIC,
                        can_play=True,
                        can_expand=False,
                    )
                    for idx, s in enumerate(self._songs, start=1)
                ]
            elif media_content_id.startswith("album:"):
                album = media_content_id.replace("album:", "")
                async with timeout(10):
                    async with self._session.get(f"{self._base_url}/songs_by_album/{quote(album)}") as resp:
                        resp.raise_for_status()
                        songs = await resp.json()
                children = [
                    BrowseMedia(
                        title="Play album",
                        media_class=MediaClass.ALBUM,
                        media_content_id=f"play_album:{album}",
                        media_content_type=MediaType.MUSIC,
                        can_play=True,
                        can_expand=False,
                    ),
                    BrowseMedia(
                        title="Shuffle play",
                        media_class=MediaClass.ALBUM,
                        media_content_id=f"shuffle_album:{album}",
                        media_content_type=MediaType.MUSIC,
                        can_play=True,
                        can_expand=False,
                    ),
                ] + [
                    BrowseMedia(
                        title=f"{idx:02d}. {s}",
                        media_class=MediaClass.TRACK,
                        media_content_id=f"song:{s}||album={album}||idx={idx}",
                        media_content_type=MediaType.MUSIC,
                        can_play=True,
                        can_expand=False,
                    )
                    for idx, s in enumerate(songs, start=1)
                ]
                return BrowseMedia(
                    title=album,
                    media_class=MediaClass.DIRECTORY,
                    media_content_id=f"album:{album}",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                    children=children,
                    children_media_class=MediaClass.TRACK,
                )
            elif media_content_id.startswith("artist:"):
                artist = media_content_id.replace("artist:", "")
                async with timeout(10):
                    async with self._session.get(f"{self._base_url}/albums_by_artist/{quote(artist)}") as resp:
                        resp.raise_for_status()
                        albums = await resp.json()
                children = [
                    BrowseMedia(
                        title=f"💿 {a}",
                        media_class=MediaClass.ALBUM,
                        media_content_id=f"album:{a}",
                        media_content_type="library",
                        can_play=False,
                        can_expand=True,
                        thumbnail=f"/api/apple_music/thumb/album/{quote(a)}",
                    )
                    for a in albums
                ]
                return BrowseMedia(
                    title=artist,
                    media_class=MediaClass.DIRECTORY,
                    media_content_id=f"artist:{artist}",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                    children=children,
                    children_media_class=MediaClass.DIRECTORY,
                )
            else:
                children = []

            return BrowseMedia(
                title=(media_content_id.split(":")[0].capitalize() or "Apple Music"),
                media_class=MediaClass.DIRECTORY,
                media_content_id=media_content_id,
                media_content_type="library",
                can_play=False,
                can_expand=True,
                children=children,
                children_media_class=MediaClass.DIRECTORY,
            )

        # Root level
        return BrowseMedia(
            title="Apple Music",
            media_class=MediaClass.DIRECTORY,
            media_content_id="root",
            media_content_type="library",
            can_play=False,
            can_expand=True,
            children=[
                BrowseMedia(
                    title="🎶 Playlists",
                    media_class=MediaClass.DIRECTORY,
                    media_content_id="playlists",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                ),
                BrowseMedia(
                    title="💿 Albums",
                    media_class=MediaClass.DIRECTORY,
                    media_content_id="albums",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                ),
                BrowseMedia(
                    title="👤 Artists",
                    media_class=MediaClass.DIRECTORY,
                    media_content_id="artists",
                    media_content_type="library",
                    can_play=False,
                    can_expand=True,
                ),
            ],
            children_media_class=MediaClass.DIRECTORY,
        )

    async def async_play_media(self, media_type: str, media_id: str, **kwargs) -> None:
        """Play media."""
        if media_type in (MediaType.MUSIC, "music"):
            if media_id.startswith("play_playlist:"):
                name = media_id.replace("play_playlist:", "")
                type_ = "playlist"
                shuffle = False
            elif media_id.startswith("shuffle_playlist:"):
                name = media_id.replace("shuffle_playlist:", "")
                type_ = "playlist"
                shuffle = True
            elif media_id.startswith("play_album:"):
                name = media_id.replace("play_album:", "")
                type_ = "album"
                shuffle = False
            elif media_id.startswith("shuffle_album:"):
                name = media_id.replace("shuffle_album:", "")
                type_ = "album"
                shuffle = True
            elif media_id.startswith("playlist:"):
                # Direct play of a playlist (fallback if called directly)
                name = media_id.replace("playlist:", "")
                type_ = "playlist"
                shuffle = False
            elif media_id.startswith("album:"):
                name = media_id.replace("album:", "")
                type_ = "album"
                shuffle = False
            elif media_id.startswith("artist:"):
                name = media_id.replace("artist:", "")
                type_ = "artist"
                shuffle = False
            elif media_id.startswith("song:"):
                raw = media_id[len("song:"):]
                name_part = raw
                hints: dict[str, str] = {}
                if "||" in raw:
                    parts = raw.split("||")
                    name_part = parts[0]
                    for kv in parts[1:]:
                        if "=" in kv:
                            k, v = kv.split("=", 1)
                            hints[k.strip()] = v.strip()
                name = name_part
                type_ = "song"
                shuffle = False
                # Optional disambiguation extras
                extra = {}
                if "album" in hints:
                    extra["album"] = hints["album"]
                if "artist" in hints:
                    extra["artist"] = hints["artist"]
                if "playlist" in hints:
                    extra["playlist"] = hints["playlist"]
                if "idx" in hints or "index" in hints:
                    try:
                        extra["index"] = int(hints.get("idx") or hints.get("index"))
                    except Exception:
                        pass
            else:
                return

            async with timeout(10):
                async with self._session.post(
                    f"{self._base_url}/play",
                    json={
                        "type": type_,
                        "name": name,
                        "devices": ",".join(self._selected_devices),
                        "shuffle": shuffle,
                        **(extra if "extra" in locals() else {}),
                    },
                ) as response:
                    status = response.status
                    text = await response.text()
            if status == 200:
                self._state = MediaPlayerState.PLAYING
                self._current_media = media_id
                self.async_write_ha_state()
            else:
                _LOGGER.error("Error playing media: %s", text)
            return
        return

    async def async_set_volume_level(self, volume: float) -> None:
        """Set master volume (0.0–1.0) only."""
        try:
            vol = max(0.0, min(1.0, float(volume)))
        except Exception:
            _LOGGER.error("Invalid volume value: %s", volume)
            return
        level = int(round(vol * 100))
        async with timeout(10):
            async with self._session.post(
                f"{self._base_url}/set_volume", json={"volume": level}
            ) as response:
                if response.status == 200:
                    self._volume_level = vol
                    self.async_write_ha_state()
                    await self._maybe_refresh_device_volumes()
                else:
                    _LOGGER.error("Error setting master volume: %s", await response.text())

    async def _maybe_refresh_device_volumes(self) -> None:
        """Best-effort refresh of per-device sliders; never raises."""
        try:
            if hasattr(self, "async_refresh_device_volumes"):
                await self.async_refresh_device_volumes()
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("refresh_device_volumes failed: %s", e)

    async def async_set_device_volume(self, device: str, level: int) -> None:
        """Set volume for a single AirPlay device (0-100)."""
        level = max(0, min(100, int(level)))
        async with timeout(10):
            async with self._session.post(
                f"{self._base_url}/volume",
                json={"device": device, "level": level},
            ) as resp:
                if resp.status != 200:
                    _LOGGER.error("Error setting device volume for %s: %s", device, await resp.text())
                else:
                    await self._maybe_refresh_device_volumes()
                
    async def async_media_play(self) -> None:
        """Play or resume media.
        First try to resume current playback in Music (and apply selected AirPlay devices),
        then fall back to replaying the last requested media if we have one.
        """
        # 1) Attempt to resume whatever Music was already playing/paused
        payload = {}
        if self._selected_devices:
            payload["devices"] = ",".join(self._selected_devices)
        try:
            async with timeout(10):
                async with self._session.post(f"{self._base_url}/resume", json=payload) as response:
                    if response.status == 200:
                        self._state = MediaPlayerState.PLAYING
                        self.async_write_ha_state()
                        return
                    else:
                        _LOGGER.debug("/resume returned %s: %s", response.status, await response.text())
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("/resume failed: %s", e)

        # 2) Fallback: if we remember a last media target, play it again
        if self._current_media:
            await self.async_play_media(MediaType.MUSIC, self._current_media)
            self._state = MediaPlayerState.PLAYING
            self.async_write_ha_state()
            return

        # 3) Last-resort: do nothing but keep state; user can pick from Browse Media
        _LOGGER.debug("No current media to replay and /resume failed; awaiting user selection")

    async def async_media_pause(self) -> None:
        """Pause media."""
        async with timeout(10):
            async with self._session.post(f"{self._base_url}/pause", json={}) as response:
                if response.status == 200:
                    self._state = MediaPlayerState.PAUSED
                    self.async_write_ha_state()
                else:
                    _LOGGER.error("Error pausing media: %s", await response.text())

    async def async_media_stop(self) -> None:
        """Stop media."""
        async with timeout(10):
            async with self._session.post(f"{self._base_url}/stop", json={}) as response:
                if response.status == 200:
                    self._state = MediaPlayerState.IDLE
                    self._current_media = None
                    self.async_write_ha_state()
                else:
                    _LOGGER.error("Error stopping media: %s", await response.text())

    async def async_media_next_track(self) -> None:
        """Go to next track."""
        async with timeout(10):
            async with self._session.post(f"{self._base_url}/next", json={}) as response:
                if response.status == 200:
                    _LOGGER.debug("Skipped to next track")
                else:
                    _LOGGER.error("Error skipping track: %s", await response.text())

    async def async_media_previous_track(self) -> None:
        """Go to previous track (or restart current)."""
        async with timeout(10):
            async with self._session.post(f"{self._base_url}/previous", json={}) as response:
                if response.status == 200:
                    _LOGGER.debug("Went to previous track / restarted current")
                else:
                    _LOGGER.error("Error going to previous track: %s", await response.text())

    async def async_media_play_pause(self) -> None:
        """Toggle play/pause."""
        if self._state == MediaPlayerState.PLAYING:
            await self.async_media_pause()
        else:
            await self.async_media_play()

    async def async_get_media_image(self) -> tuple[bytes | None, str | None]:
        """Return current album art as (bytes, content_type)."""
        # Some backends lag a moment after track-change; add short retries.
        delays = [0.0, 0.25, 0.5]
        for i, delay in enumerate(delays):
            try:
                if delay:
                    await asyncio.sleep(delay)
                async with timeout(5):
                    async with self._session.get(f"{self._base_url}/artwork") as resp:
                        if resp.status == 200:
                            data = await resp.read()
                            if data:
                                ctype = resp.headers.get("Content-Type", "image/jpeg")
                                # Sanitize to avoid aiohttp's ValueError when charset present in content_type argument
                                if isinstance(ctype, str) and ";" in ctype:
                                    ctype = ctype.split(";", 1)[0].strip()
                                return data, ctype
                        elif resp.status in (404, 425, 503):
                            # likely not ready yet; retry if attempts remain
                            continue
                        else:
                            break
            except Exception as e:  # pragma: no cover
                _LOGGER.debug("async_get_media_image attempt %s error: %s", i + 1, e)
        return None, None
    
    async def async_refresh_device_volumes(self) -> None:
        """Fetch volumes for all devices and push into number entities."""
        vol_map: dict[str, Any] | None = None
        try:
            async with timeout(10):
                async with self._session.get(f"{self._base_url}/device_volumes") as resp:
                    if resp.status == 200:
                        vol_map = await resp.json()
                    else:
                        _LOGGER.debug("device_volumes HTTP %s", resp.status)
                        return
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("async_refresh_device_volumes error: %s", e)
            return
        if not isinstance(vol_map, dict):
            return
        bucket = self.hass.data.get(DOMAIN, {}).get("volume_entities") or {}
        for name, level in vol_map.items():
            ent = bucket.get(name)
            if ent and level is not None and hasattr(ent, "async_apply_backend_value"):
                try:
                    await ent.async_apply_backend_value(level)
                except Exception as e:  # pragma: no cover
                    _LOGGER.debug("apply volume for %s failed: %s", name, e)

    async def async_update(self) -> None:
        """Update the player state."""
        # Fetch core lists and now playing concurrently
        tasks = (
            self._get_json("/playlists"),
            self._get_json("/albums"),
            self._get_json("/artists"),
            self._get_json("/devices"),
            self._get_json("/now_playing"),
            self._get_json("/current_devices"),
        )
        playlists, albums, artists, devices, now, current_devices = await asyncio.gather(*tasks, return_exceptions=True)

        if not isinstance(playlists, Exception) and isinstance(playlists, list):
            self._playlists = playlists
        if not isinstance(albums, Exception) and isinstance(albums, list):
            self._albums = albums
        if not isinstance(artists, Exception) and isinstance(artists, list):
            self._artists = artists
        if not isinstance(devices, Exception) and isinstance(devices, list):
            self._devices = devices

        # Sync currently active AirPlay outputs from the controller
        if not isinstance(current_devices, Exception):
            current_list: list[str] | None = None
            if isinstance(current_devices, list):
                current_list = [str(d) for d in current_devices]
            elif isinstance(current_devices, str):
                current_list = [d.strip() for d in current_devices.split(",") if d.strip()]
            if current_list is not None:
                if self._devices:
                    self._selected_devices = [d for d in current_list if d in self._devices]
                else:
                    self._selected_devices = current_list

        if isinstance(now, Exception) or not isinstance(now, dict):
            now = {}

        # Map player state
        np_state = (now.get("state") or "").lower()
        if np_state == "playing":
            self._state = MediaPlayerState.PLAYING
        elif np_state == "paused":
            self._state = MediaPlayerState.PAUSED
        elif np_state == "stopped":
            self._state = MediaPlayerState.IDLE
        elif np_state:
            # Any other reported state -> coerce sensibly
            self._state = MediaPlayerState.PLAYING if "play" in np_state else MediaPlayerState.IDLE

        # Apply now playing metadata
        title = now.get("title")
        artist = now.get("artist")
        album = now.get("album")
        duration = now.get("duration")
        position = now.get("position")
        volume = now.get("volume")

        self._attr_media_title = title or None
        self._attr_media_artist = artist or None
        self._attr_media_album_name = album or None

        if isinstance(duration, (int, float)):
            self._attr_media_duration = int(duration)
        if isinstance(position, (int, float)):
            self._attr_media_position = float(position)
            self._attr_media_position_updated_at = dt_util.utcnow()
        if isinstance(volume, (int, float)):
            # Music volume is 0-100, HA expects 0.0-1.0
            self._volume_level = max(0.0, min(1.0, float(volume) / 100.0))

        # Update per-device volumes, if server included them; otherwise, throttle-refresh
        try:
            dev_vols = now.get("device_volumes") if isinstance(now, dict) else None
            if isinstance(dev_vols, dict):
                bucket = self.hass.data.get(DOMAIN, {}).get("volume_entities") or {}
                for name, level in dev_vols.items():
                    ent = bucket.get(name)
                    if ent and level is not None and hasattr(ent, "async_apply_backend_value"):
                        await ent.async_apply_backend_value(level)
            else:
                now_mono = time.monotonic()
                if (now_mono - getattr(self, "_last_device_vol_sync", 0.0)) >= 5.0:
                    await self.async_refresh_device_volumes()
                    self._last_device_vol_sync = now_mono
        except Exception as e:  # pragma: no cover
            _LOGGER.debug("device volume sync in async_update failed: %s", e)

        # Bump image hash so HA refreshes artwork when the track changes
        try:
            key = f"{self._attr_media_title or ''}|{self._attr_media_artist or ''}|{self._attr_media_album_name or ''}|{self._attr_media_duration or 0}"
            self._attr_media_image_hash = hashlib.md5(key.encode("utf-8", "ignore")).hexdigest()
        except Exception:  # pragma: no cover
            self._attr_media_image_hash = None
