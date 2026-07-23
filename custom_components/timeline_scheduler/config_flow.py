"""Config flow for Timeline Scheduler.

Top-level flow: single input-free entry (makes the integration appear under
Add Integration). Schedules are created as config *subentries* of that entry —
each "Add Schedule" writes a `managed` schedule to the store; the parent entry
reloads (via its update listener) so the per-schedule switch/sensor appear.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
    ConfigSubentryFlow,
    SubentryFlowResult,
)
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.util import slugify

from .const import DOMAIN, SCHEDULE_SUBENTRY_TYPE
from .models import Schedule

# climate_temperature covers HVAC modes too (a non-numeric setpoint value maps
# to set_hvac_mode), so a dedicated climate_hvac_mode apply type is redundant.
APPLY_OPTIONS = ["switch_onoff", "climate_temperature", "number_set"]
CLIMATE_APPLY = "climate_temperature"
# Fallback when the target climate entity doesn't advertise its hvac_modes.
DEFAULT_ON_MODES = ["heat", "cool", "heat_cool", "auto", "dry", "fan_only"]


def _schedule_schema() -> vol.Schema:
    return vol.Schema(
        {
            vol.Required("name"): selector.TextSelector(),
            vol.Required("target"): selector.EntitySelector(),
            vol.Required("apply"): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=APPLY_OPTIONS, translation_key="apply"
                )
            ),
            vol.Required("enabled", default=True): selector.BooleanSelector(),
        }
    )


def _on_mode_schema(options: list[str]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required("on_mode"): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=options,
                    custom_value=True,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                    translation_key="on_mode",
                )
            ),
        }
    )


def _unique_slug(store, name: str) -> str:
    base = slugify(name) or "schedule"
    sid = base
    n = 2
    while store.get(sid) is not None:
        sid = f"{base}_{n}"
        n += 1
    return sid


class TimelineSchedulerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the (input-free) setup flow for Timeline Scheduler."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Create the single config entry, or abort if already configured."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        return self.async_create_entry(title="Timeline Scheduler", data={})

    @classmethod
    @callback
    def async_get_supported_subentry_types(
        cls, config_entry
    ) -> dict[str, type[ConfigSubentryFlow]]:
        return {SCHEDULE_SUBENTRY_TYPE: ScheduleSubentryFlowHandler}


class ScheduleSubentryFlowHandler(ConfigSubentryFlow):
    """Create/edit one schedule (a subentry of the integration entry).

    climate_temperature schedules require an ``on_mode`` (the hvac mode used to
    turn the device on for a temperature-only setpoint), collected in a second
    step so its options can come from the chosen entity's ``hvac_modes``.
    """

    _base: dict[str, Any] | None = None
    _reconf: dict[str, Any] | None = None  # set only when reconfiguring

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Add a new schedule."""
        if DOMAIN not in self.hass.data:
            return self.async_abort(reason="entry_not_loaded")
        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=_schedule_schema())
        self._base, self._reconf = user_input, None
        if user_input["apply"] == CLIMATE_APPLY:
            return self._show_on_mode()
        return await self._save()

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Edit an existing schedule's metadata (timeline is edited in the card)."""
        if DOMAIN not in self.hass.data:
            return self.async_abort(reason="entry_not_loaded")
        subentry = self._get_reconfigure_subentry()
        sid = subentry.data["schedule_id"]
        store = self.hass.data[DOMAIN]["store"]
        existing = store.get(sid)

        if user_input is None:
            suggested = {
                "name": existing.name if existing else subentry.title,
                "target": existing.target.get("entity_id") if existing else "",
                "apply": existing.apply if existing else APPLY_OPTIONS[0],
                "enabled": existing.enabled if existing else True,
            }
            return self.async_show_form(
                step_id="reconfigure",
                data_schema=self.add_suggested_values_to_schema(
                    _schedule_schema(), suggested
                ),
            )

        self._base = user_input
        self._reconf = {
            "sid": sid,
            "transitions": existing.transitions if existing else [],
            "on_mode": existing.on_mode if existing else None,
        }
        if user_input["apply"] == CLIMATE_APPLY:
            return self._show_on_mode(suggested={"on_mode": self._reconf["on_mode"]})
        return await self._save()

    async def async_step_on_mode(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Collect the required on_mode for a climate schedule, then save."""
        if user_input is None:
            return self._show_on_mode()
        self._base = {**(self._base or {}), "on_mode": user_input["on_mode"]}
        return await self._save()

    def _show_on_mode(self, suggested: dict | None = None) -> SubentryFlowResult:
        options = self._on_mode_options((self._base or {}).get("target"))
        schema = _on_mode_schema(options)
        if suggested and suggested.get("on_mode"):
            schema = self.add_suggested_values_to_schema(schema, suggested)
        return self.async_show_form(step_id="on_mode", data_schema=schema)

    def _on_mode_options(self, entity_id: str | None) -> list[str]:
        st = self.hass.states.get(entity_id) if entity_id else None
        modes = list(st.attributes.get("hvac_modes", [])) if st else []
        modes = [m for m in modes if m and m != "off"]
        return modes or DEFAULT_ON_MODES

    async def _save(self) -> SubentryFlowResult:
        base = self._base or {}
        store = self.hass.data[DOMAIN]["store"]
        on_mode = base.get("on_mode")
        if self._reconf is None:
            sid = _unique_slug(store, base["name"])
            schedule = Schedule(
                id=sid,
                name=base["name"],
                target={"entity_id": base["target"]},
                apply=base["apply"],
                transitions=[],
                enabled=base["enabled"],
                on_mode=on_mode,
                managed=True,
            )
            await store.async_upsert(schedule)
            # rev is a change nonce so every reconfigure registers as a subentry
            # change and fires the entry's reload listener.
            return self.async_create_entry(
                title=base["name"], data={"schedule_id": sid, "rev": 0}
            )

        sid = self._reconf["sid"]
        updated = Schedule(
            id=sid,
            name=base["name"],
            target={"entity_id": base["target"]},
            apply=base["apply"],
            transitions=self._reconf["transitions"],
            enabled=base["enabled"],
            on_mode=on_mode,
            managed=True,
        )
        await store.async_upsert(updated)
        entry = self._get_entry()
        subentry = self._get_reconfigure_subentry()
        return self.async_update_and_abort(
            entry,
            subentry,
            title=base["name"],
            data={"schedule_id": sid, "rev": subentry.data.get("rev", 0) + 1},
        )
