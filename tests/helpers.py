"""Shared test helpers."""
from __future__ import annotations

from homeassistant.config_entries import ConfigSubentryData
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.timeline_scheduler.const import DOMAIN, STORAGE_KEY, STORAGE_VERSION


async def setup_integration(hass) -> MockConfigEntry:
    """Set up the integration via a config entry (the supported setup path)."""
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def seed_store(hass_storage, *schedules: dict) -> None:
    """Pre-populate the schedule store on disk before setup."""
    hass_storage[STORAGE_KEY] = {
        "version": STORAGE_VERSION,
        "minor_version": 1,
        "key": STORAGE_KEY,
        "data": {"schedules": list(schedules)},
    }


async def setup_with_subentries(hass, *subentries: tuple[str, str]) -> MockConfigEntry:
    """Set up the entry with schedule subentries; each arg is (schedule_id, title)."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={},
        subentries_data=[
            ConfigSubentryData(
                data={"schedule_id": sid, "rev": 0},
                subentry_type="schedule",
                title=title,
                unique_id=None,
            )
            for sid, title in subentries
        ],
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
