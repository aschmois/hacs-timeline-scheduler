"""Tests that the integration registers the card static path and frontend URL."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant.setup import async_setup_component

from custom_components.timeline_scheduler.const import DOMAIN

CARD_URL = "/timeline_scheduler/timeline-scheduler-card.js"


async def test_setup_registers_card_static_path(hass):
    """Integration setup registers the card URL in frontend extra module URLs."""
    # Patch hass.http so async_register_static_paths works without a real server
    mock_http = MagicMock()
    mock_http.async_register_static_paths = AsyncMock()

    # Track calls to add_extra_js_url
    registered_urls: list[str] = []

    def _fake_add_extra_js_url(_hass, url, es5=False):
        registered_urls.append(url)

    with (
        patch.object(hass, "http", mock_http),
        patch(
            "custom_components.timeline_scheduler.add_extra_js_url",
            side_effect=_fake_add_extra_js_url,
        ),
    ):
        assert await async_setup_component(hass, DOMAIN, {DOMAIN: {}})
        await hass.async_block_till_done()

    # Verify static path was registered with the correct URL
    assert mock_http.async_register_static_paths.called, (
        "async_register_static_paths was not called"
    )
    call_args = mock_http.async_register_static_paths.call_args
    configs = call_args[0][0]  # first positional arg is the list of StaticPathConfig
    registered_paths = [c.url_path for c in configs]
    assert CARD_URL in registered_paths, (
        f"Card URL {CARD_URL!r} not in registered static paths: {registered_paths}"
    )

    # Verify frontend extra JS URL was registered
    assert CARD_URL in registered_urls, (
        f"Card URL {CARD_URL!r} not in registered frontend URLs: {registered_urls}"
    )
