"""Tests that the integration registers the card static path and makes it load.

The card is registered as a Lovelace *resource* (storage mode) so the frontend
loads it at runtime like a HACS plugin — robust against the companion app's
precached app-shell. When the storage resource collection is unavailable
(YAML resource mode, or Lovelace not set up) it falls back to
``add_extra_js_url``, which only injects the module into the server index.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.components.lovelace.const import LOVELACE_DATA
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.timeline_scheduler.const import DOMAIN

CARD_URL = "/timeline_scheduler/timeline-scheduler-card.js"


class _FakeResources:
    """Minimal stand-in for Lovelace's ResourceStorageCollection."""

    def __init__(self, items=None):
        self._items = list(items or [])
        self.created: list[dict] = []
        self.updated: list[tuple[str, dict]] = []
        self.deleted: list[str] = []

    async def async_get_info(self):
        return {"resources": len(self._items)}

    def async_items(self):
        return list(self._items)

    async def async_create_item(self, data):
        item = {"id": "res1", "type": data["res_type"], "url": data["url"]}
        self._items.append(item)
        self.created.append(data)
        return item

    async def async_update_item(self, item_id, updates):
        self.updated.append((item_id, updates))
        for it in self._items:
            if it["id"] == item_id:
                it.update(updates)
        return {}

    async def async_delete_item(self, item_id):
        self.deleted.append(item_id)
        self._items = [it for it in self._items if it["id"] != item_id]


def _mock_http():
    http = MagicMock()
    http.async_register_static_paths = AsyncMock()
    return http


async def _setup(hass, *, lovelace=None):
    """Set up the entry, returning (registered_extra_js_urls, http_mock)."""
    registered_urls: list[str] = []

    def _fake_add_extra_js_url(_hass, url, es5=False):
        registered_urls.append(url)

    if lovelace is not None:
        hass.data[LOVELACE_DATA] = lovelace

    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    http = _mock_http()
    with (
        patch.object(hass, "http", http),
        patch(
            "custom_components.timeline_scheduler.add_extra_js_url",
            side_effect=_fake_add_extra_js_url,
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return registered_urls, http


async def test_setup_registers_card_static_path(hass):
    """The card file is always served from a static path."""
    _, http = await _setup(hass)
    assert http.async_register_static_paths.called
    configs = http.async_register_static_paths.call_args[0][0]
    assert CARD_URL in [c.url_path for c in configs]


async def test_setup_registers_card_as_lovelace_resource(hass):
    """In storage mode the card is added as a module resource (not extra_js)."""
    resources = _FakeResources()
    lovelace = SimpleNamespace(resource_mode="storage", resources=resources)

    registered_urls, _ = await _setup(hass, lovelace=lovelace)

    assert len(resources.created) == 1, "card was not registered as a resource"
    created = resources.created[0]
    assert created["res_type"] == "module"
    assert created["url"].split("?")[0] == CARD_URL
    assert "?v=" in created["url"], "resource URL should carry a version cache-buster"
    # Must NOT also inject into the index — that would double-load the module.
    assert registered_urls == [], (
        f"add_extra_js_url should not be used in storage mode: {registered_urls}"
    )


async def test_resource_version_bumped_when_changed(hass):
    """An existing resource on a stale version is updated, not duplicated."""
    resources = _FakeResources(
        items=[{"id": "old", "type": "module", "url": f"{CARD_URL}?v=0.0.1"}]
    )
    lovelace = SimpleNamespace(resource_mode="storage", resources=resources)

    await _setup(hass, lovelace=lovelace)

    assert resources.created == [], "should update in place, not create a duplicate"
    assert len(resources.updated) == 1
    item_id, updates = resources.updated[0]
    assert item_id == "old"
    assert updates["url"].split("?")[0] == CARD_URL
    assert updates["url"] != f"{CARD_URL}?v=0.0.1"


async def test_resource_not_touched_when_current(hass):
    """If the resource already points at the current version, do nothing."""
    from custom_components.timeline_scheduler import async_get_integration

    integration = await async_get_integration(hass, DOMAIN)
    current = f"{CARD_URL}?v={integration.version}"
    resources = _FakeResources(
        items=[{"id": "cur", "type": "module", "url": current}]
    )
    lovelace = SimpleNamespace(resource_mode="storage", resources=resources)

    await _setup(hass, lovelace=lovelace)

    assert resources.created == []
    assert resources.updated == []


async def test_setup_falls_back_to_extra_js_without_lovelace(hass):
    """Without a storage resource collection, fall back to extra module URL."""
    # No LOVELACE_DATA in hass.data -> fallback path.
    registered_urls, _ = await _setup(hass)
    assert any(u.split("?")[0] == CARD_URL for u in registered_urls), (
        f"fallback did not register the card URL: {registered_urls}"
    )


async def test_setup_falls_back_in_yaml_resource_mode(hass):
    """YAML resource mode can't be written to -> fall back to extra module URL."""
    resources = _FakeResources()
    lovelace = SimpleNamespace(resource_mode="yaml", resources=resources)

    registered_urls, _ = await _setup(hass, lovelace=lovelace)

    assert resources.created == [], "must not write to a YAML resource collection"
    assert any(u.split("?")[0] == CARD_URL for u in registered_urls)


async def test_remove_entry_deletes_card_resource(hass):
    """Removing the integration cleans up the resource it registered."""
    from custom_components.timeline_scheduler import async_remove_entry

    resources = _FakeResources(
        items=[
            {"id": "ours", "type": "module", "url": f"{CARD_URL}?v=0.8.0"},
            {"id": "other", "type": "module", "url": "/hacsfiles/other/other.js"},
        ]
    )
    hass.data[LOVELACE_DATA] = SimpleNamespace(
        resource_mode="storage", resources=resources
    )
    entry = MockConfigEntry(domain=DOMAIN, data={})

    await async_remove_entry(hass, entry)

    assert resources.deleted == ["ours"]
    assert [it["id"] for it in resources.async_items()] == ["other"]
