from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.manager import TimelineManager
from custom_components.timeline_scheduler.models import Schedule
from custom_components.timeline_scheduler.store import ScheduleStore

TZ = ZoneInfo("America/New_York")


def _bed():
    return Schedule.from_dict({
        "id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
        "apply": "climate_temperature", "transitions": [
            {"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80},
            {"id": "b", "when": {"type": "time", "at": "22:00"}, "value": 70}]})


async def _make(hass, schedule):
    await hass.config.async_set_time_zone("America/New_York")
    store = ScheduleStore(hass)
    await store.async_load()
    await store.async_upsert(schedule)
    return TimelineManager(hass, store)


async def test_applies_current_value_on_refresh(hass):
    calls = async_mock_service(hass, "climate", "set_temperature")
    mgr = await _make(hass, _bed())
    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        await mgr.async_refresh("bed")
        await hass.async_block_till_done()
    assert len(calls) == 1
    assert calls[0].data["temperature"] == 80.0
    # Cancel armed next-transition timer so HA test harness does not report
    # a lingering timer (reference omitted this; minimal fix added here).
    await mgr.async_teardown("bed")


async def test_anchor_change_triggers_reapply(hass):
    calls = async_mock_service(hass, "climate", "set_temperature")
    sch = Schedule.from_dict({
        "id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
        "apply": "climate_temperature", "transitions": [
            {"id": "pre", "when": {"type": "anchor",
             "entity": "input_datetime.wakeup_time", "offset": "-00:30"}, "value": 95}]})
    mgr = await _make(hass, sch)
    with freeze_time(datetime(2026, 1, 5, 6, 15, tzinfo=TZ)):
        hass.states.async_set("input_datetime.wakeup_time", "06:30:00")
        await mgr.async_setup_schedule(sch)
        await hass.async_block_till_done()
    assert len(calls) == 1 and calls[0].data["temperature"] == 95.0
    # Cancel armed watchers/timers so HA test harness does not report lingering
    # resources (reference omitted this; minimal fix added here).
    await mgr.async_teardown("bed")
