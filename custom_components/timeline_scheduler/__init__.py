"""Timeline Scheduler — setpoint/value schedules as a timeline of transitions.

This is a scaffold. The engine (transition resolution, anchor expansion, re-planning,
action mappings, entities, and the WebSocket CRUD API) is specified in ``docs/DESIGN.md``
and implemented in Phase 1. See the repository README for status.
"""

from __future__ import annotations

from .const import DOMAIN  # noqa: F401


async def async_setup(hass, config):
    """Set up the integration (stub — Phase 1 pending)."""
    return True
