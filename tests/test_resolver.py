from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from custom_components.timeline_scheduler.models import Schedule
from custom_components.timeline_scheduler.resolver import active_and_next, resolve_day

TZ = ZoneInfo("America/New_York")


def _sched(transitions):
    return Schedule.from_dict({
        "id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
        "apply": "climate_temperature", "transitions": transitions})


def _no_anchor(_entity):
    return None


def test_absolute_active_and_next():
    sch = _sched([
        {"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80},
        {"id": "b", "when": {"type": "time", "at": "22:00"}, "value": 70},
    ])
    now = datetime(2026, 1, 5, 21, 0, tzinfo=TZ)  # between the two
    active, nxt = active_and_next(sch, now, _no_anchor)
    assert active.transition.id == "a" and active.transition.value == 80
    assert nxt.transition.id == "b"


def test_value_carries_over_midnight():
    sch = _sched([
        {"id": "night", "when": {"type": "time", "at": "20:00"}, "value": 80},
        {"id": "morning", "when": {"type": "time", "at": "06:00"}, "value": 90},
    ])
    now = datetime(2026, 1, 6, 1, 0, tzinfo=TZ)  # 1am -> still yesterday's 20:00 value
    active, nxt = active_and_next(sch, now, _no_anchor)
    assert active.transition.id == "night"
    assert nxt.transition.id == "morning"


def test_anchor_relative_resolves_from_lookup():
    sch = _sched([
        {"id": "pre", "when": {"type": "anchor", "entity": "input_datetime.wakeup_time",
         "offset": "-00:30"}, "value": 95},
    ])
    now = datetime(2026, 1, 5, 6, 15, tzinfo=TZ)  # alarm 06:30 -> pre fires 06:00
    active, nxt = active_and_next(sch, now, lambda e: time(6, 30))
    assert active.transition.id == "pre"


def test_weekday_filter_skips_off_days():
    # 2026-01-05 is a Monday
    sch = _sched([
        {"id": "wk", "when": {"type": "time", "at": "08:00"}, "value": 5,
         "weekdays": ["sat", "sun"]},
    ])
    now = datetime(2026, 1, 5, 9, 0, tzinfo=TZ)  # Monday, not in weekdays
    active, nxt = active_and_next(sch, now, _no_anchor)
    assert active is None


def test_missing_anchor_is_skipped():
    sch = _sched([
        {"id": "pre", "when": {"type": "anchor", "entity": "input_datetime.wakeup_time",
         "offset": "-00:30"}, "value": 95},
    ])
    now = datetime(2026, 1, 5, 8, 0, tzinfo=TZ)
    active, nxt = active_and_next(sch, now, _no_anchor)  # anchor unknown
    assert active is None and nxt is None


def test_weekday_only_no_carryover_next_day():
    # Sat/Sun only; now is Monday 01:00 — must NOT carry Sunday's value into Monday
    sch = _sched([
        {"id": "wk", "when": {"type": "time", "at": "22:00"}, "value": 5,
         "weekdays": ["sat", "sun"]},
    ])
    now = datetime(2026, 1, 5, 1, 0, tzinfo=TZ)  # Monday 01:00
    active, nxt = active_and_next(sch, now, _no_anchor)
    assert active is None


def test_resolve_day_absolute_sorted():
    sch = _sched([
        {"id": "b", "when": {"type": "time", "at": "22:00"}, "value": 70},
        {"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80},
    ])
    items = resolve_day(sch, date(2026, 1, 5), TZ, _no_anchor)
    assert [i["transition_id"] for i in items] == ["a", "b"]
    assert items[0]["value"] == 80
    assert items[0]["time"].startswith("2026-01-05T20:00:00")


def test_resolve_day_weekday_filter_and_anchor():
    # 2026-01-05 is Monday
    sch = _sched([
        {"id": "wk", "when": {"type": "time", "at": "08:00"}, "value": 5,
         "weekdays": ["sat", "sun"]},
        {"id": "an", "when": {"type": "anchor", "entity": "input_datetime.wakeup_time",
         "offset": "-00:30"}, "value": 95},
    ])
    items = resolve_day(sch, date(2026, 1, 5), TZ, lambda e: __import__("datetime").time(6, 30))
    assert [i["transition_id"] for i in items] == ["an"]  # "wk" filtered out (Mon not in sat/sun)
    assert items[0]["time"].startswith("2026-01-05T06:00:00")


def test_resolve_day_skips_unresolvable_anchor():
    sch = _sched([
        {"id": "an", "when": {"type": "anchor", "entity": "input_datetime.wakeup_time",
         "offset": "-00:30"}, "value": 95},
    ])
    assert resolve_day(sch, date(2026, 1, 5), TZ, _no_anchor) == []
