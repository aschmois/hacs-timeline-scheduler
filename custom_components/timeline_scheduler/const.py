"""Constants for the Timeline Scheduler integration."""

DOMAIN = "timeline_scheduler"
STORAGE_KEY = "timeline_scheduler"
STORAGE_VERSION = 1

# Config subentry type for a single schedule ("Add Schedule" in the UI).
SCHEDULE_SUBENTRY_TYPE = "schedule"


def schedule_updated_signal(sid: str) -> str:
    """Dispatcher signal fired when a schedule's live state changes."""
    return f"{DOMAIN}_schedule_updated_{sid}"
