"""Shared test fixtures."""
import pytest


@pytest.fixture(autouse=True)
def _enable_custom_integrations(enable_custom_integrations):
    """Allow HA to load the custom integration in tests."""
    yield
