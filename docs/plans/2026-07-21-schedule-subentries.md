# Schedule Subentries + Devices — Plan

**Goal:** Let users create/manage schedules natively from Settings → Devices &
Services (an "Add Schedule" button on the integration tile), each schedule
becoming a device with an enable **switch** and a next-change **sensor**. The
timeline itself is still edited in the card.

**Architecture:** The `ScheduleStore` stays the single source of truth for the
full `Schedule` (metadata + transitions) — engine, card, and WebSocket API are
unchanged. A config **subentry** is a thin handle: `data = {"schedule_id": id}`,
title = schedule name. Subentry-created schedules are marked `managed=True` so a
reconcile step can prune them from the store when their subentry is removed.
Adding/editing/removing a subentry fires the parent entry's update listeners →
we reload the entry → platforms (re)create per-subentry entities via
`async_add_entities(..., config_subentry_id=...)`; HA auto-clears the device/
entity registry for a removed subentry.

**Tech stack:** HA 2026.7 config subentries (`ConfigSubentryFlow`,
`async_get_supported_subentry_types`), entity platforms attached per subentry,
`async_dispatcher_send`/`connect` for live entity updates.

## Global Constraints
- Public repo: author `aschmois <aschmois@users.noreply.github.com>`, no personal info.
- Store remains full-schedule truth; do NOT change the card/WS/engine contracts.
- `managed` is server-authoritative: WS `save` and `upsert_schedule` service
  MUST preserve an existing schedule's `managed` flag (never let the client clear it).
- `single_config_entry: true` stays (one integration entry, many schedule subentries).
- Manifest version → `0.2.0`.

## Key data/decisions
- `Schedule.managed: bool = False`; `to_dict` emits `"managed"` only when True.
- Subentry type id: `"schedule"`.
- Dispatcher signal per schedule: `f"{DOMAIN}_schedule_updated_{sid}"`.
- Manager records `state[sid] = {current, next_dt, next_target, active_id}` in
  `async_refresh`, then dispatches the signal.
- Entities: `switch.<name>` (enable ⇄ `schedule.enabled`), `sensor.<name>_next_change`
  (timestamp; attrs `current_target`, `next_target`, `active_transition_id`).

## Tasks (TDD, each ends green in `tl-test`)
1. `models.py`: add `managed` field + round-trip; preserve in `services._upsert`
   and `websocket_api.ws_save`. Tests: model round-trip, ws-save preserves managed.
2. `manager.py`: `state` dict + dispatcher signal on refresh/teardown. Test: state
   reflects active/next after refresh.
3. `config_flow.py` + strings/translations: `async_get_supported_subentry_types`
   + `ScheduleSubentryFlowHandler` (user=create writes managed schedule to store;
   reconfigure edits name/target/apply/enabled preserving transitions+managed).
   Tests: create writes store + subentry; reconfigure updates; slug uniqueness.
4. `entity.py` base + `switch.py` + `__init__.py` wiring (forward platforms,
   update-listener reload, reconcile-prune). Tests: subentry→switch entity, toggle
   flips enabled, remove subentry prunes managed schedule on reload.
5. `sensor.py` next-change sensor. Tests: native_value + attributes track manager state.
</content>
