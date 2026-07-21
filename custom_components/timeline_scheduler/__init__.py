"""Timeline Scheduler — setpoint/value schedules as a timeline of transitions."""
from __future__ import annotations

import logging
import os

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .manager import TimelineManager
from .services import async_register_services
from .store import ScheduleStore
from .websocket_api import async_register_ws

_LOGGER = logging.getLogger(__name__)

CARD_URL = "/timeline_scheduler/timeline-scheduler-card.js"
CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "timeline-scheduler-card.js")

# Marks the process-wide, one-time registration (services, websocket API, card).
# Survives config-entry reloads so we never double-register the static path.
DATA_PLATFORM_REGISTERED = "timeline_scheduler_platform_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Timeline Scheduler from its config entry."""
    store = ScheduleStore(hass)
    await store.async_load()
    manager = TimelineManager(hass, store)
    hass.data[DOMAIN] = {"store": store, "manager": manager}

    await _async_register_platform(hass)
    await manager.async_start()

    async def _handle_stop(_event) -> None:
        await manager.async_stop()

    entry.async_on_unload(
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _handle_stop)
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down the runtime.

    Services / websocket commands / the card static path are process-wide and
    stay registered (the static path cannot be unregistered); only the store
    and manager are per-entry runtime, so those are what we stop here.
    """
    data = hass.data.pop(DOMAIN, None)
    if data is not None:
        await data["manager"].async_stop()
    return True


async def _async_register_platform(hass: HomeAssistant) -> None:
    """Register services, the websocket API, and the frontend card exactly once."""
    if hass.data.get(DATA_PLATFORM_REGISTERED):
        return
    hass.data[DATA_PLATFORM_REGISTERED] = True
    async_register_services(hass)
    async_register_ws(hass)
    if not os.path.exists(CARD_PATH):
        return
    if hass.http is not None:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, CARD_PATH, False)]
        )
        add_extra_js_url(hass, CARD_URL)
    else:
        _LOGGER.warning(
            "Timeline Scheduler card found but hass.http is unavailable; card not served"
        )
