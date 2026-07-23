"""Translate a scheduled value (a per-apply JSON object) into HA service calls.

Every transition value is a JSON object keyed to the schedule's apply type:
  switch_onoff        -> {"state": "on" | "off"}
  number_set          -> {"value": <number>}
  climate_temperature -> {"mode": <str | null>, "temp": <number | null>}
"""
from __future__ import annotations

from typing import Any

# (domain, service, service_data)
ServiceCall = tuple[str, str, dict]


def _num(value: Any) -> float | None:
    """Return value as a float, or None if it isn't numeric (bools excluded)."""
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def build_service_calls(
    apply_key: str,
    value: Any,
    target: dict,
    *,
    on_mode: str | None = None,
    current_mode: str | None = None,
) -> list[ServiceCall]:
    """Return the ordered service calls that realize ``value`` on the target.

    For climate, the mode is only (re)set when it differs from ``current_mode``
    (the climate entity's current hvac state), and always before the
    temperature — a unit that is off rejects a target temperature.
    """
    if not isinstance(value, dict):
        raise ValueError(f"{apply_key} value must be a JSON object, got {value!r}")
    entity_id = target["entity_id"]

    if apply_key == "switch_onoff":
        on = str(value.get("state", "")).strip().lower() == "on"
        return [("switch", "turn_on" if on else "turn_off", {"entity_id": entity_id})]

    if apply_key == "number_set":
        num = _num(value.get("value"))
        if num is None:
            raise ValueError(f"number_set needs a numeric 'value', got {value!r}")
        return [("number", "set_value", {"entity_id": entity_id, "value": num})]

    if apply_key == "climate_temperature":
        mode = value.get("mode")
        temp = _num(value.get("temp"))
        # A temperature with no explicit mode uses the schedule's on_mode to turn
        # the device on; a bare mode (e.g. "off") carries no temperature.
        target_mode = mode if mode is not None else (on_mode if temp is not None else None)
        calls: list[ServiceCall] = []
        if target_mode is not None and target_mode != current_mode:
            calls.append(
                ("climate", "set_hvac_mode",
                 {"entity_id": entity_id, "hvac_mode": target_mode})
            )
        if temp is not None and target_mode != "off":
            calls.append(
                ("climate", "set_temperature",
                 {"entity_id": entity_id, "temperature": temp})
            )
        return calls

    raise ValueError(f"Unknown apply mapping '{apply_key}'")


def format_display(apply_key: str, value: Any) -> Any:
    """A compact, human-readable rendering of a value for the current/next sensors."""
    if not isinstance(value, dict):
        return None
    if apply_key == "switch_onoff":
        return value.get("state")
    if apply_key == "number_set":
        return value.get("value")
    if apply_key == "climate_temperature":
        mode, temp = value.get("mode"), _num(value.get("temp"))
        parts: list[str] = []
        if mode:
            parts.append(str(mode))
        if temp is not None and mode != "off":
            parts.append(f"{_fmt_temp(temp)}°")
        return " ".join(parts) or None
    return None


def _fmt_temp(temp: float) -> str:
    return str(int(temp)) if temp == int(temp) else str(temp)
