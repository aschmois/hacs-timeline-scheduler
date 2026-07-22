"""Timeline Scheduler — setpoint/value schedules as a timeline of transitions."""
from __future__ import annotations

import logging
import os

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN, SCHEDULE_SUBENTRY_TYPE
from .manager import TimelineManager
from .services import async_register_services
from .store import ScheduleStore
from .websocket_api import async_register_ws

_LOGGER = logging.getLogger(__name__)

CARD_URL = "/timeline_scheduler/timeline-scheduler-card.js"
CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "timeline-scheduler-card.js")
PLATFORMS = [Platform.SWITCH, Platform.SENSOR]

# Marks the process-wide, one-time registration (services, websocket API, card).
# Survives config-entry reloads so we never double-register the static path.
DATA_PLATFORM_REGISTERED = "timeline_scheduler_platform_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Timeline Scheduler from its config entry."""
    store = ScheduleStore(hass)
    await store.async_load()
    manager = TimelineManager(hass, store)
    hass.data[DOMAIN] = {"store": store, "manager": manager}

    await _async_register_platform(hass)
    await _async_reconcile_managed(entry, store)
    await manager.async_start()

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    # Reload when a schedule subentry is added / edited / removed so the
    # per-schedule switch and sensor are (re)created or torn down.
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    async def _handle_stop(_event) -> None:
        await manager.async_stop()

    entry.async_on_unload(
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _handle_stop)
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down the runtime and per-schedule platforms.

    Services / websocket commands / the card static path are process-wide and
    stay registered (the static path cannot be unregistered).
    """
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    data = hass.data.pop(DOMAIN, None)
    if data is not None:
        await data["manager"].async_stop()
    return unloaded


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when its subentries change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_reconcile_managed(entry: ConfigEntry, store: ScheduleStore) -> None:
    """Remove managed schedules whose owning subentry no longer exists."""
    managed_ids = {
        s.data["schedule_id"]
        for s in entry.subentries.values()
        if s.subentry_type == SCHEDULE_SUBENTRY_TYPE
    }
    for sch in list(store.list()):
        if sch.managed and sch.id not in managed_ids:
            await store.async_remove(sch.id)


async def _async_register_platform(hass: HomeAssistant) -> None:
    """Register services, the websocket API, and the frontend card exactly once."""
    if hass.data.get(DATA_PLATFORM_REGISTERED):
        return
    hass.data[DATA_PLATFORM_REGISTERED] = True
    async_register_services(hass)
    async_register_ws(hass)
    if not os.path.exists(CARD_PATH):
        return
    if hass.http is not None:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, CARD_PATH, False)]
        )
        # Append the integration version so a browser cache-busts the card on
        # every update (the static handler ignores the query string).
        try:
            integration = await async_get_integration(hass, DOMAIN)
            card_url = f"{CARD_URL}?v={integration.version}"
        except Exception:  # noqa: BLE001 - fall back to the bare URL
            card_url = CARD_URL
        add_extra_js_url(hass, card_url)
    else:
        _LOGGER.warning(
            "Timeline Scheduler card found but hass.http is unavailable; card not served"
        )
