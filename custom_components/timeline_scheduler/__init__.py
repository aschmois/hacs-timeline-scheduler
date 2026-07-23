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
        await _async_register_card(hass, card_url)
    else:
        _LOGGER.warning(
            "Timeline Scheduler card found but hass.http is unavailable; card not served"
        )


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete the Lovelace resource we registered when the integration is removed."""
    resources = _lovelace_storage_resources(hass)
    if resources is None:
        return
    try:
        await resources.async_get_info()  # ensure the collection is loaded
        for item in list(resources.async_items()):
            if str(item.get("url", "")).split("?")[0] == CARD_URL:
                await resources.async_delete_item(item["id"])
    except Exception as err:  # noqa: BLE001 - best-effort cleanup
        _LOGGER.debug("Timeline Scheduler: could not remove card resource: %s", err)


async def _async_register_card(hass: HomeAssistant, card_url: str) -> None:
    """Make the card load on every dashboard.

    Prefer registering it as a Lovelace *resource* (storage mode): the frontend
    loads resources at runtime from the resource list, exactly like HACS
    frontend plugins, so the card survives the companion app's precached
    app-shell. `add_extra_js_url` — which only injects the module into the
    server-rendered index — is a fallback for when the storage resource
    collection isn't available (YAML resource mode, or Lovelace not set up).
    """
    resources = _lovelace_storage_resources(hass)
    if resources is not None:
        try:
            await _async_upsert_card_resource(resources, card_url)
            return
        except Exception as err:  # noqa: BLE001 - degrade to the index injection
            _LOGGER.warning(
                "Timeline Scheduler: could not register the card as a Lovelace "
                "resource (%s); falling back to a frontend extra module URL",
                err,
            )
    add_extra_js_url(hass, card_url)


def _lovelace_storage_resources(hass: HomeAssistant):
    """Return the storage-mode Lovelace resource collection, or None."""
    try:
        from homeassistant.components.lovelace.const import LOVELACE_DATA
    except ImportError:
        return None
    lovelace = hass.data.get(LOVELACE_DATA)
    if lovelace is None or getattr(lovelace, "resource_mode", None) != "storage":
        return None
    return getattr(lovelace, "resources", None)


async def _async_upsert_card_resource(resources, card_url: str) -> None:
    """Create or version-bump our single card resource (dedupe by base URL)."""
    await resources.async_get_info()  # ensures the collection is loaded
    base = card_url.split("?")[0]
    existing = next(
        (
            item
            for item in resources.async_items()
            if str(item.get("url", "")).split("?")[0] == base
        ),
        None,
    )
    if existing is None:
        await resources.async_create_item({"res_type": "module", "url": card_url})
    elif existing.get("url") != card_url:
        await resources.async_update_item(existing["id"], {"url": card_url})
