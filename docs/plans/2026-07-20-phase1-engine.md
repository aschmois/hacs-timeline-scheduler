# Timeline Scheduler — Phase 1 (Headless Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Home Assistant custom integration that runs setpoint/value schedules modeled as a timeline of transitions (absolute or anchor-relative times) and applies each value to a target entity at the right moment.

**Architecture:** A pure-Python core (models → time parsing → transition resolver → action mappings) with no HA dependency, wrapped by HA glue (persistent store → async runtime manager → services). The runtime computes the currently-active transition on start/edit/anchor-change/midnight and schedules a single timer for the next one. Observability entities (`sensor.*`) and the WebSocket CRUD API are **out of scope for this plan** (next plan).

**Tech Stack:** Python 3.13+, Home Assistant, `homeassistant.helpers.storage.Store`, `homeassistant.helpers.event`, pytest, `pytest-homeassistant-custom-component`, `freezegun`.

## Global Constraints

- Integration domain: `timeline_scheduler` (exact).
- Storage: HA `Store`, key `timeline_scheduler`, version `1` (`.storage/timeline_scheduler`).
- Action mappings are exactly: `switch_onoff`, `climate_temperature`, `climate_hvac_mode`, `number_set` (see Task 4).
- Weekday keys are lowercase 3-letter: `mon tue wed thu fri sat sun` (Monday = index 0).
- **Public repo — no personal info:** all tests/examples use generic IDs (`climate.bed`, `input_datetime.wakeup_time`); never real names, emails, or real device IDs. Commit as `aschmois <aschmois@users.noreply.github.com>`.
- Out of scope (do not build): point-event/feeder schedules; `sensor` entities; WebSocket API; the Lovelace card.
- License: MIT, copyright holder `aschmois`.

---

## File Structure

Pure core (no HA imports — unit-testable with plain pytest):
- `custom_components/timeline_scheduler/models.py` — `When`, `Transition`, `Schedule` dataclasses + `from_dict`/`to_dict`.
- `custom_components/timeline_scheduler/timeparse.py` — `parse_hhmm`, `parse_offset`.
- `custom_components/timeline_scheduler/resolver.py` — `ResolvedTransition`, `active_and_next`.
- `custom_components/timeline_scheduler/actions.py` — `build_service_call`.

HA glue:
- `custom_components/timeline_scheduler/store.py` — `ScheduleStore` (persistence).
- `custom_components/timeline_scheduler/manager.py` — `TimelineManager` (runtime engine).
- `custom_components/timeline_scheduler/services.py` — service registration.
- `custom_components/timeline_scheduler/services.yaml` — service UI descriptions.
- `custom_components/timeline_scheduler/__init__.py` — `async_setup` wiring (replaces current stub).

Tests: `tests/` mirrors the module layout.

---

### Task 1: Test scaffolding + data models

**Files:**
- Create: `requirements-test.txt`
- Create: `pyproject.toml`
- Create: `tests/__init__.py`, `tests/conftest.py`
- Create: `custom_components/timeline_scheduler/models.py`
- Test: `tests/test_models.py`

**Interfaces:**
- Produces: `models.WEEKDAYS: list[str]`; `models.When(type, at=None, entity=None, offset=None)`; `models.Transition(id, when, value, weekdays)`; `models.Schedule(id, name, target, apply, transitions, enabled=True, default=None)`; each with classmethod `from_dict(d)` and method `to_dict()`.

- [ ] **Step 1: Create test dependencies and pytest config**

`requirements-test.txt`:
```
pytest>=8
pytest-asyncio>=0.23
pytest-homeassistant-custom-component
freezegun>=1.5
```

`pyproject.toml`:
```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

`tests/__init__.py`: (empty file)

`tests/conftest.py`:
```python
"""Shared test fixtures."""
import pytest


@pytest.fixture(autouse=True)
def _enable_custom_integrations(enable_custom_integrations):
    """Allow HA to load the custom integration in tests."""
    yield
```

- [ ] **Step 2: Write the failing test**

`tests/test_models.py`:
```python
from custom_components.timeline_scheduler.models import Schedule, WEEKDAYS

RAW = {
    "id": "bed",
    "name": "Bed",
    "enabled": True,
    "target": {"entity_id": "climate.bed"},
    "apply": "climate_temperature",
    "default": {"value": None},
    "transitions": [
        {"id": "t1", "when": {"type": "time", "at": "20:00"}, "value": 80,
         "weekdays": ["mon", "tue"]},
        {"id": "t2", "when": {"type": "anchor", "entity": "input_datetime.wakeup_time",
         "offset": "-00:30"}, "value": 95},
    ],
}


def test_schedule_round_trips():
    sch = Schedule.from_dict(RAW)
    assert sch.id == "bed"
    assert sch.transitions[0].when.at == "20:00"
    assert sch.transitions[1].when.entity == "input_datetime.wakeup_time"
    assert sch.to_dict() == RAW


def test_transition_defaults_to_all_weekdays():
    sch = Schedule.from_dict({**RAW, "transitions": [
        {"id": "t1", "when": {"type": "time", "at": "06:00"}, "value": 1}]})
    assert sch.transitions[0].weekdays == WEEKDAYS
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: custom_components.timeline_scheduler.models`

- [ ] **Step 4: Implement `models.py`**

```python
"""Data models for Timeline Scheduler."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


@dataclass
class When:
    type: str  # "time" | "anchor"
    at: str | None = None
    entity: str | None = None
    offset: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> "When":
        return cls(type=d["type"], at=d.get("at"),
                   entity=d.get("entity"), offset=d.get("offset"))

    def to_dict(self) -> dict:
        if self.type == "time":
            return {"type": "time", "at": self.at}
        return {"type": "anchor", "entity": self.entity, "offset": self.offset}


@dataclass
class Transition:
    id: str
    when: When
    value: Any
    weekdays: list[str] = field(default_factory=lambda: list(WEEKDAYS))

    @classmethod
    def from_dict(cls, d: dict) -> "Transition":
        return cls(id=d["id"], when=When.from_dict(d["when"]),
                   value=d["value"], weekdays=d.get("weekdays") or list(WEEKDAYS))

    def to_dict(self) -> dict:
        return {"id": self.id, "when": self.when.to_dict(),
                "value": self.value, "weekdays": self.weekdays}


@dataclass
class Schedule:
    id: str
    name: str
    target: dict
    apply: str
    transitions: list[Transition]
    enabled: bool = True
    default: dict | None = None

    @classmethod
    def from_dict(cls, d: dict) -> "Schedule":
        return cls(
            id=d["id"], name=d.get("name", d["id"]), target=d["target"],
            apply=d["apply"], enabled=d.get("enabled", True),
            default=d.get("default"),
            transitions=[Transition.from_dict(t) for t in d.get("transitions", [])],
        )

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "enabled": self.enabled,
                "target": self.target, "apply": self.apply, "default": self.default,
                "transitions": [t.to_dict() for t in self.transitions]}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/test_models.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add requirements-test.txt pyproject.toml tests/ custom_components/timeline_scheduler/models.py
git commit -m "feat: schedule data models + test scaffolding"
```

---

### Task 2: Time parsing

**Files:**
- Create: `custom_components/timeline_scheduler/timeparse.py`
- Test: `tests/test_timeparse.py`

**Interfaces:**
- Produces: `parse_hhmm(value: str) -> datetime.time`; `parse_offset(value: str) -> datetime.timedelta` (signed; `"-00:30"` → −30 min).

- [ ] **Step 1: Write the failing test**

`tests/test_timeparse.py`:
```python
from datetime import time, timedelta

import pytest

from custom_components.timeline_scheduler.timeparse import parse_hhmm, parse_offset


def test_parse_hhmm():
    assert parse_hhmm("20:00") == time(20, 0)
    assert parse_hhmm("06:30:15") == time(6, 30, 15)


@pytest.mark.parametrize("bad", ["24:00", "12:60", "nope", "1:2:3:4"])
def test_parse_hhmm_rejects_bad(bad):
    with pytest.raises(ValueError):
        parse_hhmm(bad)


def test_parse_offset_signed():
    assert parse_offset("-00:30") == timedelta(minutes=-30)
    assert parse_offset("+01:15") == timedelta(hours=1, minutes=15)
    assert parse_offset("02:00") == timedelta(hours=2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_timeparse.py -v`
Expected: FAIL — `ModuleNotFoundError: ...timeparse`

- [ ] **Step 3: Implement `timeparse.py`**

```python
"""Parsing helpers for wall-clock times and signed offsets."""
from __future__ import annotations

from datetime import time, timedelta


def parse_hhmm(value: str) -> time:
    parts = value.split(":")
    if len(parts) == 2:
        h, m, s = parts[0], parts[1], "0"
    elif len(parts) == 3:
        h, m, s = parts
    else:
        raise ValueError(f"Invalid time '{value}', expected HH:MM[:SS]")
    try:
        hi, mi, si = int(h), int(m), int(s)
    except ValueError as err:
        raise ValueError(f"Invalid time '{value}'") from err
    if not (0 <= hi < 24 and 0 <= mi < 60 and 0 <= si < 60):
        raise ValueError(f"Time out of range: '{value}'")
    return time(hour=hi, minute=mi, second=si)


def parse_offset(value: str) -> timedelta:
    v = value.strip()
    sign = 1
    if v[:1] in ("+", "-"):
        sign = -1 if v[0] == "-" else 1
        v = v[1:]
    parts = v.split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid offset '{value}', expected ±HH:MM")
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError as err:
        raise ValueError(f"Invalid offset '{value}'") from err
    if not (0 <= m < 60):
        raise ValueError(f"Offset minutes out of range: '{value}'")
    return sign * timedelta(hours=h, minutes=m)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_timeparse.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add custom_components/timeline_scheduler/timeparse.py tests/test_timeparse.py
git commit -m "feat: time and offset parsing"
```

---

### Task 3: Transition resolver (core logic)

**Files:**
- Create: `custom_components/timeline_scheduler/resolver.py`
- Test: `tests/test_resolver.py`

**Interfaces:**
- Consumes: `models.Schedule`, `timeparse.parse_hhmm`, `timeparse.parse_offset`.
- Produces:
  - `ResolvedTransition` dataclass with `when_dt: datetime` and `transition: Transition`.
  - `active_and_next(schedule, now, anchor_lookup) -> tuple[ResolvedTransition | None, ResolvedTransition | None]` where `now` is a tz-aware `datetime` and `anchor_lookup(entity_id) -> datetime.time | None`.

- [ ] **Step 1: Write the failing test**

`tests/test_resolver.py`:
```python
from datetime import datetime, time
from zoneinfo import ZoneInfo

from custom_components.timeline_scheduler.models import Schedule
from custom_components.timeline_scheduler.resolver import active_and_next

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_resolver.py -v`
Expected: FAIL — `ModuleNotFoundError: ...resolver`

- [ ] **Step 3: Implement `resolver.py`**

```python
"""Resolve a schedule's transitions to concrete datetimes and pick active/next."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta

from .models import WEEKDAYS, Schedule, Transition
from .timeparse import parse_hhmm, parse_offset


@dataclass
class ResolvedTransition:
    when_dt: datetime
    transition: Transition


def _weekday_key(d) -> str:
    return WEEKDAYS[d.weekday()]


def _resolve_one(transition: Transition, day, tzinfo, anchor_lookup) -> datetime | None:
    """Concrete datetime for this transition on schedule-day `day`, or None."""
    w = transition.when
    if w.type == "time":
        return datetime.combine(day, parse_hhmm(w.at), tzinfo=tzinfo)
    if w.type == "anchor":
        anchor_time: time | None = anchor_lookup(w.entity)
        if anchor_time is None:
            return None
        base = datetime.combine(day, anchor_time, tzinfo=tzinfo)
        return base + parse_offset(w.offset or "+00:00")
    raise ValueError(f"Unknown when.type '{w.type}'")


def _build_occurrences(schedule: Schedule, now: datetime, anchor_lookup):
    tz = now.tzinfo
    occ: list[ResolvedTransition] = []
    # Look at yesterday/today/tomorrow so held values and next changes are found
    # regardless of midnight crossings and negative anchor offsets.
    for delta in (-1, 0, 1):
        day = (now + timedelta(days=delta)).date()
        for tr in schedule.transitions:
            if _weekday_key(day) not in tr.weekdays:
                continue
            dt = _resolve_one(tr, day, tz, anchor_lookup)
            if dt is not None:
                occ.append(ResolvedTransition(dt, tr))
    occ.sort(key=lambda r: r.when_dt)
    return occ


def active_and_next(schedule: Schedule, now: datetime, anchor_lookup):
    """Return (active, next). active = latest occurrence at/before now; next = first after."""
    occ = _build_occurrences(schedule, now, anchor_lookup)
    active: ResolvedTransition | None = None
    nxt: ResolvedTransition | None = None
    for r in occ:
        if r.when_dt <= now:
            active = r  # keep advancing; equal timestamps -> later in list wins
        else:
            nxt = r
            break
    return active, nxt
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_resolver.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add custom_components/timeline_scheduler/resolver.py tests/test_resolver.py
git commit -m "feat: transition resolver (active/next, anchors, weekdays, midnight carryover)"
```

---

### Task 4: Action mappings

**Files:**
- Create: `custom_components/timeline_scheduler/actions.py`
- Test: `tests/test_actions.py`

**Interfaces:**
- Produces: `build_service_call(apply_key: str, value, target: dict) -> tuple[str, str, dict]` returning `(domain, service, service_data)`.

- [ ] **Step 1: Write the failing test**

`tests/test_actions.py`:
```python
import pytest

from custom_components.timeline_scheduler.actions import build_service_call

TARGET = {"entity_id": "climate.bed"}


def test_climate_temperature_number():
    assert build_service_call("climate_temperature", 80, TARGET) == (
        "climate", "set_temperature", {"entity_id": "climate.bed", "temperature": 80.0})


def test_climate_temperature_off():
    assert build_service_call("climate_temperature", "off", TARGET) == (
        "climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "off"})


def test_switch_onoff():
    assert build_service_call("switch_onoff", "on", {"entity_id": "switch.shed"}) == (
        "switch", "turn_on", {"entity_id": "switch.shed"})
    assert build_service_call("switch_onoff", "off", {"entity_id": "switch.shed"}) == (
        "switch", "turn_off", {"entity_id": "switch.shed"})


def test_number_set():
    assert build_service_call("number_set", 5, {"entity_id": "number.x"}) == (
        "number", "set_value", {"entity_id": "number.x", "value": 5.0})


def test_unknown_mapping_raises():
    with pytest.raises(ValueError):
        build_service_call("nope", 1, TARGET)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_actions.py -v`
Expected: FAIL — `ModuleNotFoundError: ...actions`

- [ ] **Step 3: Implement `actions.py`**

```python
"""Translate a scheduled value into a Home Assistant service call."""
from __future__ import annotations

from typing import Any

_TRUEY = {"on", "true", "1", "yes"}


def build_service_call(apply_key: str, value: Any, target: dict) -> tuple[str, str, dict]:
    entity_id = target["entity_id"]
    if apply_key == "switch_onoff":
        service = "turn_on" if str(value).strip().lower() in _TRUEY else "turn_off"
        return ("switch", service, {"entity_id": entity_id})
    if apply_key == "climate_temperature":
        if isinstance(value, str) and value.strip().lower() == "off":
            return ("climate", "set_hvac_mode",
                    {"entity_id": entity_id, "hvac_mode": "off"})
        return ("climate", "set_temperature",
                {"entity_id": entity_id, "temperature": float(value)})
    if apply_key == "climate_hvac_mode":
        return ("climate", "set_hvac_mode",
                {"entity_id": entity_id, "hvac_mode": str(value)})
    if apply_key == "number_set":
        return ("number", "set_value", {"entity_id": entity_id, "value": float(value)})
    raise ValueError(f"Unknown apply mapping '{apply_key}'")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_actions.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add custom_components/timeline_scheduler/actions.py tests/test_actions.py
git commit -m "feat: value-to-service action mappings"
```

---

### Task 5: Persistent store

**Files:**
- Create: `custom_components/timeline_scheduler/store.py`
- Test: `tests/test_store.py`

**Interfaces:**
- Consumes: `const.STORAGE_KEY`, `const.STORAGE_VERSION`, `models.Schedule`.
- Produces: `ScheduleStore(hass)` with `async async_load() -> dict[str, Schedule]`, `list() -> list[Schedule]`, `get(sid) -> Schedule | None`, `async async_upsert(schedule)`, `async async_remove(sid)`.

- [ ] **Step 1: Write the failing test**

`tests/test_store.py`:
```python
from custom_components.timeline_scheduler.models import Schedule
from custom_components.timeline_scheduler.store import ScheduleStore

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature",
       "transitions": [{"id": "t1", "when": {"type": "time", "at": "20:00"}, "value": 80}]}


async def test_upsert_and_reload(hass):
    store = ScheduleStore(hass)
    await store.async_load()
    await store.async_upsert(Schedule.from_dict(RAW))
    assert store.get("bed").name == "Bed"

    # A fresh store instance must read the persisted data back.
    store2 = ScheduleStore(hass)
    loaded = await store2.async_load()
    assert "bed" in loaded
    assert store2.get("bed").transitions[0].value == 80

    await store2.async_remove("bed")
    assert store2.get("bed") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_store.py -v`
Expected: FAIL — `ModuleNotFoundError: ...store`

- [ ] **Step 3: Implement `store.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add custom_components/timeline_scheduler/store.py tests/test_store.py
git commit -m "feat: schedule persistence store"
```

---

### Task 6: Runtime manager

**Files:**
- Create: `custom_components/timeline_scheduler/manager.py`
- Test: `tests/test_manager.py`

**Interfaces:**
- Consumes: `store.ScheduleStore`, `resolver.active_and_next`, `actions.build_service_call`.
- Produces: `TimelineManager(hass, store)` with:
  - `async async_start()` — begin midnight tracking + set up every stored schedule.
  - `async async_refresh(sid)` — (re)apply current value and (re)arm the next-transition timer for one schedule.
  - `async async_setup_schedule(schedule)` — arm anchor watchers + call `async_refresh`.
  - `async async_teardown(sid)` — cancel all timers/watchers for a schedule.
  - internal `_anchor_lookup(entity_id) -> datetime.time | None`.

- [ ] **Step 1: Write the failing test**

`tests/test_manager.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_manager.py -v`
Expected: FAIL — `ModuleNotFoundError: ...manager`

- [ ] **Step 3: Implement `manager.py`**

```python
"""Runtime engine: applies scheduled values and arms timers."""
from __future__ import annotations

import logging
from datetime import time

from homeassistant.core import HomeAssistant, callback
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
            self._timers[sid] = async_track_point_in_time(
                self.hass, self._make_timer_handler(sid), nxt.when_dt)

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_manager.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add custom_components/timeline_scheduler/manager.py tests/test_manager.py
git commit -m "feat: runtime manager (apply current, arm next timer, anchor + midnight re-plan)"
```

---

### Task 7: Services + integration setup

**Files:**
- Modify: `custom_components/timeline_scheduler/__init__.py` (replace stub)
- Create: `custom_components/timeline_scheduler/services.py`
- Create: `custom_components/timeline_scheduler/services.yaml`
- Test: `tests/test_init.py`

**Interfaces:**
- Consumes: `store.ScheduleStore`, `manager.TimelineManager`, `models.Schedule`.
- Produces: `async_setup(hass, config)` that stores `{"store": ScheduleStore, "manager": TimelineManager}` under `hass.data["timeline_scheduler"]` and registers services `upsert_schedule`, `remove_schedule`, `apply_now`, `reload`.

- [ ] **Step 1: Write the failing test**

`tests/test_init.py`:
```python
from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.const import DOMAIN

TZ = ZoneInfo("America/New_York")

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature",
       "transitions": [{"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80}]}


async def test_setup_and_upsert_service_applies(hass):
    await hass.config.async_set_time_zone("America/New_York")
    calls = async_mock_service(hass, "climate", "set_temperature")
    assert await hass.async_setup_component(hass, DOMAIN, {DOMAIN: {}})
    await hass.async_block_till_done()

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
        await hass.async_block_till_done()

    assert hass.data[DOMAIN]["store"].get("bed") is not None
    assert any(c.data.get("temperature") == 80.0 for c in calls)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_init.py -v`
Expected: FAIL — service `upsert_schedule` not registered / setup returns stub.

- [ ] **Step 3: Implement `services.yaml`**

```yaml
upsert_schedule:
  name: Create or update schedule
  description: Create or replace a timeline schedule by id.
  fields:
    id:
      required: true
      example: bed
      selector:
        text:
    name:
      example: Bed
      selector:
        text:
    target:
      required: true
      example: '{"entity_id": "climate.bed"}'
      selector:
        object:
    apply:
      required: true
      example: climate_temperature
      selector:
        select:
          options: [switch_onoff, climate_temperature, climate_hvac_mode, number_set]
    transitions:
      required: true
      selector:
        object:
    enabled:
      selector:
        boolean:
    default:
      selector:
        object:
remove_schedule:
  name: Remove schedule
  fields:
    id:
      required: true
      selector:
        text:
apply_now:
  name: Apply schedule now
  fields:
    id:
      required: true
      selector:
        text:
reload:
  name: Reload schedules from storage
```

- [ ] **Step 4: Implement `services.py`**

```python
"""Service registration for Timeline Scheduler."""
from __future__ import annotations

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .models import Schedule

UPSERT_SCHEMA = vol.Schema({
    vol.Required("id"): cv.string,
    vol.Optional("name"): cv.string,
    vol.Required("target"): dict,
    vol.Required("apply"): cv.string,
    vol.Required("transitions"): list,
    vol.Optional("enabled", default=True): cv.boolean,
    vol.Optional("default"): vol.Any(dict, None),
}, extra=vol.ALLOW_EXTRA)

ID_SCHEMA = vol.Schema({vol.Required("id"): cv.string})


def async_register_services(hass: HomeAssistant) -> None:
    store = hass.data[DOMAIN]["store"]
    manager = hass.data[DOMAIN]["manager"]

    async def _upsert(call: ServiceCall) -> None:
        schedule = Schedule.from_dict(dict(call.data))
        await store.async_upsert(schedule)
        await manager.async_setup_schedule(schedule)

    async def _remove(call: ServiceCall) -> None:
        sid = call.data["id"]
        await manager.async_teardown(sid)
        await store.async_remove(sid)

    async def _apply_now(call: ServiceCall) -> None:
        await manager.async_refresh(call.data["id"])

    async def _reload(_call: ServiceCall) -> None:
        await store.async_load()
        await manager.async_start()

    hass.services.async_register(DOMAIN, "upsert_schedule", _upsert, schema=UPSERT_SCHEMA)
    hass.services.async_register(DOMAIN, "remove_schedule", _remove, schema=ID_SCHEMA)
    hass.services.async_register(DOMAIN, "apply_now", _apply_now, schema=ID_SCHEMA)
    hass.services.async_register(DOMAIN, "reload", _reload)
```

- [ ] **Step 5: Implement `__init__.py` (replace the stub)**

```python
"""Timeline Scheduler — setpoint/value schedules as a timeline of transitions."""
from __future__ import annotations

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
    return True
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest tests/test_init.py -v`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `pytest -v`
Expected: PASS (all tasks green)

- [ ] **Step 8: Commit**

```bash
git add custom_components/timeline_scheduler/__init__.py custom_components/timeline_scheduler/services.py custom_components/timeline_scheduler/services.yaml tests/test_init.py
git commit -m "feat: services + integration setup (Dev Tools manageable engine)"
```

---

## Self-Review (author checklist — completed)

**Spec coverage (DESIGN.md → task):** §3 concepts → Task 1 models; §4 data model → Task 1; §4.2 action mappings → Task 4; §5 engine behavior (resolve/sort/active+next, anchor & midnight re-plan, apply-on-start) → Tasks 3 & 6; storage (§4) → Task 5; Dev-Tools management (§8 Phase 1) → Task 7. **Deferred (documented, next plan):** §6 `sensor.*` entities and WebSocket API; §7 the card.

**Placeholder scan:** none — every code/test step contains complete code and an exact run command with expected result.

**Type consistency:** `active_and_next` returns `(ResolvedTransition | None, ...)`, consumed as `.transition.value` in Task 6 ✔; `ScheduleStore` methods (`async_load/list/get/async_upsert/async_remove`) match Tasks 6–7 usage ✔; `build_service_call` 3-tuple matches Task 6 unpacking ✔; `hass.data[DOMAIN]` shape `{"store","manager"}` set in `__init__` and read in `services.py` ✔.

**Known follow-ups (not blockers for Phase 1):** DST fold at anchor times relies on `zoneinfo` behavior via `datetime.combine(..., tzinfo=tz)` (acceptable; note for card preview accuracy); `reload` re-arms via `async_start` without pre-teardown of existing timers — acceptable because a fresh `store.async_load()` replaces schedules, but the next plan (which adds entity lifecycle) should add a global teardown.
