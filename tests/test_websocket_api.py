from pytest_homeassistant_custom_component.common import async_mock_service

from custom_components.timeline_scheduler.const import DOMAIN
from custom_components.timeline_scheduler.models import Schedule

from .helpers import setup_integration

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature", "on_mode": "heat",
       "transitions": [{"id": "t1", "when": {"type": "time", "at": "20:00"},
                        "value": {"mode": None, "temp": 80}}]}


async def _setup(hass):
    async_mock_service(hass, "climate", "set_temperature")
    async_mock_service(hass, "climate", "set_hvac_mode")
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
    assert len(occ) == 1 and occ[0]["value"] == {"mode": None, "temp": 80}
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
        "apply": "climate_temperature", "on_mode": "heat",
        "transitions": [{"id": "t1", "when": {"type": "time", "at": "09:00"},
                         "value": {"mode": None, "temp": 68}}]}


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


async def test_ws_delete_rejects_managed(hass, hass_ws_client):
    """A managed schedule can't be deleted via WS (would orphan its subentry)."""
    await _setup(hass)
    store = hass.data[DOMAIN]["store"]
    await store.async_upsert(Schedule.from_dict({**SAVE, "managed": True}))
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/delete", "id_": "office"})
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "managed_schedule"
    assert store.get("office") is not None  # not removed


async def test_ws_override_and_clear(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/override", "id_": "bed",
                            "value": {"mode": None, "temp": 66}})
    resp = await client.receive_json()
    assert resp["success"] and resp["result"]["overridden"] is True
    assert hass.data[DOMAIN]["manager"].state["bed"]["overridden"] is True

    await client.send_json({"id": 2, "type": "timeline_scheduler/clear_override", "id_": "bed"})
    resp = await client.receive_json()
    assert resp["success"] and resp["result"]["overridden"] is False


async def test_ws_override_missing(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/override", "id_": "nope", "value": 66})
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "not_found"


async def test_ws_save_malformed(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save",
                            "schedule": {"id": "broken"}})  # missing target/apply/transitions
    resp = await client.receive_json()
    assert not resp["success"] and resp["error"]["code"] == "invalid_format"


DRAFT_TRANSITIONS = [{"id": "d1", "when": {"type": "time", "at": "21:00"},
                      "value": {"mode": None, "temp": 70}}]


async def test_ws_save_draft_stores_without_applying(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    await hass.async_block_till_done()
    calls = async_mock_service(hass, "climate", "set_temperature")
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save_draft", "id_": "bed",
                            "transitions": DRAFT_TRANSITIONS, "on_mode": "heat"})
    resp = await client.receive_json()
    await hass.async_block_till_done()
    assert resp["success"]
    assert resp["result"]["draft"]["transitions"][0]["when"]["at"] == "21:00"
    sch = hass.data[DOMAIN]["store"].get("bed")
    assert sch.transitions[0].when.at == "20:00"  # applied plan untouched
    assert sch.draft is not None
    assert calls == []  # nothing applied

    await client.send_json({"id": 2, "type": "timeline_scheduler/get", "id_": "bed"})
    resp = await client.receive_json()
    assert resp["result"]["draft"]["transitions"][0]["value"] == {"mode": None, "temp": 70}


async def test_ws_save_draft_equal_to_applied_clears_it(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save_draft", "id_": "bed",
                            "transitions": DRAFT_TRANSITIONS, "on_mode": "heat"})
    await client.receive_json()
    same = [{**RAW["transitions"][0], "id": "other-id"}]  # ids don't matter
    await client.send_json({"id": 2, "type": "timeline_scheduler/save_draft", "id_": "bed",
                            "transitions": same, "on_mode": "heat"})
    resp = await client.receive_json()
    assert resp["success"] and "draft" not in resp["result"]
    assert hass.data[DOMAIN]["store"].get("bed").draft is None


async def test_ws_confirm_draft_applies(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save_draft", "id_": "bed",
                            "transitions": DRAFT_TRANSITIONS, "on_mode": "auto"})
    await client.receive_json()
    await client.send_json({"id": 2, "type": "timeline_scheduler/confirm_draft", "id_": "bed"})
    resp = await client.receive_json()
    assert resp["success"] and "draft" not in resp["result"]
    sch = hass.data[DOMAIN]["store"].get("bed")
    assert sch.draft is None and sch.on_mode == "auto"
    assert [t.when.at for t in sch.transitions] == ["21:00"]
    assert hass.data[DOMAIN]["manager"].state["bed"]["current"] == {"mode": None, "temp": 70}


async def test_ws_discard_draft(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save_draft", "id_": "bed",
                            "transitions": DRAFT_TRANSITIONS})
    await client.receive_json()
    await client.send_json({"id": 2, "type": "timeline_scheduler/discard_draft", "id_": "bed"})
    resp = await client.receive_json()
    assert resp["success"] and "draft" not in resp["result"]
    sch = hass.data[DOMAIN]["store"].get("bed")
    assert sch.draft is None and [t.when.at for t in sch.transitions] == ["20:00"]


async def test_ws_draft_commands_missing_schedule(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)
    for i, (typ, extra) in enumerate([("save_draft", {"transitions": []}), ("confirm_draft", {}),
                                      ("discard_draft", {})], start=1):
        await client.send_json({"id": i, "type": f"timeline_scheduler/{typ}", "id_": "nope", **extra})
        resp = await client.receive_json()
        assert not resp["success"] and resp["error"]["code"] == "not_found"


async def test_full_save_and_upsert_preserve_draft(hass, hass_ws_client):
    await _setup(hass)
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "timeline_scheduler/save_draft", "id_": "bed",
                            "transitions": DRAFT_TRANSITIONS})
    await client.receive_json()
    await client.send_json({"id": 2, "type": "timeline_scheduler/save", "schedule": RAW})
    assert (await client.receive_json())["success"]
    assert hass.data[DOMAIN]["store"].get("bed").draft is not None
    await hass.services.async_call(DOMAIN, "upsert_schedule", RAW, blocking=True)
    assert hass.data[DOMAIN]["store"].get("bed").draft is not None
