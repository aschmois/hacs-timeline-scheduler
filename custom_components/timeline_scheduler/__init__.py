"""Timeline Scheduler — setpoint/value schedules as a timeline of transitions."""
from __future__ import annotations

import logging
import os

_LOGGER = logging.getLogger(__name__)

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .manager import TimelineManager
from .services import async_register_services
from .store import ScheduleStore
from .websocket_api import async_register_ws

CARD_URL = "/timeline_scheduler/timeline-scheduler-card.js"
CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "timeline-scheduler-card.js")


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    store = ScheduleStore(hass)
    await store.async_load()
    manager = TimelineManager(hass, store)
    hass.data[DOMAIN] = {"store": store, "manager": manager}
    async_register_services(hass)
    async_register_ws(hass)
    if os.path.exists(CARD_PATH):
        if hass.http is not None:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(CARD_URL, CARD_PATH, False)]
            )
            add_extra_js_url(hass, CARD_URL)
        else:
            _LOGGER.warning(
                "Timeline Scheduler card found but hass.http is unavailable; card not served"
            )
    await manager.async_start()

    async def _handle_stop(_event) -> None:
        await manager.async_stop()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _handle_stop)
    return True
