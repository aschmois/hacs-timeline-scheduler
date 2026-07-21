from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from homeassistant.helpers import device_registry as dr
from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.const import DOMAIN

from .helpers import seed_store, setup_integration, setup_with_subentries

TZ = ZoneInfo("America/New_York")

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature",
       "transitions": [{"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80}]}

MANAGED_BED = {**RAW, "enabled": True, "default": None, "managed": True}


async def test_setup_and_upsert_service_applies(hass):
    await hass.config.async_set_time_zone("America/New_York")
    calls = async_mock_service(hass, "climate", "set_temperature")
    await setup_integration(hass)

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
        await hass.async_block_till_done()

    assert hass.data[DOMAIN]["store"].get("bed") is not None
    assert any(c.data.get("temperature") == 80.0 for c in calls)


async def test_subentry_creates_device_and_removal_prunes_schedule(hass, hass_storage):
    await hass.config.async_set_time_zone("America/New_York")
    async_mock_service(hass, "climate", "set_temperature")
    seed_store(hass_storage, MANAGED_BED)

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        entry = await setup_with_subentries(hass, ("bed", "Bed"))

    # Device + entities exist for the schedule
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, "bed")})
    assert device is not None
    assert hass.states.get("switch.bed") is not None
    assert hass.data[DOMAIN]["store"].get("bed") is not None

    # Removing the subentry reloads the entry, which prunes the managed schedule
    subentry_id = next(iter(entry.subentries))
    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        hass.config_entries.async_remove_subentry(entry, subentry_id)
        await hass.async_block_till_done()

    assert hass.data[DOMAIN]["store"].get("bed") is None
    assert hass.states.get("switch.bed") is None

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
