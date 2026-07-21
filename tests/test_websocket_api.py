from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.const import DOMAIN
from custom_components.timeline_scheduler.models import Schedule

from .helpers import setup_integration

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature",
       "transitions": [{"id": "t1", "when": {"type": "time", "at": "20:00"}, "value": 80}]}


async def _setup(hass):
    async_mock_service(hass, "climate", "set_temperature")
    await setup_integration(hass)


async def test_ws_list_and_get(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)

    await client.send_json({"id": 1, "type": "timeline_scheduler/list"})
    resp = await client.receive_json()
    assert resp["success"]
    assert [s["id"] for s in resp["result"]["schedules"]] == ["bed"]

    await client.send_json({"id": 2, "type": "timeline_scheduler/get", "id_": "bed"})
    # note: HA reserves "id" for the message id; schedule id travels as "id_" — see impl
    resp = await client.receive_json()
    assert resp["success"] and resp["result"]["name"] == "Bed"


async def test_ws_get_missing(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/get", "id_": "nope"})
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "not_found"


async def test_ws_preview(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/preview",
                            "id_": "bed", "date": "2026-01-05"})
    resp = await client.receive_json()
    assert resp["success"]
    occ = resp["result"]["occurrences"]
    assert len(occ) == 1 and occ[0]["value"] == 80
    assert occ[0]["time"].startswith("2026-01-05T20:00:00")


async def test_ws_preview_missing(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/preview",
                            "id_": "nope", "date": "2026-01-05"})
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "not_found"


async def test_ws_preview_bad_date(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/preview",
                            "id_": "bed", "date": "not-a-date"})
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "invalid_format"


SAVE = {"id": "office", "name": "Office", "target": {"entity_id": "climate.office"},
        "apply": "climate_temperature",
        "transitions": [{"id": "t1", "when": {"type": "time", "at": "09:00"}, "value": 68}]}


async def test_ws_save_then_list(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save", "schedule": SAVE})
    resp = await client.receive_json()
    assert resp["success"] and resp["result"]["id"] == "office"
    assert hass.data[DOMAIN]["store"].get("office") is not None

    await client.send_json({"id": 2, "type": "timeline_scheduler/list"})
    resp = await client.receive_json()
    assert "office" in [s["id"] for s in resp["result"]["schedules"]]


async def test_ws_delete(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/delete", "id_": "bed"})
    resp = await client.receive_json()
    assert resp["success"] and resp["result"]["removed"] is True
    assert hass.data[DOMAIN]["store"].get("bed") is None


async def test_ws_save_preserves_managed(hass, hass_ws_client):
    """A card save (no `managed` in payload) must not clear a managed schedule."""
    await _setup(hass)
    store = hass.data[DOMAIN]["store"]
    await store.async_upsert(Schedule.from_dict({**SAVE, "managed": True}))
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save", "schedule": SAVE})
    resp = await client.receive_json()
    assert resp["success"]
    assert store.get("office").managed is True


async def test_ws_save_malformed(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save",
                            "schedule": {"id": "broken"}})  # missing target/apply/transitions
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "invalid_format"
