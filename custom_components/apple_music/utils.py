"""Utility functions for Apple Music integration."""
import re
from typing import Any
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.core import HomeAssistant
import asyncio
from async_timeout import timeout


def _sanitize(name: str | None) -> str:
    """Sanitize a name for use in filenames."""
    if not name:
        return "current"
    s = str(name)
    s = re.sub(r'[\\/:*?"<>|\x00-\x1F]', '-', s)
    s = s.replace(',', '')
    s = "_".join(p for p in s.strip().split())
    s = re.sub(r'[-_]{2,}', '_', s)
    return s[:120] if len(s) > 120 else (s or "current")


async def _get_json(hass: HomeAssistant, base_url: str, path: str) -> Any:
    """GET JSON from the backend with a 10s timeout."""
    session = async_get_clientsession(hass)
    async with timeout(10):
        async with session.get(f"{base_url}{path}") as resp:
            resp.raise_for_status()
            return await resp.json()
