"""Per-schedule next-change sensor tests."""
from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_mock_service

from .helpers import seed_store, setup_with_subentries

TZ = ZoneInfo("America/New_York")

BED = {
    "id": "bed", "name": "Bed", "enabled": True, "managed": True,
    "target": {"entity_id": "climate.bed"}, "apply": "climate_temperature",
    "default": None,
    "transitions": [
        {"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80},
        {"id": "b", "when": {"type": "time", "at": "22:00"}, "value": 70},
    ],
}


async def test_next_change_sensor_reports_state_and_attributes(hass, hass_storage):
    await hass.config.async_set_time_zone("America/New_York")
    async_mock_service(hass, "climate", "set_temperature")
    seed_store(hass_storage, BED)

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        entry = await setup_with_subentries(hass, ("bed", "Bed"))

    state = hass.states.get("sensor.bed_next_change")
    assert state is not None
    parsed = dt_util.parse_datetime(state.state)
    assert parsed is not None
    assert dt_util.as_local(parsed).strftime("%H:%M") == "22:00"
    assert state.attributes["current_target"] == 80
    assert state.attributes["next_target"] == 70
    assert state.attributes["active_transition_id"] == "a"

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
