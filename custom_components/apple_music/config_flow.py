"""Config flow & options for Apple Music Control."""
from __future__ import annotations

import logging
import uuid
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST, default="127.0.0.1"): str,
        vol.Required(CONF_PORT, default=5000): int,
    }
)


class AppleMusicConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Apple Music Control."""

    VERSION = 2  # bump so we can evolve storage semantics later if needed

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Handle the initial step."""
        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=DATA_SCHEMA)

        # Use a stable, random unique_id for the CONFIG ENTRY so changing host/port later
        # doesn't break entity IDs tied to entry_id.
        entry_uuid = f"apple_music_{uuid.uuid4()}"
        await self.async_set_unique_id(entry_uuid)
        self._abort_if_unique_id_configured()

        return self.async_create_entry(title="Apple Music Control", data=user_input)

    @staticmethod
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        return AppleMusicOptionsFlow(config_entry)


class AppleMusicOptionsFlow(config_entries.OptionsFlow):
    """Options flow to allow editing host/port & basic maintenance."""

    def __init__(self, entry: config_entries.ConfigEntry) -> None:
        self._entry = entry

    async def async_step_init(self, user_input=None) -> FlowResult:
        """Show a small menu of common actions."""
        return self.async_show_menu(
            step_id="init",
            menu_options={
                "connection": "Edit connection",
                "reset": "Reset options to defaults",
            },
        )

    async def async_step_connection(self, user_input=None) -> FlowResult:
        current_host = self._entry.options.get(
            CONF_HOST, self._entry.data.get(CONF_HOST, "127.0.0.1")
        )
        current_port = self._entry.options.get(
            CONF_PORT, self._entry.data.get(CONF_PORT, 5000)
        )
        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=current_host): str,
                vol.Required(CONF_PORT, default=current_port): int,
            }
        )
        if user_input is None:
            return self.async_show_form(step_id="connection", data_schema=schema)

        # Save as options so these can be edited later without affecting entry_id
        return self.async_create_entry(title="", data=user_input)

    async def async_step_reset(self, user_input=None) -> FlowResult:
        """Clear options back to defaults (host/port fall back to data)."""
        return self.async_create_entry(title="", data={})