"""Enable/disable switch for each schedule subentry."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
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
    """Create one enable switch per schedule subentry."""
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
            [ScheduleEnableSwitch(manager, sid, sch.name)],
            config_subentry_id=subentry_id,
        )


class ScheduleEnableSwitch(TimelineScheduleEntity, SwitchEntity):
    """Turns a schedule on/off (mirrors and drives Schedule.enabled)."""

    _attr_name = None  # main entity of the schedule device
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, manager, sid: str, name: str) -> None:
        super().__init__(manager, sid, name)
        self._attr_unique_id = f"{sid}_enabled"

    @property
    def is_on(self) -> bool:
        sch = self._manager.store.get(self._sid)
        return bool(sch and sch.enabled)

    @property
    def available(self) -> bool:
        return self._manager.store.get(self._sid) is not None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._set_enabled(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set_enabled(False)

    async def _set_enabled(self, enabled: bool) -> None:
        sch = self._manager.store.get(self._sid)
        if sch is None or sch.enabled == enabled:
            return
        sch.enabled = enabled
        await self._manager.store.async_upsert(sch)
        # Re-arm (or tear down) the engine for this schedule; that dispatches a
        # state update, and we also write our own state immediately.
        await self._manager.async_setup_schedule(sch)
        self.async_write_ha_state()
