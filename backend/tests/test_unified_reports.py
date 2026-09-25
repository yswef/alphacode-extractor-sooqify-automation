"""
Arabic: يغطي التقرير الموحَّد (إضافة AlphaCode + تطبيق محدّث الصور):
        (1) وحدات العمل لا تُسرّب أبداً لجداول "المنتجات" — النطاقات الأربعة تبقى حرفياً.
        (2) التفصيل حسب المصدر وحسب المستخدم×المصدر يحسب الطرفين معاً.
        (3) كل نص عربي بالجداول الجديدة يمر بالتشكيل (U+FE70–U+FEFF)، وإلا طُبع مقلوباً.
        (4) ربط الهوية بين أبجديتين لا يحدث إلا بخريطة صريحة — لا يُخمَّن.
English: Covers the unified report (AlphaCode extension + Sooqify Image Updater):
         (1) work units never leak into the "product" tables - all four scopes stay literal.
         (2) the by-source and by-user x source breakdowns count both sides together.
         (3) every Arabic string in the new tables goes through shaping (U+FE70-U+FEFF),
             otherwise it prints reversed.
         (4) cross-alphabet identity linking only happens via the explicit map - never guessed.
"""

import json
from datetime import datetime

import pytest

from app.services import report_service as rs
from app.services import work_units as wu
from app.services.report_identity import (
    load_identity_map,
    normalize_identity,
    resolve_identity,
)

ARABIC_PRESENTATION_FORMS = range(0xFE70, 0xFF00)


def _is_shaped(text):
    """Arabic: هل النص مرّ بالتشكيل فعلاً؟ English: Did the text actually go through shaping?"""
    return any(ord(ch) in ARABIC_PRESENTATION_FORMS for ch in str(text))


# Arabic: أرشيف مختلط: منتجات إضافة + وحدات عمل من تطبيق المصممة، بنفس الأيام.
# English: A mixed archive: extension products + designer-app work units, on the same days.
def _mixed_archive():
    unit_one = wu.make_work_unit(
        source=wu.SOURCE_IMAGE_UPDATER, user="يوسف", date="2026-09-22",
        item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="SC-100", quantity=5,
        timestamp="2026-09-22 10:00:00",
    )
    unit_two = wu.make_work_unit(
        source=wu.SOURCE_IMAGE_UPDATER, user="معتز", date="2026-09-22",
        item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="SC-101", quantity=3,
        timestamp="2026-09-22 11:00:00",
    )
    unit_failed = wu.make_work_unit(
        source=wu.SOURCE_IMAGE_UPDATER, user="معتز", date="2026-09-22",
        item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="SC-102",
        status=wu.STATUS_FAILED, quantity=0, timestamp="2026-09-22 11:30:00",
    )
    unit_other_day = wu.make_work_unit(
        source=wu.SOURCE_IMAGE_UPDATER, user="يوسف", date="2026-09-23",
        item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="SC-103", quantity=2,
    )
    return {
        "p1": {"id": 1, "date": "2026-09-22 09:00", "product_type": "shoes", "added_by": "معتز"},
        "p2": {"id": 2, "date": "2026-09-22 09:30", "product_type": "watches", "added_by": "يوسف"},
        "p3": {"id": 3, "date": "2026-09-23 09:30", "product_type": "shoes", "added_by": "معتز"},
        wu.work_unit_key(unit_one): unit_one,
        wu.work_unit_key(unit_two): unit_two,
        wu.work_unit_key(unit_failed): unit_failed,
        wu.work_unit_key(unit_other_day): unit_other_day,
    }


# ------------------------------------------------- (1) no leakage into product tables

def test_work_units_never_appear_in_product_entries():
    """
    Arabic: العيب الذي يحرس هذا الاختبار: لو سُرّبت وحدات العمل لقائمة المنتجات لتضخّم
            "إجمالي المنتجات" وعُدّ عمل تعديل الصور كإضافة منتجات جديدة.
    English: The defect this guards: leaking work units into the product list would inflate
             "total products" and count image-editing work as newly added products.
    """
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, ["2026-09-22"])
    assert sorted(item["id"] for item in entries) == [1, 2]
    assert not any(wu.is_work_unit(item) for item in entries)


@pytest.mark.parametrize("scope,kwargs,expected_ids", [
    ("daily", {"days": ["2026-09-22"]}, [1, 2]),
    ("days", {"days": ["2026-09-22", "2026-09-23"]}, [1, 2, 3]),
])
def test_existing_scopes_unchanged_by_work_units(scope, kwargs, expected_ids):
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, kwargs["days"])
    assert sorted(item["id"] for item in entries) == expected_ids


def test_monthly_scope_unchanged_by_work_units():
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, None, month_prefix="2026-09")
    assert sorted(item["id"] for item in entries) == [1, 2, 3]


def test_per_user_table_ignores_work_units_entirely():
    """Arabic: جدول "حسب المستخدم" القديم يبقى على المنتجات وحدها. English: The old per-user table stays on products alone."""
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, ["2026-09-22"])
    table = rs._build_per_user_table(entries)
    totals = [int(row[1]) for row in table._cellvalues[1:]]
    assert sum(totals) == 2  # Arabic: منتجان فقط. English: two products only.


# ------------------------------------------------- (2) unified counting

def test_work_units_are_collected_for_the_same_scope():
    archive = _mixed_archive()
    units = rs._work_units_for_days(archive, ["2026-09-22"])
    assert sorted(u["item_id"] for u in units) == ["SC-100", "SC-101", "SC-102"]


def test_unified_units_combine_both_sources_and_drop_failures():
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, ["2026-09-22"])
    unit_entries = rs._work_units_for_days(archive, ["2026-09-22"])
    units = rs.unified_units(entries, unit_entries, {})

    by_source = {}
    for unit in units:
        by_source[unit["source"]] = by_source.get(unit["source"], 0) + 1
    # Arabic: منتجان من الإضافة + وحدتان منجزتان من التطبيق (الفاشلة لا تُحتسب).
    # English: two extension products + two completed app units (the failed one is not counted).
    assert by_source == {wu.SOURCE_EXTENSION: 2, wu.SOURCE_IMAGE_UPDATER: 2}


def test_per_source_table_totals_match_the_unit_count():
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, ["2026-09-22"])
    units = rs.unified_units(entries, rs._work_units_for_days(archive, ["2026-09-22"]), {})
    table = rs._build_per_source_table(units)
    rows = table._cellvalues
    # Arabic: الصف الأخير هو الإجمالي. English: the last row is the total.
    assert rows[-1][2] == "4"
    assert rows[-1][3] == "2"  # Arabic: مستخدمان مميّزان. English: two distinct users.


def test_per_user_source_table_splits_each_user_across_sources():
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, ["2026-09-22"])
    units = rs.unified_units(entries, rs._work_units_for_days(archive, ["2026-09-22"]), {})
    table = rs._build_per_user_source_table(units)
    header, *rows = table._cellvalues
    # Arabic: عمودان للمصدرين + عمودا الاسم والإجمالي.
    # English: two source columns plus the name and total columns.
    assert len(header) == 4
    per_user = {row[0]: row[1:] for row in rows}
    assert sorted(per_user.values()) == [["2", "1", "1"], ["2", "1", "1"]]
    assert all(int(values[0]) == int(values[1]) + int(values[2]) for values in per_user.values())


def test_failed_units_are_recorded_but_never_counted():
    unit = wu.make_work_unit(
        source=wu.SOURCE_IMAGE_UPDATER, user="معتز", date="2026-09-22",
        item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="X", status=wu.STATUS_FAILED,
    )
    assert rs.unified_units([], [unit], {}) == []


# ------------------------------------------------- (3) Arabic shaping in the new tables

@pytest.mark.skipif(not rs._ARABIC_SUPPORT, reason="Arabic shaping stack unavailable")
def test_every_arabic_cell_in_the_new_tables_is_shaped():
    """
    Arabic: العيب الذي يحرسه: خلية عربية واحدة لا تمر بـ_rtl تُطبع مقلوبة ("يوسف" -> "فسوي").
            هنا نتحقق من **كل** خلية عربية بالجدولين الجديدين، لا من الأسماء فقط.
    English: The defect this guards: one Arabic cell that skips _rtl prints reversed
             ("يوسف" -> "فسوي"). Here every Arabic cell in both new tables is checked, not
             just the names.
    """
    archive = _mixed_archive()
    entries = rs._entries_for_days(archive, ["2026-09-22"])
    units = rs.unified_units(entries, rs._work_units_for_days(archive, ["2026-09-22"]), {})

    for table in (rs._build_per_source_table(units), rs._build_per_user_source_table(units)):
        for row in table._cellvalues:
            for cell in row:
                text = str(cell)
                has_raw_arabic_letters = any(0x0620 <= ord(ch) <= 0x064A for ch in text)
                assert not has_raw_arabic_letters, (
                    f"cell {text!r} carries unshaped Arabic - it will render reversed in the PDF"
                )
                if any(ord(ch) > 0x5FF for ch in text):
                    assert _is_shaped(text), f"cell {text!r} was not shaped"


@pytest.mark.skipif(not rs._ARABIC_SUPPORT, reason="Arabic shaping stack unavailable")
def test_unknown_user_label_is_shaped_exactly_once():
    """
    Arabic: "غير محدد" كانت تُشكَّل مرتين بجدول "حسب المستخدم" (مرة عند التجميع ومرة عند
            العرض)، والمرور بـget_display مرتين يعيد عكس النص فيُطبع مقلوباً.
    English: "غير محدد" used to be shaped twice in the per-user table (once while grouping and
             once while rendering); going through get_display twice re-reverses the text, so it
             printed backwards.
    """
    entries = [{"id": 1, "date": "2026-09-22", "product_type": "shoes"}]  # no added_by
    table = rs._build_per_user_table(entries)
    label = table._cellvalues[1][0]
    assert label == rs._rtl("غير محدد")
    assert label != rs._rtl(rs._rtl("غير محدد"))


# ------------------------------------------------- (4) identity linking

def test_normalization_links_spelling_variants_within_one_alphabet():
    assert normalize_identity("  يوسف  ") == normalize_identity("يوسف")
    assert normalize_identity("مُعتـز") == normalize_identity("معتز")
    assert normalize_identity("Yousef") == normalize_identity("yousef")


def test_normalization_never_bridges_two_alphabets_on_its_own():
    """Arabic: "yousef" لا تُربط بـ"يوسف" تلقائياً - هذا هو الافتراض الذي مُنِع صراحةً. English: "yousef" is never auto-linked to "يوسف" - the very assumption that is forbidden."""
    assert normalize_identity("yousef") != normalize_identity("يوسف")
    assert resolve_identity("yousef", wu.SOURCE_IMAGE_UPDATER, {}) == "yousef"


def test_explicit_map_is_the_only_cross_alphabet_bridge(tmp_path):
    (tmp_path / "report_identities.json").write_text(
        json.dumps({"يوسف": ["yousef", "Yousef Alhamzy"]}, ensure_ascii=False),
        encoding="utf-8",
    )
    identity_map = load_identity_map(str(tmp_path))
    assert resolve_identity("yousef", wu.SOURCE_IMAGE_UPDATER, identity_map) == "يوسف"
    assert resolve_identity("Yousef Alhamzy", None, identity_map) == "يوسف"
    assert resolve_identity("يوسف", None, identity_map) == "يوسف"
    assert resolve_identity("معتز", None, identity_map) == "معتز"


def test_source_scoped_alias_wins_over_the_bare_alias(tmp_path):
    """Arabic: نفس النص قد يكون شخصين مختلفين بمصدرين مختلفين - المفتاح المُنطاق يفصلهما. English: The same text can be two different people in two sources - the scoped key separates them."""
    (tmp_path / "report_identities.json").write_text(
        json.dumps({"يوسف": ["image_updater:admin"], "معتز": ["admin"]}, ensure_ascii=False),
        encoding="utf-8",
    )
    identity_map = load_identity_map(str(tmp_path))
    assert resolve_identity("admin", wu.SOURCE_IMAGE_UPDATER, identity_map) == "يوسف"
    assert resolve_identity("admin", wu.SOURCE_EXTENSION, identity_map) == "معتز"


def test_missing_or_corrupt_identity_map_never_breaks_the_report(tmp_path):
    assert load_identity_map(str(tmp_path)) == {}
    (tmp_path / "report_identities.json").write_text("{not json", encoding="utf-8")
    assert load_identity_map(str(tmp_path)) == {}
    (tmp_path / "report_identities.json").write_text("[1,2,3]", encoding="utf-8")
    assert load_identity_map(str(tmp_path)) == {}


def test_identity_linking_merges_rows_in_the_unified_table(tmp_path):
    """Arabic: بعد الربط الصريح يظهر الشخص صفاً واحداً بعمودين. English: After explicit linking the person becomes one row with two columns."""
    (tmp_path / "report_identities.json").write_text(
        json.dumps({"يوسف": ["yousef"]}, ensure_ascii=False), encoding="utf-8",
    )
    identity_map = load_identity_map(str(tmp_path))
    unit = wu.make_work_unit(
        source=wu.SOURCE_IMAGE_UPDATER, user="yousef", date="2026-09-22",
        item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="SC-1",
    )
    product = {"id": 1, "date": "2026-09-22", "product_type": "shoes", "added_by": "يوسف"}

    unlinked = rs.unified_units([product], [unit], {})
    linked = rs.unified_units([product], [unit], identity_map)
    assert len({u["user"] for u in unlinked}) == 2
    assert len({u["user"] for u in linked}) == 1


# ------------------------------------------------- deterministic keys

def test_work_unit_key_is_deterministic_and_idempotent():
    """Arabic: نفس الوحدة تنتج نفس المفتاح، فإعادة الدفع تكتب فوق نفسها ولا تُحتسب مرتين. English: The same unit yields the same key, so re-pushing overwrites itself instead of double-counting."""
    def build():
        return wu.make_work_unit(
            source=wu.SOURCE_IMAGE_UPDATER, user="يوسف", date="2026-09-22",
            item_type=wu.ITEM_TYPE_IMAGES_UPDATED, item_id="SC-100",
        )
    assert wu.work_unit_key(build()) == wu.work_unit_key(build())
    assert not wu.work_unit_key(build()).startswith("_"), (
        "a '_' prefix would make sync_reconcile_full skip work units when pushing"
    )


def test_projection_leaves_the_stored_product_untouched():
    """Arabic: الإسقاط للقراءة فقط - الأرشيف لا يُكتب عليه. English: Projection is read-only - the archive is never written to."""
    product = {"id": 7, "date": "2026-09-22 08:00", "product_type": "shoes", "added_by": "معتز"}
    before = dict(product)
    projected = wu.project_product(product)
    assert product == before
    assert projected["source"] == wu.SOURCE_EXTENSION
    assert projected["item_type"] == wu.ITEM_TYPE_PRODUCT_ADDED
    assert projected["date"] == "2026-09-22"


def test_generate_report_writes_a_pdf_covering_both_sources(tmp_path):
    """Arabic: تحقق طرف-لطرف: التقرير يُبنى فعلياً وينتج ملف PDF غير فارغ. English: End-to-end: the report really builds and produces a non-empty PDF."""
    output = tmp_path / "reports" / "unified.pdf"
    rs.generate_report(
        _mixed_archive(), "days", str(output), datetime(2026, 9, 22),
        days=["2026-09-22"], identity_dir=str(tmp_path),
    )
    assert output.is_file() and output.stat().st_size > 1000
