"""Base entity for per-schedule devices."""
from __future__ import annotations

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, schedule_updated_signal
from .manager import TimelineManager


class TimelineScheduleEntity(Entity):
    """Device identity + live-state subscription shared by schedule entities."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, manager: TimelineManager, sid: str, name: str) -> None:
        self._manager = manager
        self._sid = sid
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, sid)},
            name=name,
            manufacturer="Timeline Scheduler",
            model="Schedule",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, schedule_updated_signal(self._sid), self._handle_update
            )
        )

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()
