"""Per-schedule sensors: next-change time, current value, next value."""
from __future__ import annotations

from datetime import datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.typing import StateType

from .actions import format_display
from .const import DOMAIN, SCHEDULE_SUBENTRY_TYPE
from .entity import TimelineScheduleEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create the sensor set for each schedule subentry."""
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
            [
                ScheduleNextChangeSensor(manager, sid, sch.name),
                ScheduleCurrentSensor(manager, sid, sch.name),
                ScheduleNextSensor(manager, sid, sch.name),
            ],
            config_subentry_id=subentry_id,
        )


class ScheduleNextChangeSensor(TimelineScheduleEntity, SensorEntity):
    """When the schedule next changes value."""

    _attr_name = "Next change"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:timer-sand"

    def __init__(self, manager, sid: str, name: str) -> None:
        super().__init__(manager, sid, name)
        self._attr_unique_id = f"{sid}_next_change"

    @property
    def available(self) -> bool:
        return self._manager.store.get(self._sid) is not None

    @property
    def native_value(self) -> datetime | None:
        state = self._manager.state.get(self._sid) or {}
        return state.get("next_dt")

    @property
    def extra_state_attributes(self) -> dict:
        return {"active_transition_id": (self._manager.state.get(self._sid) or {}).get("active_id")}


class _ScheduleValueSensor(TimelineScheduleEntity, SensorEntity):
    """A schedule value rendered as a compact string (e.g. ``heat 72°``, ``on``)."""

    _state_key = ""

    @property
    def available(self) -> bool:
        return self._manager.store.get(self._sid) is not None

    @property
    def native_value(self) -> StateType:
        value = (self._manager.state.get(self._sid) or {}).get(self._state_key)
        schedule = self._manager.store.get(self._sid)
        return format_display(schedule.apply if schedule else "", value)


class ScheduleCurrentSensor(_ScheduleValueSensor):
    """The value the schedule is currently holding."""

    _attr_name = "Current"
    _attr_icon = "mdi:target"
    _state_key = "current"

    def __init__(self, manager, sid: str, name: str) -> None:
        super().__init__(manager, sid, name)
        self._attr_unique_id = f"{sid}_current"


class ScheduleNextSensor(_ScheduleValueSensor):
    """The value the schedule will change to next."""

    _attr_name = "Next"
    _attr_icon = "mdi:target-variant"
    _state_key = "next_target"

    def __init__(self, manager, sid: str, name: str) -> None:
        super().__init__(manager, sid, name)
        self._attr_unique_id = f"{sid}_next"
