"""WebSocket API for Timeline Scheduler."""
from __future__ import annotations

import json
from dataclasses import replace
from datetime import date as date_cls

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .models import Schedule, Transition
from .resolver import resolve_day


@websocket_api.websocket_command({vol.Required("type"): "timeline_scheduler/list"})
@callback
def ws_list(hass: HomeAssistant, connection, msg) -> None:
    store = hass.data[DOMAIN]["store"]
    connection.send_result(msg["id"], {"schedules": [s.to_dict() for s in store.list()]})


@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/get",
    vol.Required("id_"): str,
})
@callback
def ws_get(hass: HomeAssistant, connection, msg) -> None:
    sch = hass.data[DOMAIN]["store"].get(msg["id_"])
    if sch is None:
        connection.send_error(msg["id"], "not_found", f"No schedule '{msg['id_']}'")
        return
    connection.send_result(msg["id"], sch.to_dict())


@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/preview",
    vol.Required("id_"): str,
    vol.Required("date"): str,
})
@callback
def ws_preview(hass: HomeAssistant, connection, msg) -> None:
    data = hass.data[DOMAIN]
    sch = data["store"].get(msg["id_"])
    if sch is None:
        connection.send_error(msg["id"], "not_found", f"No schedule '{msg['id_']}'")
        return
    try:
        day = date_cls.fromisoformat(msg["date"])
    except ValueError:
        connection.send_error(msg["id"], "invalid_format", "date must be YYYY-MM-DD")
        return
    occ = resolve_day(sch, day, dt_util.DEFAULT_TIME_ZONE, data["manager"]._anchor_lookup)
    connection.send_result(msg["id"], {"date": msg["date"], "occurrences": occ})


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/save",
    vol.Required("schedule"): dict,
})
@websocket_api.async_response
async def ws_save(hass: HomeAssistant, connection, msg) -> None:
    data = hass.data[DOMAIN]
    try:
        schedule = Schedule.from_dict(msg["schedule"])
    except (KeyError, ValueError, vol.Invalid) as err:
        connection.send_error(msg["id"], "invalid_format", f"invalid schedule: {err}")
        return
    # `managed` is server-owned; never let a card save clear it.
    existing = data["store"].get(schedule.id)
    if existing is not None:
        schedule.managed = existing.managed
        # A full save doesn't touch a pending draft unless it explicitly sends one.
        if "draft" not in msg["schedule"]:
            schedule.draft = existing.draft
    await data["store"].async_upsert(schedule)
    await data["manager"].async_setup_schedule(schedule)
    connection.send_result(msg["id"], schedule.to_dict())


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/delete",
    vol.Required("id_"): str,
})
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection, msg) -> None:
    data = hass.data[DOMAIN]
    sch = data["store"].get(msg["id_"])
    if sch is not None and sch.managed:
        # Managed schedules are owned by a config subentry; deleting only the
        # store row would orphan the subentry/device. Remove it from Devices
        # & Services instead.
        connection.send_error(
            msg["id"], "managed_schedule",
            "This schedule is managed as a device; remove it from "
            "Settings > Devices & Services.")
        return
    await data["manager"].async_teardown(msg["id_"])
    await data["store"].async_remove(msg["id_"])
    connection.send_result(msg["id"], {"id": msg["id_"], "removed": True})


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/override",
    vol.Required("id_"): str,
    # A value is the per-apply JSON object; scalars kept for lenient callers.
    vol.Required("value"): vol.Any(dict, float, int, str),
})
@websocket_api.async_response
async def ws_override(hass: HomeAssistant, connection, msg) -> None:
    data = hass.data[DOMAIN]
    if data["store"].get(msg["id_"]) is None:
        connection.send_error(msg["id"], "not_found", f"No schedule '{msg['id_']}'")
        return
    await data["manager"].async_set_override(msg["id_"], msg["value"])
    connection.send_result(msg["id"], {"id": msg["id_"], "overridden": True})


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/clear_override",
    vol.Required("id_"): str,
})
@websocket_api.async_response
async def ws_clear_override(hass: HomeAssistant, connection, msg) -> None:
    await hass.data[DOMAIN]["manager"].async_clear_override(msg["id_"])
    connection.send_result(msg["id"], {"id": msg["id_"], "overridden": False})


def _plan_key(transitions: list[dict], on_mode) -> tuple:
    """Order- and id-insensitive identity of a plan, to spot a draft that equals what's applied."""
    return (sorted(json.dumps({k: v for k, v in t.items() if k != "id"}, sort_keys=True)
                   for t in transitions), on_mode)


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/save_draft",
    vol.Required("id_"): str,
    vol.Required("transitions"): list,
    vol.Optional("on_mode"): vol.Any(str, None),
})
@websocket_api.async_response
async def ws_save_draft(hass: HomeAssistant, connection, msg) -> None:
    """Store the card's edits as a draft. Nothing is applied until confirm_draft."""
    store = hass.data[DOMAIN]["store"]
    sch = store.get(msg["id_"])
    if sch is None:
        connection.send_error(msg["id"], "not_found", f"No schedule '{msg['id_']}'")
        return
    try:
        transitions = [Transition.from_dict(t).to_dict() for t in msg["transitions"]]
    except (KeyError, TypeError, ValueError) as err:
        connection.send_error(msg["id"], "invalid_format", f"invalid transitions: {err}")
        return
    on_mode = msg["on_mode"] if "on_mode" in msg else sch.on_mode
    applied = _plan_key([t.to_dict() for t in sch.transitions], sch.on_mode)
    draft = None if _plan_key(transitions, on_mode) == applied else {
        "transitions": transitions, "on_mode": on_mode}
    sch = replace(sch, draft=draft)
    await store.async_upsert(sch)
    connection.send_result(msg["id"], sch.to_dict())


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/confirm_draft",
    vol.Required("id_"): str,
})
@websocket_api.async_response
async def ws_confirm_draft(hass: HomeAssistant, connection, msg) -> None:
    """Promote the draft to the applied plan and re-apply the schedule."""
    data = hass.data[DOMAIN]
    sch = data["store"].get(msg["id_"])
    if sch is None:
        connection.send_error(msg["id"], "not_found", f"No schedule '{msg['id_']}'")
        return
    if sch.draft is not None:
        sch = replace(
            sch,
            transitions=[Transition.from_dict(t) for t in sch.draft.get("transitions", [])],
            on_mode=sch.draft.get("on_mode", sch.on_mode),
            draft=None,
        )
        await data["store"].async_upsert(sch)
        await data["manager"].async_setup_schedule(sch)
    connection.send_result(msg["id"], sch.to_dict())


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "timeline_scheduler/discard_draft",
    vol.Required("id_"): str,
})
@websocket_api.async_response
async def ws_discard_draft(hass: HomeAssistant, connection, msg) -> None:
    """Drop the draft; the applied plan is untouched."""
    store = hass.data[DOMAIN]["store"]
    sch = store.get(msg["id_"])
    if sch is None:
        connection.send_error(msg["id"], "not_found", f"No schedule '{msg['id_']}'")
        return
    if sch.draft is not None:
        sch = replace(sch, draft=None)
        await store.async_upsert(sch)
    connection.send_result(msg["id"], sch.to_dict())


@callback
def async_register_ws(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list)
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_preview)
    websocket_api.async_register_command(hass, ws_save)
    websocket_api.async_register_command(hass, ws_delete)
    websocket_api.async_register_command(hass, ws_override)
    websocket_api.async_register_command(hass, ws_clear_override)
    websocket_api.async_register_command(hass, ws_save_draft)
    websocket_api.async_register_command(hass, ws_confirm_draft)
    websocket_api.async_register_command(hass, ws_discard_draft)
