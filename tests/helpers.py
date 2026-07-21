"""Shared test helpers."""
from __future__ import annotations

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.timeline_scheduler.const import DOMAIN


async def setup_integration(hass) -> MockConfigEntry:
    """Set up the integration via a config entry (the supported setup path)."""
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
