"""WebSocket API for Timeline Scheduler."""
from __future__ import annotations

from datetime import date as date_cls

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .models import Schedule
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


@callback
def async_register_ws(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list)
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_preview)
    websocket_api.async_register_command(hass, ws_save)
    websocket_api.async_register_command(hass, ws_delete)
