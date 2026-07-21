"""Per-schedule enable switch tests."""
from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.const import DOMAIN

from .helpers import seed_store, setup_with_subentries

TZ = ZoneInfo("America/New_York")

BED = {
    "id": "bed", "name": "Bed", "enabled": True, "managed": True,
    "target": {"entity_id": "climate.bed"}, "apply": "climate_temperature",
    "default": None,
    "transitions": [{"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80}],
}


async def test_switch_created_and_toggles(hass, hass_storage):
    await hass.config.async_set_time_zone("America/New_York")
    async_mock_service(hass, "climate", "set_temperature")
    seed_store(hass_storage, BED)

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        entry = await setup_with_subentries(hass, ("bed", "Bed"))

    state = hass.states.get("switch.bed")
    assert state is not None
    assert state.state == "on"

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        await hass.services.async_call(
            "switch", "turn_off", {"entity_id": "switch.bed"}, blocking=True
        )
        await hass.async_block_till_done()

    store = hass.data[DOMAIN]["store"]
    assert store.get("bed").enabled is False
    assert hass.states.get("switch.bed").state == "off"

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
