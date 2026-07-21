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
    # Handlers resolve the store/manager from hass.data at call time, so these
    # registrations stay valid across config-entry reloads (which replace the
    # store/manager objects) without needing to be re-registered.

    async def _upsert(call: ServiceCall) -> None:
        data = hass.data[DOMAIN]
        schedule = Schedule.from_dict(dict(call.data))
        await data["store"].async_upsert(schedule)
        await data["manager"].async_setup_schedule(schedule)

    async def _remove(call: ServiceCall) -> None:
        data = hass.data[DOMAIN]
        sid = call.data["id"]
        await data["manager"].async_teardown(sid)
        await data["store"].async_remove(sid)

    async def _apply_now(call: ServiceCall) -> None:
        await hass.data[DOMAIN]["manager"].async_refresh(call.data["id"])

    async def _reload(_call: ServiceCall) -> None:
        data = hass.data[DOMAIN]
        await data["manager"].async_stop()
        await data["store"].async_load()
        await data["manager"].async_start()

    hass.services.async_register(DOMAIN, "upsert_schedule", _upsert, schema=UPSERT_SCHEMA)
    hass.services.async_register(DOMAIN, "remove_schedule", _remove, schema=ID_SCHEMA)
    hass.services.async_register(DOMAIN, "apply_now", _apply_now, schema=ID_SCHEMA)
    hass.services.async_register(DOMAIN, "reload", _reload)
