from custom_components.timeline_scheduler.models import Schedule
from custom_components.timeline_scheduler.store import ScheduleStore

RAW = {"id": "bed", "name": "Bed", "target": {"entity_id": "climate.bed"},
       "apply": "climate_temperature",
       "transitions": [{"id": "t1", "when": {"type": "time", "at": "20:00"}, "value": 80}]}


async def test_upsert_and_reload(hass):
    store = ScheduleStore(hass)
    await store.async_load()
    await store.async_upsert(Schedule.from_dict(RAW))
    assert store.get("bed").name == "Bed"

    # A fresh store instance must read the persisted data back.
    store2 = ScheduleStore(hass)
    loaded = await store2.async_load()
    assert "bed" in loaded
    assert store2.get("bed").transitions[0].value == 80

    await store2.async_remove("bed")
    assert store2.get("bed") is None
