"""Config flow and config-entry lifecycle tests."""
from homeassistant.config_entries import SOURCE_USER
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.timeline_scheduler.const import DOMAIN

from .helpers import setup_integration


async def test_user_flow_creates_entry(hass):
    """The user step creates the single entry with no input required."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}
    )
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["title"] == "Timeline Scheduler"
    assert result["data"] == {}


async def test_single_instance_aborts_second_flow(hass):
    """A second setup attempt aborts because only one instance is allowed."""
    existing = MockConfigEntry(domain=DOMAIN, data={})
    existing.add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}
    )
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_setup_entry_runtime_then_unload(hass):
    """Setting up the entry wires runtime + services; unload tears runtime down."""
    entry = await setup_integration(hass)

    assert "store" in hass.data[DOMAIN]
    assert "manager" in hass.data[DOMAIN]
    assert hass.services.has_service(DOMAIN, "upsert_schedule")

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert DOMAIN not in hass.data
