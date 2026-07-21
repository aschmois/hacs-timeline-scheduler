"""Timeline Scheduler — setpoint/value schedules as a timeline of transitions."""
from __future__ import annotations

from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .manager import TimelineManager
from .services import async_register_services
from .store import ScheduleStore


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    store = ScheduleStore(hass)
    await store.async_load()
    manager = TimelineManager(hass, store)
    hass.data[DOMAIN] = {"store": store, "manager": manager}
    async_register_services(hass)
    await manager.async_start()

    async def _handle_stop(_event) -> None:
        await manager.async_stop()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _handle_stop)
    return True
