from __future__ import annotations

import logging
from typing import Any, Callable

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers import entity_registry as er
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
    """Set up dynamic AirPlay device switches."""
    # Keep a map of device_name -> entity
    devices: dict[str, AppleMusicAirPlaySwitch] = {}

    @callback
    def add_missing_from_attr(device_list: list[str]) -> None:
        new = []
        for name in device_list or []:
            if name not in devices:
                ent = AppleMusicAirPlaySwitch(hass, name)
                devices[name] = ent
                new.append(ent)
        if new:
            _LOGGER.debug("Adding %d AirPlay device switches: %s", len(new), [e.name for e in new])
            async_add_entities(new)

    @callback
    def mark_availability(device_list: list[str]) -> None:
        current = set(device_list or [])
        for name, ent in devices.items():
            ent._available = name in current  # noqa: SLF001
            # Only write state after HA has assigned an entity_id
            if getattr(ent, "entity_id", None):
                ent.async_write_ha_state()

    @callback
    def _on_devices(names: list[str]) -> None:
        add_missing_from_attr(names)
        mark_availability(names)

    # Subscribe to async_dispatcher signal sent by the integration when /devices updates
    unsub = async_dispatcher_connect(hass, SIGNAL_AIRPLAY_DEVICES, _on_devices)
    entry.async_on_unload(unsub)

    # Seed from current media_player attributes if available
    player_eid = _player_entity_id(hass)
    state = hass.states.get(player_eid)
    if state:
        avail = state.attributes.get("available_devices") or []
        add_missing_from_attr(avail)
        mark_availability(avail)

    # Listen for changes on the media player to add/remove/mark availability dynamically
    @callback
    def _player_state_changed(event) -> None:
        new_state = event.data.get("new_state")
        if not new_state:
            return
        avail = new_state.attributes.get("available_devices") or []
        add_missing_from_attr(avail)
        mark_availability(avail)
        # also update on/off per switch based on selected_devices
        selected = new_state.attributes.get("selected_devices") or []
        for name, ent in devices.items():
            ent._is_on = name in selected  # noqa: SLF001
            if getattr(ent, "entity_id", None):
                ent.async_write_ha_state()

    async_track_state_change_event(hass, [player_eid], _player_state_changed)


class AppleMusicAirPlaySwitch(SwitchEntity):
    """A switch representing an AirPlay output (selected/unselected) for Apple Music."""

    _attr_has_entity_name = False

    def __init__(self, hass: HomeAssistant, device_name: str) -> None:
        self.hass = hass
        self._device_name = device_name
        self._available = True
        self._is_on = False
        # Stable registry identity and device attachment
        self._attr_unique_id = f"{DOMAIN}_airplay_{self._device_name}"
        self._attr_name = _pretty_name(self._device_name)
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
    def is_on(self) -> bool:
        return self._is_on

    @property
    def suggested_object_id(self) -> str:
        # Force a stable, unique object_id prefix for this addon
        return f"music_control_{slugify(self._device_name)}"

    @callback
    def _current_lists(self) -> tuple[list[str], list[str]]:
        """Read available/selected lists from the media player entity state."""
        st = self.hass.states.get(_player_entity_id(self.hass))
        if not st:
            return [], []
        available = st.attributes.get("available_devices") or []
        selected = st.attributes.get("selected_devices") or []
        return list(available), list(selected)

    async def async_turn_on(self, **kwargs: Any) -> None:
        available, selected = self._current_lists()
        # only add if actually available
        if self._device_name not in available:
            _LOGGER.debug("Device %s not in available list; cannot turn on", self._device_name)
            return
        if self._device_name not in selected:
            selected = [*selected, self._device_name]
        await self._apply_selection(selected)

    async def async_turn_off(self, **kwargs: Any) -> None:
        _available, selected = self._current_lists()
        if self._device_name in selected:
            selected = [d for d in selected if d != self._device_name]
        await self._apply_selection(selected)

    async def _apply_selection(self, devices: list[str]) -> None:
        # Call the domain-level service so this works regardless of platform load order
        await self.hass.services.async_call(
            DOMAIN,
            "set_selected_airplay_devices",
            {"entity_id": _player_entity_id(self.hass), "devices": devices},
            blocking=True,
        )
        # Optimistically update local state; it will be confirmed on next media_player update
        self._is_on = self._device_name in devices
        self.async_write_ha_state()

    async def async_update(self) -> None:
        # Keep in sync with the media player’s attributes
        available, selected = self._current_lists()
        self._available = self._device_name in available
        self._is_on = self._device_name in selected
