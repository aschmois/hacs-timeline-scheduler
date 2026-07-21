# Timeline Scheduler — Design

Status: **Draft for review** · Date: 2026-07-20 · Author: aschmois

## 1. Problem

Home Assistant's built-in **Schedule** helper is a *calendar of on/off blocks* ("entity is on
from 18:00–23:00"). That model does not fit schedules that are a **step-function of values over
time**, where the transition times may be **relative to a moving anchor**.

Motivating example — a heated mattress pad (e.g. a SleepMe/Eight Sleep dock, `climate.bed`):

```
20:00          → 80 °F     (absolute)
02:00          → 83 °F     (absolute)
alarm − 00:30  → 95 °F     (relative to input_datetime.wakeup_time)
alarm + 00:30  → off       (relative)
```

Done as a native automation, this becomes hard-coded offsets/temperatures with per-branch
`if trigger.id` logic. It doesn't generalize to "a lot of things," isn't editable without
editing YAML, and can't be reasoned about visually.

## 2. Goals / Non-goals

**Goals**
- Model a schedule as an ordered **timeline of transitions**: `at → set target to value`.
- Support transition times that are **absolute** (`"20:00"`) or **anchor-relative**
  (`anchor entity ± offset`, e.g. 30 min before an alarm).
- Apply values to any target: `climate` setpoint / hvac_mode, `switch` on/off, etc.
- **Re-plan automatically** when an anchor entity (the alarm) changes.
- Expose first-class HA entities (current value, next change) for dashboards/automations.
- Ship a **Nest-style timeline editor card** bundled in this repo (Phase 2).
- Be installable via HACS (custom repository) or a manual `custom_components` drop-in.

**Non-goals (YAGNI)**
- Point-event "dispense N at time T" schedules (e.g. pet feeders) — explicitly **out of scope**;
  they have different semantics (catch-up on missed events) and stay as their own automations.
  This project is for **interval / setpoint** schedules only.
- Full thermostat climate scheduling UX beyond what the transition model provides (later).
- Replacing the native Schedule helper for simple on/off blocks (a light *could* use this as a
  2-transition case — see §8).

## 3. Core concepts

- **Schedule** — a named timeline bound to one **target** entity, with a list of **transitions**
  and an optional **default** (value applied outside/at start before the first transition).
- **Transition** — `{ when, value }`. Fired in chronological order across the day; the value is
  **held** until the next transition (step function).
- **when** — one of:
  - `{ type: "time", at: "HH:MM[:SS]" }` — absolute wall-clock, per selected weekdays.
  - `{ type: "anchor", entity: "<input_datetime|sensor>", offset: "±HH:MM" }` — resolved to an
    absolute time each day from the anchor entity's value.
- **value → target** — an **action mapping** describing how a value is applied to the target,
  so one engine handles climate/switch/etc. (see §4.2).
- **weekdays** — set of days a transition applies to (default: all 7). Enables weekday/weekend
  variation a single-time automation can't do.

## 4. Data model

Stored via HA's `Store` helper (`.storage/timeline_scheduler`), unbounded JSON. One record:

```jsonc
{
  "id": "bed",
  "name": "Bed",
  "enabled": true,
  "target": { "entity_id": "climate.bed" },
  "apply": "climate_temperature",          // action mapping key (see 4.2)
  "default": { "value": null },            // null = do nothing before first transition
  "transitions": [
    { "id": "t1", "when": {"type":"time","at":"20:00"},                              "value": 80, "weekdays": ["mon","tue","wed","thu","sun"] },
    { "id": "t2", "when": {"type":"time","at":"02:00"},                              "value": 83 },
    { "id": "t3", "when": {"type":"anchor","entity":"input_datetime.wakeup_time","offset":"-00:30"}, "value": 95 },
    { "id": "t4", "when": {"type":"anchor","entity":"input_datetime.wakeup_time","offset":"+00:30"}, "value": "off" }
  ]
}
```

### 4.2 Action mappings (`apply`)

Small built-in adapters translate a `value` into an HA service call on the target. This keeps
the engine generic and the data declarative.

| key | value type | effect |
|---|---|---|
| `switch_onoff` | `"on"`/`"off"` | `switch.turn_on/off` |
| `climate_temperature` | number \| `"off"` | number → `climate.set_temperature`; `"off"` → `climate.set_hvac_mode: off` |
| `climate_hvac_mode` | string | `climate.set_hvac_mode` |
| `number_set` | number | `number.set_value` |

Extensible: a new device type = a new mapping, no engine changes.

## 5. Engine behavior

The engine runs in-process (async, HA event loop). Per enabled schedule:

1. **Resolve** every transition to a concrete `datetime` for the relevant day(s), expanding
   anchors from their entity's current value + offset. Anchor offsets crossing midnight roll to
   the correct calendar day.
2. **Sort** resolved transitions; determine the **currently-active** one (the most recent
   transition at/before now for today, considering held values) and schedule a timer for the
   **next** one.
3. **On fire** — apply the value via the action mapping, then schedule the following transition.
4. **Re-plan triggers** on: anchor entity state change, schedule edit, HA start, and local
   midnight (to roll the day/weekday set).
5. **On HA start / schedule enable** — compute and apply the **current** value immediately so
   state is correct after a restart (idempotent; skip if target already matches).

**Edge cases to handle explicitly:** two transitions resolving to the same minute (last wins,
deterministic by list order); anchor entity `unknown`/`unavailable` (skip its transitions, log
once, retry when it becomes available); DST transitions; target unavailable at apply time
(retry with backoff, bounded).

## 6. Exposed HA surface

**Entities** (per schedule):
- `sensor.timeline_<id>` — state = current value (or `idle`); attributes: `next_change` (ts),
  `next_value`, `active_transition_id`, `enabled`.
- Optional `switch.timeline_<id>_enabled` — enable/disable the schedule.

**Services:**
- `timeline_scheduler.apply_now` (id) — force re-evaluate + apply.
- `timeline_scheduler.reload` — reload from store.
- `timeline_scheduler.set_transition` / `remove_transition` / `upsert_schedule` — CRUD.

**WebSocket API** (for the card): `timeline_scheduler/list`, `/get`, `/save`, `/delete`,
`/preview` (returns resolved times for a given day, incl. anchor expansion for rendering).

## 7. The timeline card (Phase 2, bundled)

A custom Lovelace card lives in `card/` **in this same repo** and is delivered by the
integration (single HACS install). On setup the integration registers the built JS as a
frontend module (`async_register_static_paths` + a frontend `add_extra_js_url`), so the user
doesn't add a Lovelace resource manually.

- Renders a **per-weekday 24h timeline** with draggable value "dots" (Nest-style).
- **Anchor-relative dots** can't sit on a fixed clock position, so they render as a distinct
  marker pinned to the anchor (e.g. a labeled "⏰ −30m 95°" chip on a secondary lane) with a
  live "resolves to ~06:30 today" hint from the `/preview` API.
- Reads/writes via the WebSocket API — no `input_text` JSON hacks.
- **Card stack:** standard Lit + rollup + TypeScript scaffold (customCards registration, config
  editor, i18n, tag→build→release-asset CI). Bump runtime libs to current (Lit 3; talk to HA via
  the injected `hass.connection` rather than an old `home-assistant-js-websocket`).
- **Buy-before-build:** evaluate HACS `scheduler-card` first; it gives a timeline UI but (as of
  writing) only clock/sun anchors, not arbitrary entity anchors — likely a dealbreaker for the
  bed. Decision recorded during Phase 2 kickoff.

## 8. Packaging & rollout

**Packaging:** one repo, HACS **integration** type. The Python integration lives in
`custom_components/timeline_scheduler/`; the card source in `card/` builds to a JS asset the
integration serves. Single install delivers engine + card.

**Phasing:**
- **Phase 1 — Engine (no custom UI).** Integration + storage + action mappings + entities +
  services + WebSocket CRUD. Migrate a real bed schedule off a hand-rolled automation. Editable
  via Dev Tools / YAML import in the meantime. Ships value on its own.
- **Phase 2 — Timeline card.** The Nest-style editor on top of Phase 1's WebSocket API, bundled
  and auto-registered.
- **Phase 3 — Broaden.** On/off lights (2-transition) and future thermostats; weekday variation;
  import helper for existing schedules.

## 9. Open questions

1. Is the wake-up anchor (`input_datetime.wakeup_time`) set manually or derived from a phone
   next-alarm sensor? (Affects how often anchors move and re-planning cadence.)
2. Do we want per-schedule **presence/condition guards** as first-class fields, or leave
   conditions to separate automations?
3. Domain name `timeline_scheduler` — final (repo: `hacs-timeline-scheduler`).
