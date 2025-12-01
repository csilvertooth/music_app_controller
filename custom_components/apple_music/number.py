from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.util import slugify

# Import the signal name if available; otherwise fall back to the literal used by __init__.py
try:
    from .const import SIGNAL_AIRPLAY_DEVICES  # type: ignore
except Exception:  # pragma: no cover
    SIGNAL_AIRPLAY_DEVICES = "apple_music_airplay_devices"

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

def _player_entity_id(hass: HomeAssistant) -> str:
    """Resolve the media_player entity_id for this integration.
    Prefer the standardized music_control_player, fall back to apple_music_player.
    """
    try:
        states = hass.states
        if states.get("media_player.music_control_player") is not None:
            return "media_player.music_control_player"
    except Exception:
        pass
    return "media_player.apple_music_player"


def _pretty_name(raw: str) -> str:
    """Human-friendly name from device id like 'office_homepod' -> 'Office HomePod'."""
    s = str(raw).replace("_", " ").replace("-", " ")
    s = " ".join(s.split())  # collapse whitespace
    titled = s.title()
    # Fix common brand/case words after title-casing
    fixes = {
        "Homepod": "HomePod",
        "Airplay": "AirPlay",
        "Tv": "TV",
        "Hdmi": "HDMI",
        "Usb": "USB",
        "Wifi": "WiFi",
        "Av": "AV",
        "Mac Mini": "Mac mini",
    }
    for k, v in fixes.items():
        titled = titled.replace(k, v)
    return titled


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up dynamic AirPlay per-device volume numbers."""
    devices: dict[str, AppleMusicAirPlayVolume] = {}

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["volume_entities"] = devices

    @callback
    def _add_missing(device_list: list[str]) -> None:
        new = []
        for name in device_list or []:
            if name not in devices:
                ent = AppleMusicAirPlayVolume(hass, name)
                devices[name] = ent
                hass.data[DOMAIN]["volume_entities"][name] = ent
                new.append(ent)
        if new:
            _LOGGER.debug("Adding %d AirPlay volume sliders: %s", len(new), [e.name for e in new])
            async_add_entities(new)

    @callback
    def _mark_availability(device_list: list[str]) -> None:
        current = set(device_list or [])
        for name, ent in devices.items():
            ent._available = name in current  # noqa: SLF001
            # Only write state after HA has assigned an entity_id
            if getattr(ent, "entity_id", None):
                ent.async_write_ha_state()

    @callback
    def _on_devices(names: list[str]) -> None:
        _add_missing(names)
        _mark_availability(names)

    # Subscribe to async_dispatcher signal sent by the integration when /devices updates
    unsub = async_dispatcher_connect(hass, SIGNAL_AIRPLAY_DEVICES, _on_devices)
    entry.async_on_unload(unsub)

    # Seed from current media_player attributes
    player_eid = _player_entity_id(hass)
    st = hass.states.get(player_eid)
    if st:
        avail = st.attributes.get("available_devices") or []
        _add_missing(avail)
        _mark_availability(avail)

    @callback
    def _player_state_changed(event) -> None:
        new_state = event.data.get("new_state")
        if not new_state:
            return
        avail = new_state.attributes.get("available_devices") or []
        _add_missing(avail)
        _mark_availability(avail)

    async_track_state_change_event(hass, [player_eid], _player_state_changed)


class AppleMusicAirPlayVolume(NumberEntity):
    """A number entity representing volume for a single AirPlay device."""

    _attr_has_entity_name = False
    _attr_native_min_value = 0
    _attr_native_max_value = 100
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, hass: HomeAssistant, device_name: str) -> None:
        self.hass = hass
        self._device_name = device_name
        self._available = True
        self._value: float | None = None  # we don't have a read API; optimistic updates
        self._attr_unique_id = f"{DOMAIN}_vol_{device_name}"
        self._attr_name = f"{_pretty_name(device_name)} Volume"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, "server")},
            name="Music Controller",
            manufacturer="Apple",
            model="Music + AirPlay",
        )

    @property
    def available(self) -> bool:
        return self._available

    @property
    def native_value(self) -> float | None:
        return self._value

    @property
    def suggested_object_id(self) -> str:
        # Force a stable, unique object_id prefix for this addon
        return f"music_control_{slugify(self._device_name)}_volume"

    async def async_apply_backend_value(self, level: int) -> None:
        lvl = max(0, min(100, int(level)))
        self._value = float(lvl)
        self.async_write_ha_state()

    async def async_set_native_value(self, value: float) -> None:
        level = max(0, min(100, int(round(float(value)))))
        await self.hass.services.async_call(
            DOMAIN,
            "set_device_volume",
            {"entity_id": _player_entity_id(self.hass), "device": self._device_name, "level": level},
            blocking=True,
        )
        # Optimistically store; HA has no read API for per-device volume
        self._value = float(level)
        self.async_write_ha_state()
