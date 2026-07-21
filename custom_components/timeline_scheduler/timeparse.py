"""Parsing helpers for wall-clock times and signed offsets."""
from __future__ import annotations

from datetime import time, timedelta


def parse_hhmm(value: str) -> time:
    parts = value.split(":")
    if len(parts) == 2:
        h, m, s = parts[0], parts[1], "0"
    elif len(parts) == 3:
        h, m, s = parts
    else:
        raise ValueError(f"Invalid time '{value}', expected HH:MM[:SS]")
    try:
        hi, mi, si = int(h), int(m), int(s)
    except ValueError as err:
        raise ValueError(f"Invalid time '{value}'") from err
    if not (0 <= hi < 24 and 0 <= mi < 60 and 0 <= si < 60):
        raise ValueError(f"Time out of range: '{value}'")
    return time(hour=hi, minute=mi, second=si)


def parse_offset(value: str) -> timedelta:
    v = value.strip()
    sign = 1
    if v[:1] in ("+", "-"):
        sign = -1 if v[0] == "-" else 1
        v = v[1:]
    parts = v.split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid offset '{value}', expected ±HH:MM")
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError as err:
        raise ValueError(f"Invalid offset '{value}'") from err
    if not (0 <= m < 60):
        raise ValueError(f"Offset minutes out of range: '{value}'")
    return sign * timedelta(hours=h, minutes=m)
