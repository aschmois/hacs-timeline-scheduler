"""Resolve a schedule's transitions to concrete datetimes and pick active/next."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta

from .models import WEEKDAYS, Schedule, Transition
from .timeparse import parse_hhmm, parse_offset


@dataclass
class ResolvedTransition:
    when_dt: datetime
    transition: Transition


def _weekday_key(d) -> str:
    return WEEKDAYS[d.weekday()]


def _resolve_one(transition: Transition, day, tzinfo, anchor_lookup) -> datetime | None:
    """Concrete datetime for this transition on schedule-day `day`, or None."""
    w = transition.when
    if w.type == "time":
        return datetime.combine(day, parse_hhmm(w.at), tzinfo=tzinfo)
    if w.type == "anchor":
        anchor_time: time | None = anchor_lookup(w.entity)
        if anchor_time is None:
            return None
        base = datetime.combine(day, anchor_time, tzinfo=tzinfo)
        return base + parse_offset(w.offset or "+00:00")
    raise ValueError(f"Unknown when.type '{w.type}'")


def _build_occurrences(schedule: Schedule, now: datetime, anchor_lookup):
    tz = now.tzinfo
    occ: list[ResolvedTransition] = []
    # Look at yesterday/today/tomorrow so held values and next changes are found
    # regardless of midnight crossings and negative anchor offsets.
    for delta in (-1, 0, 1):
        day = (now + timedelta(days=delta)).date()
        for tr in schedule.transitions:
            if _weekday_key(day) not in tr.weekdays:
                continue
            dt = _resolve_one(tr, day, tz, anchor_lookup)
            if dt is not None:
                occ.append(ResolvedTransition(dt, tr))
    occ.sort(key=lambda r: r.when_dt)
    return occ


def _has_today_occurrences(schedule: Schedule, now: datetime, anchor_lookup) -> bool:
    """Return True if any transition resolves to a datetime on today's date."""
    tz = now.tzinfo
    today = now.date()
    for tr in schedule.transitions:
        if _weekday_key(today) not in tr.weekdays:
            continue
        dt = _resolve_one(tr, today, tz, anchor_lookup)
        if dt is not None:
            return True
    return False


def active_and_next(schedule: Schedule, now: datetime, anchor_lookup):
    """Return (active, next). active = latest occurrence at/before now; next = first after.

    Carry-over from yesterday is only applied when the schedule is also active today
    (has at least one resolvable transition for today's weekday). This prevents a
    weekend-only transition from incorrectly appearing active on a weekday.
    """
    occ = _build_occurrences(schedule, now, anchor_lookup)
    today_has_occ = _has_today_occurrences(schedule, now, anchor_lookup)
    active: ResolvedTransition | None = None
    nxt: ResolvedTransition | None = None
    for r in occ:
        if r.when_dt <= now:
            # Only carry over from yesterday if today has applicable transitions
            if r.when_dt.date() < now.date() and not today_has_occ:
                continue
            active = r  # keep advancing; equal timestamps -> later in list wins
        else:
            nxt = r
            break
    return active, nxt
