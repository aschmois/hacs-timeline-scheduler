"""Config flow for Timeline Scheduler.

Single-instance flow: the integration takes no user configuration, so the
"user" step creates the one entry immediately (or aborts if one already
exists). This is what makes the integration appear under Settings →
Devices & Services → Add Integration.
"""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


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
