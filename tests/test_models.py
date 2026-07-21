from custom_components.timeline_scheduler.models import Schedule, WEEKDAYS

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
