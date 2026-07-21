"""Persistence for schedules via Home Assistant's Store helper."""
from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION
from .models import Schedule


class ScheduleStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._schedules: dict[str, Schedule] = {}

    async def async_load(self) -> dict[str, Schedule]:
        data = await self._store.async_load()
        items = (data or {}).get("schedules", [])
        self._schedules = {s["id"]: Schedule.from_dict(s) for s in items}
        return self._schedules

    async def _async_persist(self) -> None:
        await self._store.async_save(
            {"schedules": [s.to_dict() for s in self._schedules.values()]})

    def list(self) -> list[Schedule]:
        return list(self._schedules.values())

    def get(self, sid: str) -> Schedule | None:
        return self._schedules.get(sid)

    async def async_upsert(self, schedule: Schedule) -> None:
        self._schedules[schedule.id] = schedule
        await self._async_persist()

    async def async_remove(self, sid: str) -> None:
        self._schedules.pop(sid, None)
        await self._async_persist()
