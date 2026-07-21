from datetime import time, timedelta

import pytest

from custom_components.timeline_scheduler.timeparse import parse_hhmm, parse_offset


def test_parse_hhmm():
    assert parse_hhmm("20:00") == time(20, 0)
    assert parse_hhmm("06:30:15") == time(6, 30, 15)


@pytest.mark.parametrize("bad", ["24:00", "12:60", "nope", "1:2:3:4"])
def test_parse_hhmm_rejects_bad(bad):
    with pytest.raises(ValueError):
        parse_hhmm(bad)


def test_parse_offset_signed():
    assert parse_offset("-00:30") == timedelta(minutes=-30)
    assert parse_offset("+01:15") == timedelta(hours=1, minutes=15)
    assert parse_offset("02:00") == timedelta(hours=2)
