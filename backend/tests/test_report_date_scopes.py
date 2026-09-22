"""
Arabic: يغطي نطاقات التقرير المرنة الجديدة:
        (1) "daily"/"monthly" يبقيان بنفس السلوك السابق حرفياً (توافق خلفي).
        (2) "days"  : أيام متفرقة غير متتالية تُجمَع بتقرير واحد.
        (3) "range" : مدى من-إلى، ويجوز أن يعبر الشهور.
English: Covers the new flexible report scopes:
         (1) "daily"/"monthly" behave exactly as before (backwards compatibility).
         (2) "days"  : scattered, non-consecutive days combined into one report.
         (3) "range" : a from-to range, allowed to cross months.
"""

from datetime import datetime, timedelta

import pytest

from app.services.report_service import (
    MAX_RANGE_DAYS,
    _entries_for_days,
    _entries_for_scope,
    describe_period,
    resolve_report_days,
)

# Arabic: أرشيف مصغّر يغطي شهرين وسجلاً بلا id (حجز تفاؤلي يجب تجاهله).
# English: A miniature archive spanning two months plus a no-id record (an optimistic-lock
#          reservation stub that must be ignored).
ARCHIVE = {
    "a": {"id": 1, "date": "2026-09-01 10:00", "product_type": "shoes"},
    "b": {"id": 2, "date": "2026-09-05 11:00", "product_type": "watches"},
    "c": {"id": 3, "date": "2026-09-09 12:00", "product_type": "shoes"},
    "d": {"id": 4, "date": "2026-09-30 09:00", "product_type": "shoes"},
    "e": {"id": 5, "date": "2026-10-01 08:00", "product_type": "watches"},
    "f": {"id": 6, "date": "2026-10-02 08:00", "product_type": "shoes"},
    "stub": {"id": None, "date": "2026-09-05 11:30", "product_type": "shoes"},
}


def _ids(entries):
    return sorted(item["id"] for item in entries)


# ---------------------------------------------------------------- backwards compatibility

def test_daily_scope_is_unchanged():
    target = datetime(2026, 9, 5)
    assert _ids(_entries_for_scope(ARCHIVE, "daily", target)) == [2]


def test_monthly_scope_is_unchanged():
    target = datetime(2026, 9, 15)
    assert _ids(_entries_for_scope(ARCHIVE, "monthly", target)) == [1, 2, 3, 4]


def test_reservation_stubs_without_id_are_always_skipped():
    """Arabic: سجل بلا id لا يُحتسب بأي نطاق. English: A record with no id is never counted, in any scope."""
    assert _ids(_entries_for_days(ARCHIVE, ["2026-09-05"])) == [2]


# ---------------------------------------------------------------- new: scattered days

def test_days_scope_combines_non_consecutive_days():
    days = resolve_report_days("days", days=["2026-09-01", "2026-09-09", "2026-10-02"])
    assert days == ["2026-09-01", "2026-09-09", "2026-10-02"]
    assert _ids(_entries_for_days(ARCHIVE, days)) == [1, 3, 6]


def test_days_scope_deduplicates_sorts_and_drops_invalid():
    days = resolve_report_days(
        "days", days=["2026-09-09", "2026-09-01", "2026-09-09", "not-a-date", "", "05/09/2026"],
    )
    assert days == ["2026-09-01", "2026-09-09"]


def test_days_scope_matches_a_single_day_like_daily():
    """Arabic: يوم واحد عبر "days" يساوي تماماً نتيجة "daily". English: One day via "days" equals "daily" exactly."""
    via_days = _entries_for_days(ARCHIVE, resolve_report_days("days", days=["2026-09-05"]))
    via_daily = _entries_for_scope(ARCHIVE, "daily", datetime(2026, 9, 5))
    assert _ids(via_days) == _ids(via_daily) == [2]


# ---------------------------------------------------------------- new: custom range

def test_range_within_one_month():
    days = resolve_report_days("range", date_from="2026-09-01", date_to="2026-09-05")
    assert days == ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]
    assert _ids(_entries_for_days(ARCHIVE, days)) == [1, 2]


def test_range_may_cross_months():
    """Arabic: عبور الشهور مدعوم لأن التوليد يمشي يوماً بيوم. English: Crossing months works because generation walks day by day."""
    days = resolve_report_days("range", date_from="2026-09-30", date_to="2026-10-02")
    assert days == ["2026-09-30", "2026-10-01", "2026-10-02"]
    assert _ids(_entries_for_days(ARCHIVE, days)) == [4, 5, 6]


def test_range_with_reversed_dates_is_corrected():
    forward = resolve_report_days("range", date_from="2026-09-01", date_to="2026-09-03")
    reversed_ = resolve_report_days("range", date_from="2026-09-03", date_to="2026-09-01")
    assert forward == reversed_


def test_range_longer_than_the_cap_is_rejected():
    with pytest.raises(ValueError):
        resolve_report_days("range", date_from="2020-01-01", date_to="2026-01-01")


def test_range_exactly_at_the_cap_is_allowed():
    """Arabic: مدى بطول الحد بالضبط يمر، وأطول منه بيوم يُرفض. English: A range exactly at the cap passes; one day longer is rejected."""
    start = datetime(2026, 1, 1)
    at_cap = (start + timedelta(days=MAX_RANGE_DAYS)).strftime("%Y-%m-%d")
    assert len(resolve_report_days("range", date_from="2026-01-01", date_to=at_cap)) == MAX_RANGE_DAYS + 1

    over_cap = (start + timedelta(days=MAX_RANGE_DAYS + 1)).strftime("%Y-%m-%d")
    with pytest.raises(ValueError):
        resolve_report_days("range", date_from="2026-01-01", date_to=over_cap)


# ---------------------------------------------------------------- labels / filenames

@pytest.mark.parametrize(
    "scope,days,expected",
    [
        ("monthly", None, "2026-09"),
        ("daily", ["2026-09-05"], "2026-09-05"),
        ("range", ["2026-09-30", "2026-10-01", "2026-10-02"], "2026-09-30_to_2026-10-02"),
        ("days", ["2026-09-01", "2026-09-09", "2026-10-02"], "2026-09-01_plus_2more"),
    ],
)
def test_period_labels(scope, days, expected):
    assert describe_period(scope, days, datetime(2026, 9, 15)) == expected


def test_period_labels_contain_no_path_separators():
    """Arabic: التسمية تدخل باسم الملف، فيجب ألا تحوي فواصل مسار. English: The label goes into a filename, so it must carry no path separators."""
    for scope, days in (
        ("range", ["2026-09-30", "2026-10-02"]),
        ("days", ["2026-09-01", "2026-09-09"]),
        ("monthly", None),
    ):
        label = describe_period(scope, days, datetime(2026, 9, 15))
        assert "/" not in label and "\\" not in label and ".." not in label
