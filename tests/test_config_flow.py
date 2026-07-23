"""Config flow and config-entry lifecycle tests."""
from homeassistant.config_entries import (
    SOURCE_RECONFIGURE,
    SOURCE_USER,
)
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.timeline_scheduler.const import DOMAIN, SCHEDULE_SUBENTRY_TYPE

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


async def _add_schedule(hass, entry, name="Bed", target="climate.bed",
                        apply="climate_temperature", enabled=True, on_mode="heat"):
    result = await hass.config_entries.subentries.async_init(
        (entry.entry_id, SCHEDULE_SUBENTRY_TYPE), context={"source": SOURCE_USER}
    )
    assert result["type"] == FlowResultType.FORM
    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"],
        {"name": name, "target": target, "apply": apply, "enabled": enabled},
    )
    # climate_temperature requires a second step for the required on_mode.
    if result["type"] == FlowResultType.FORM:
        assert result["step_id"] == "on_mode"
        result = await hass.config_entries.subentries.async_configure(
            result["flow_id"], {"on_mode": on_mode}
        )
    await hass.async_block_till_done()
    return result


async def test_add_schedule_subentry_creates_managed_schedule(hass):
    entry = await setup_integration(hass)
    result = await _add_schedule(hass, entry, on_mode="heat")
    assert result["type"] == FlowResultType.CREATE_ENTRY

    store = hass.data[DOMAIN]["store"]
    sch = store.get("bed")
    assert sch is not None
    assert sch.managed is True
    assert sch.name == "Bed"
    assert sch.target == {"entity_id": "climate.bed"}
    assert sch.apply == "climate_temperature"
    assert sch.on_mode == "heat"
    assert sch.transitions == []


async def test_add_switch_schedule_skips_on_mode_step(hass):
    """Non-climate schedules are created in one step with no on_mode."""
    entry = await setup_integration(hass)
    result = await _add_schedule(
        hass, entry, name="Shed", target="switch.shed", apply="switch_onoff"
    )
    assert result["type"] == FlowResultType.CREATE_ENTRY
    sch = hass.data[DOMAIN]["store"].get("shed")
    assert sch is not None and sch.apply == "switch_onoff"
    assert sch.on_mode is None


async def test_add_schedule_slug_collision_gets_unique_id(hass):
    entry = await setup_integration(hass)
    await _add_schedule(hass, entry, name="Bed")
    await _add_schedule(hass, entry, name="Bed")
    store = hass.data[DOMAIN]["store"]
    assert store.get("bed") is not None
    assert store.get("bed_2") is not None


async def test_reconfigure_subentry_updates_schedule(hass):
    entry = await setup_integration(hass)
    await _add_schedule(hass, entry, name="Bed")
    subentry_id = next(iter(entry.subentries))

    result = await hass.config_entries.subentries.async_init(
        (entry.entry_id, SCHEDULE_SUBENTRY_TYPE),
        context={"source": SOURCE_RECONFIGURE, "subentry_id": subentry_id},
    )
    assert result["type"] == FlowResultType.FORM
    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"],
        {"name": "Main Bed", "target": "climate.other",
         "apply": "climate_temperature", "enabled": False},
    )
    # climate → required on_mode step
    assert result["type"] == FlowResultType.FORM and result["step_id"] == "on_mode"
    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"], {"on_mode": "cool"}
    )
    await hass.async_block_till_done()
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"

    store = hass.data[DOMAIN]["store"]
    sch = store.get("bed")
    assert sch.name == "Main Bed"
    assert sch.target == {"entity_id": "climate.other"}
    assert sch.enabled is False
    assert sch.on_mode == "cool"
    assert sch.managed is True  # preserved across reconfigure
