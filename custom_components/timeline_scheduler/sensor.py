"""Next-change sensor for each schedule subentry."""
from __future__ import annotations

from datetime import datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, SCHEDULE_SUBENTRY_TYPE
from .entity import TimelineScheduleEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create one next-change sensor per schedule subentry."""
    manager = hass.data[DOMAIN]["manager"]
    store = hass.data[DOMAIN]["store"]
    for subentry_id, subentry in entry.subentries.items():
        if subentry.subentry_type != SCHEDULE_SUBENTRY_TYPE:
            continue
        sid = subentry.data["schedule_id"]
        sch = store.get(sid)
        if sch is None:
            continue
        async_add_entities(
            [ScheduleNextChangeSensor(manager, sid, sch.name)],
            config_subentry_id=subentry_id,
        )


class ScheduleNextChangeSensor(TimelineScheduleEntity, SensorEntity):
    """When the schedule next changes value, plus current/next as attributes."""

    _attr_name = "Next change"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:timer-sand"

    def __init__(self, manager, sid: str, name: str) -> None:
        super().__init__(manager, sid, name)
        self._attr_unique_id = f"{sid}_next_change"

    @property
    def native_value(self) -> datetime | None:
        state = self._manager.state.get(self._sid) or {}
        return state.get("next_dt")

    @property
    def extra_state_attributes(self) -> dict:
        state = self._manager.state.get(self._sid) or {}
        return {
            "current_target": state.get("current"),
            "next_target": state.get("next_target"),
            "active_transition_id": state.get("active_id"),
        }
