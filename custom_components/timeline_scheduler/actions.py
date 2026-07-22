"""Translate a scheduled value into a Home Assistant service call."""
from __future__ import annotations

from typing import Any

_TRUEY = {"on", "true", "1", "yes"}


def _as_number(value: Any) -> float | None:
    """Return value as a float, or None if it isn't numeric."""
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def build_service_call(apply_key: str, value: Any, target: dict) -> tuple[str, str, dict]:
    entity_id = target["entity_id"]
    if apply_key == "switch_onoff":
        service = "turn_on" if str(value).strip().lower() in _TRUEY else "turn_off"
        return ("switch", service, {"entity_id": entity_id})
    if apply_key == "climate_temperature":
        # A non-numeric value is an HVAC mode (off/auto/heat/cool/...); a
        # numeric value is a target temperature.
        num = _as_number(value)
        if num is None:
            return ("climate", "set_hvac_mode",
                    {"entity_id": entity_id, "hvac_mode": str(value).strip().lower()})
        return ("climate", "set_temperature",
                {"entity_id": entity_id, "temperature": num})
    if apply_key == "climate_hvac_mode":
        return ("climate", "set_hvac_mode",
                {"entity_id": entity_id, "hvac_mode": str(value)})
    if apply_key == "number_set":
        return ("number", "set_value", {"entity_id": entity_id, "value": float(value)})
    raise ValueError(f"Unknown apply mapping '{apply_key}'")
