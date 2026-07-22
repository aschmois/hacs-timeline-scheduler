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
    """Create/edit one schedule (a subentry of the integration entry)."""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Add a new schedule."""
        if DOMAIN not in self.hass.data:
            return self.async_abort(reason="entry_not_loaded")
        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=_schedule_schema())

        store = self.hass.data[DOMAIN]["store"]
        sid = _unique_slug(store, user_input["name"])
        schedule = Schedule(
            id=sid,
            name=user_input["name"],
            target={"entity_id": user_input["target"]},
            apply=user_input["apply"],
            transitions=[],
            enabled=user_input["enabled"],
            managed=True,
        )
        await store.async_upsert(schedule)
        # rev is a change nonce so every reconfigure registers as a subentry
        # change and fires the entry's reload listener.
        return self.async_create_entry(
            title=user_input["name"], data={"schedule_id": sid, "rev": 0}
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Edit an existing schedule's metadata (timeline is edited in the card)."""
        if DOMAIN not in self.hass.data:
            return self.async_abort(reason="entry_not_loaded")
        entry = self._get_entry()
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

        transitions = existing.transitions if existing else []
        updated = Schedule(
            id=sid,
            name=user_input["name"],
            target={"entity_id": user_input["target"]},
            apply=user_input["apply"],
            transitions=transitions,
            enabled=user_input["enabled"],
            managed=True,
        )
        await store.async_upsert(updated)
        return self.async_update_and_abort(
            entry,
            subentry,
            title=user_input["name"],
            data={"schedule_id": sid, "rev": subentry.data.get("rev", 0) + 1},
        )
