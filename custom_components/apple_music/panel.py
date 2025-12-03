import os
import logging
from homeassistant.components import frontend
from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig

_LOGGER = logging.getLogger(__name__)

# Adjust these if you rename things
DOMAIN = "apple_music_controller"
FRONTEND_URL_PATH = "music-app-controller"              # URL shown in sidebar (/music-app-controller)
WEB_COMPONENT_NAME = "music-controller-panel"           # must match customElements.define(...)
PANEL_TITLE = "Music Controller"
PANEL_ICON = "mdi:apple"

# Where the JS lives on disk and how HA will serve it
# File expected at: custom_components/apple_music/frontend/dist/music-controller-panel.js
PANEL_URL = f"/{DOMAIN}-panel/music-controller-panel.js"   # public URL (unique path)

async def async_register_panel(hass):
    root_dir = hass.config.path("custom_components", DOMAIN, "frontend", "dist")
    js_file = os.path.join(root_dir, "music-controller-panel.js")

    await hass.http.async_register_static_paths(
        [StaticPathConfig(PANEL_URL, js_file, cache_headers=False)]
    )

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=WEB_COMPONENT_NAME,      # MUST match your JS
        frontend_url_path=FRONTEND_URL_PATH,       # Sidebar route (/music-app-controller)
        module_url=PANEL_URL,                      # Where HA will load the JS from
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=False,                       # set True if you want admin only
        config={},
    )
    _LOGGER.debug("Registered panel %s at /%s (module: %s)", WEB_COMPONENT_NAME, FRONTEND_URL_PATH, PANEL_URL)

def async_unregister_panel(hass):
    frontend.async_remove_panel(hass, FRONTEND_URL_PATH)
    _LOGGER.debug("Removed panel at /%s", FRONTEND_URL_PATH)
