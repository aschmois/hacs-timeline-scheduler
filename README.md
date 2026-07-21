# Timeline Scheduler for Home Assistant

A Home Assistant custom integration for **setpoint / value schedules modeled as a timeline of
transitions** — "at this time, set this target to this value" — where transition times can be
**absolute** or **relative to a moving anchor** (e.g. *30 minutes before my alarm*).

It fills the gap the built-in **Schedule** helper leaves: that helper is a calendar of on/off
*blocks*, which can't express a step-function of temperatures, and can't anchor a transition to
a variable time like a wake-up alarm.

> **Status:** early development. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.
> Phase 1 (engine) is in progress; the Nest-style timeline editor card is Phase 2.

## Why

Home thermostats (à la Nest) and heated beds (SleepMe/Eight Sleep) think in a **timeline of
setpoints**, not on/off blocks. This integration provides that model as reusable data plus a
generic engine, so one pattern covers the bed today and thermostats/other devices later.

## Features (planned)

- Timeline of `at → set target to value` transitions (step-function, values held between points).
- Absolute (`20:00`) **and** anchor-relative (`alarm − 00:30`) transition times.
- Pluggable action mappings: climate setpoint, hvac mode, switch on/off, number.
- Auto **re-plan** when the anchor entity changes; correct value applied on HA restart.
- First-class entities: `sensor.timeline_<id>` (current value, next change).
- WebSocket CRUD API + a bundled **timeline editor card** (Phase 2).

## Not in scope

Point-event schedules like "dispense N cat-food portions at 07:00" — those have different
semantics (catch-up on missed events) and stay as their own automations.

## Installation

Not yet released. Once published: add this repo as a **HACS custom repository** (Integration),
install, restart, then add schedules. Manual install: copy
`custom_components/timeline_scheduler/` into your HA `config/custom_components/`.

## License

MIT — see [`LICENSE`](LICENSE).
