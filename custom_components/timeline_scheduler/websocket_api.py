"""WebSocket API for Timeline Scheduler."""
from __future__ import annotations

from datetime import date as date_cls

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
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
    day = date_cls.fromisoformat(msg["date"])
    occ = resolve_day(sch, day, dt_util.DEFAULT_TIME_ZONE, data["manager"]._anchor_lookup)
    connection.send_result(msg["id"], {"date": msg["date"], "occurrences": occ})


@callback
def async_register_ws(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_list)
    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_preview)
