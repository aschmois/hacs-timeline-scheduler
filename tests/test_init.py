from datetime import datetime
from zoneinfo import ZoneInfo

from freezegun import freeze_time
from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.const import DOMAIN

from .helpers import setup_integration

TZ = ZoneInfo("America/New_York")

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature",
       "transitions": [{"id": "a", "when": {"type": "time", "at": "20:00"}, "value": 80}]}


async def test_setup_and_upsert_service_applies(hass):
    await hass.config.async_set_time_zone("America/New_York")
    calls = async_mock_service(hass, "climate", "set_temperature")
    await setup_integration(hass)

    with freeze_time(datetime(2026, 1, 5, 21, 0, tzinfo=TZ)):
        await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
        await hass.async_block_till_done()

    assert hass.data[DOMAIN]["store"].get("bed") is not None
    assert any(c.data.get("temperature") == 80.0 for c in calls)
