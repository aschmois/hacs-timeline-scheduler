import pytest

from custom_components.timeline_scheduler.actions import build_service_call

TARGET = {"entity_id": "climate.bed"}


def test_climate_temperature_number():
    assert build_service_call("climate_temperature", 80, TARGET) == (
        "climate", "set_temperature", {"entity_id": "climate.bed", "temperature": 80.0})


def test_climate_temperature_off():
    assert build_service_call("climate_temperature", "off", TARGET) == (
        "climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "off"})


def test_climate_temperature_mode_auto():
    assert build_service_call("climate_temperature", "auto", TARGET) == (
        "climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "auto"})


def test_climate_temperature_numeric_string_is_temperature():
    assert build_service_call("climate_temperature", "72", TARGET) == (
        "climate", "set_temperature", {"entity_id": "climate.bed", "temperature": 72.0})


def test_switch_onoff():
    assert build_service_call("switch_onoff", "on", {"entity_id": "switch.shed"}) == (
        "switch", "turn_on", {"entity_id": "switch.shed"})
    assert build_service_call("switch_onoff", "off", {"entity_id": "switch.shed"}) == (
        "switch", "turn_off", {"entity_id": "switch.shed"})


def test_number_set():
    assert build_service_call("number_set", 5, {"entity_id": "number.x"}) == (
        "number", "set_value", {"entity_id": "number.x", "value": 5.0})


def test_unknown_mapping_raises():
    with pytest.raises(ValueError):
        build_service_call("nope", 1, TARGET)
