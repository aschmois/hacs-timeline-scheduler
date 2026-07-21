import pytest

from custom_components.timeline_scheduler.models import Schedule, WEEKDAYS, When

RAW = {
    "id": "bed",
    "name": "Bed",
    "enabled": True,
    "target": {"entity_id": "climate.bed"},
    "apply": "climate_temperature",
    "default": {"value": None},
    "transitions": [
        {"id": "t1", "when": {"type": "time", "at": "20:00"}, "value": 80,
         "weekdays": ["mon", "tue"]},
        {"id": "t2", "when": {"type": "anchor", "entity": "input_datetime.wakeup_time",
         "offset": "-00:30"}, "value": 95},
    ],
}


def test_schedule_round_trips():
    sch = Schedule.from_dict(RAW)
    assert sch.id == "bed"
    assert sch.transitions[0].when.at == "20:00"
    assert sch.transitions[1].when.entity == "input_datetime.wakeup_time"
    assert sch.to_dict() == RAW


def test_transition_defaults_to_all_weekdays():
    sch = Schedule.from_dict({**RAW, "transitions": [
        {"id": "t1", "when": {"type": "time", "at": "06:00"}, "value": 1}]})
    assert sch.transitions[0].weekdays == WEEKDAYS


def test_empty_weekdays_preserved():
    raw = {**RAW, "transitions": [
        {"id": "t1", "when": {"type": "time", "at": "06:00"}, "value": 1, "weekdays": []}]}
    sch = Schedule.from_dict(raw)
    assert sch.transitions[0].weekdays == []
    assert sch.to_dict()["transitions"][0]["weekdays"] == []


def test_managed_flag_round_trips_and_defaults_off():
    managed = Schedule.from_dict({**RAW, "managed": True})
    assert managed.managed is True
    assert managed.to_dict()["managed"] is True

    plain = Schedule.from_dict(RAW)
    assert plain.managed is False
    assert "managed" not in plain.to_dict()  # omitted when False


def test_when_todict_fidelity_and_unknown_type_raises():
    assert When("time", at="20:00").to_dict() == {"type": "time", "at": "20:00"}
    assert When("anchor", entity="input_datetime.wakeup_time", offset="-00:30").to_dict() == {
        "type": "anchor", "entity": "input_datetime.wakeup_time", "offset": "-00:30"}
    with pytest.raises(ValueError):
        When("solar", at="06:00").to_dict()
