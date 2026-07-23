import pytest

from custom_components.timeline_scheduler.actions import (
    build_service_calls,
    format_display,
)

CLIMATE = {"entity_id": "climate.bed"}


def test_switch_onoff():
    assert build_service_calls("switch_onoff", {"state": "on"}, {"entity_id": "switch.shed"}) == [
        ("switch", "turn_on", {"entity_id": "switch.shed"})
    ]
    assert build_service_calls("switch_onoff", {"state": "off"}, {"entity_id": "switch.shed"}) == [
        ("switch", "turn_off", {"entity_id": "switch.shed"})
    ]


def test_number_set():
    assert build_service_calls("number_set", {"value": 5}, {"entity_id": "number.x"}) == [
        ("number", "set_value", {"entity_id": "number.x", "value": 5.0})
    ]


def test_climate_temp_only_turns_on_using_on_mode_when_off():
    """A temperature-only setpoint sets on_mode (device is off), then the temp."""
    calls = build_service_calls(
        "climate_temperature", {"mode": None, "temp": 72}, CLIMATE,
        on_mode="heat", current_mode="off",
    )
    assert calls == [
        ("climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "heat"}),
        ("climate", "set_temperature", {"entity_id": "climate.bed", "temperature": 72.0}),
    ]


def test_climate_mode_not_reset_when_already_matches():
    """If the device is already in the target mode, only the temperature is sent."""
    calls = build_service_calls(
        "climate_temperature", {"mode": None, "temp": 72}, CLIMATE,
        on_mode="heat", current_mode="heat",
    )
    assert calls == [
        ("climate", "set_temperature", {"entity_id": "climate.bed", "temperature": 72.0}),
    ]


def test_climate_explicit_mode_and_temp():
    """An explicit per-setpoint mode is applied (mode differs), then the temp."""
    calls = build_service_calls(
        "climate_temperature", {"mode": "cool", "temp": 68}, CLIMATE,
        on_mode="heat", current_mode="heat",
    )
    assert calls == [
        ("climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "cool"}),
        ("climate", "set_temperature", {"entity_id": "climate.bed", "temperature": 68.0}),
    ]


def test_climate_mode_only_off_has_no_temperature():
    """A mode-only 'off' setpoint sets the mode and never a temperature."""
    calls = build_service_calls(
        "climate_temperature", {"mode": "off", "temp": None}, CLIMATE,
        current_mode="heat",
    )
    assert calls == [
        ("climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "off"}),
    ]


def test_climate_off_ignores_temperature():
    """Even if a temp sneaks into an 'off' setpoint, we don't push it at an off unit."""
    calls = build_service_calls(
        "climate_temperature", {"mode": "off", "temp": 72}, CLIMATE,
        current_mode="heat",
    )
    assert calls == [
        ("climate", "set_hvac_mode", {"entity_id": "climate.bed", "hvac_mode": "off"}),
    ]


def test_non_dict_value_raises():
    with pytest.raises(ValueError):
        build_service_calls("climate_temperature", 72, CLIMATE)


def test_unknown_mapping_raises():
    with pytest.raises(ValueError):
        build_service_calls("nope", {"value": 1}, CLIMATE)


def test_format_display():
    assert format_display("switch_onoff", {"state": "on"}) == "on"
    assert format_display("number_set", {"value": 21}) == 21
    assert format_display("climate_temperature", {"mode": "heat", "temp": 72}) == "heat 72°"
    assert format_display("climate_temperature", {"mode": None, "temp": 72}) == "72°"
    assert format_display("climate_temperature", {"mode": "off", "temp": None}) == "off"
    assert format_display("climate_temperature", None) is None
