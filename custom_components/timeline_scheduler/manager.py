"""Runtime engine: applies scheduled values and arms timers."""
from __future__ import annotations

import logging
from datetime import time

from homeassistant.core import HassJob, HomeAssistant, callback
from homeassistant.helpers.event import (
    async_track_point_in_time,
    async_track_state_change_event,
    async_track_time_change,
)
from homeassistant.util import dt as dt_util

from .actions import build_service_call
from .resolver import active_and_next
from .store import ScheduleStore

_LOGGER = logging.getLogger(__name__)


class TimelineManager:
    def __init__(self, hass: HomeAssistant, store: ScheduleStore) -> None:
        self.hass = hass
        self.store = store
        self._watchers: dict[str, list] = {}   # sid -> cancel callbacks (anchors)
        self._timers: dict[str, callable] = {}  # sid -> cancel callback (next timer)
        self._global: list = []

    def _anchor_lookup(self, entity_id: str) -> time | None:
        st = self.hass.states.get(entity_id)
        if st is None or st.state in ("unknown", "unavailable", ""):
            return None
        parsed = dt_util.parse_time(st.state)
        if parsed is not None:
            return parsed
        as_dt = dt_util.parse_datetime(st.state)
        if as_dt is not None:
            return dt_util.as_local(as_dt).time()
        return None

    async def async_start(self) -> None:
        self._global.append(
            async_track_time_change(self.hass, self._handle_midnight,
                                    hour=0, minute=0, second=5))
        for sch in self.store.list():
            await self.async_setup_schedule(sch)

    @callback
    def _handle_midnight(self, _now) -> None:
        for sch in self.store.list():
            self.hass.async_create_task(self.async_refresh(sch.id))

    async def async_setup_schedule(self, schedule) -> None:
        await self.async_teardown(schedule.id)
        if not schedule.enabled:
            return
        anchors = sorted({t.when.entity for t in schedule.transitions
                          if t.when.type == "anchor" and t.when.entity})
        if anchors:
            self._watchers[schedule.id] = [async_track_state_change_event(
                self.hass, anchors, self._make_anchor_handler(schedule.id))]
        await self.async_refresh(schedule.id)

    def _make_anchor_handler(self, sid: str):
        @callback
        def _handler(_event) -> None:
            self.hass.async_create_task(self.async_refresh(sid))
        return _handler

    async def async_refresh(self, sid: str) -> None:
        schedule = self.store.get(sid)
        if schedule is None or not schedule.enabled:
            return
        now = dt_util.now()
        active, nxt = active_and_next(schedule, now, self._anchor_lookup)
        if active is not None and active.transition.value is not None:
            domain, service, data = build_service_call(
                schedule.apply, active.transition.value, schedule.target)
            await self.hass.services.async_call(domain, service, data, blocking=False)
        self._cancel_timer(sid)
        if nxt is not None:
            job = HassJob(
                self._make_timer_handler(sid),
                f"timeline_scheduler timer {sid}",
                cancel_on_shutdown=True,
            )
            self._timers[sid] = async_track_point_in_time(
                self.hass, job, nxt.when_dt)

    def _make_timer_handler(self, sid: str):
        @callback
        def _handler(_now) -> None:
            self.hass.async_create_task(self.async_refresh(sid))
        return _handler

    def _cancel_timer(self, sid: str) -> None:
        cancel = self._timers.pop(sid, None)
        if cancel is not None:
            cancel()

    async def async_teardown(self, sid: str) -> None:
        self._cancel_timer(sid)
        for cancel in self._watchers.pop(sid, []):
            cancel()
