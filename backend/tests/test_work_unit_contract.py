"""
Arabic: حارس العقد المشترك مع تطبيق محدّث الصور.

        `app/services/work_units.py` هنا و`app/work_log.py` بمستودع
        sooqify-image-updater يصفان **نفس** شكل وحدة العمل، لكنهما ملفان منفصلان
        بمستودعين منفصلين. لا توجد طريقة لاستيراد أحدهما من الآخر وقت التشغيل،
        فالتباعد ممكن بصمت - وتباعده يعني أن التطبيق يكتب مفاتيح لا يقرأها التقرير،
        فيختفي عمله من التقارير مرة أخرى (نفس العطب الذي عالجه هذا الفرع أصلاً).

        الحارس: بصمة sha256 للحقول المشتركة، **مثبَّتة بنفس القيمة بالملف النظير**.

English: Guard for the contract shared with the image-updater app.

         `app/services/work_units.py` here and `app/work_log.py` in the
         sooqify-image-updater repo describe the *same* work-unit shape, but they are
         separate files in separate repositories. Neither can import the other at
         runtime, so they can drift silently - and drift means the app writes keys the
         report does not read, so its work vanishes from reports again (the very defect
         this branch fixed).

         The guard: a sha256 fingerprint of the shared fields, pinned to the same value
         in the counterpart file.
"""

import hashlib
import json

from app.services import work_units as wu

# Arabic: ⚠️ هذه القيمة مكرَّرة عمداً بـ tests/test_work_unit_contract.py بمستودع
#         sooqify-image-updater. لا تُحدَّث بطرف واحد.
# English: Deliberately duplicated in tests/test_work_unit_contract.py in the
#          sooqify-image-updater repo. Never update it on one side only.
CONTRACT_FINGERPRINT = "a60d71e39cafe178"

DIVERGENCE_MESSAGE = (
    "The shared work-unit contract changed.\n"
    "It is shared with app/work_log.py in the sooqify-image-updater repo.\n"
    "Apply the same change there, then update CONTRACT_FINGERPRINT in BOTH test files.\n"
    "Leaving them mismatched means the app writes keys the report does not read, "
    "so its work disappears from every report."
)


def _contract_shape():
    """Arabic: الحقول التي يجب أن تتطابق حرفياً بين المستودعين. English: The fields that must match verbatim across both repos."""
    unit = wu.make_work_unit(
        wu.SOURCE_IMAGE_UPDATER, "u", "2026-01-01", wu.ITEM_TYPE_IMAGES_UPDATED, "x",
    )
    return {
        "record_kind_field": wu.RECORD_KIND_FIELD,
        "record_kind_value": wu.RECORD_KIND_WORK_UNIT,
        "schema_version": wu.SCHEMA_VERSION,
        "source_image_updater": wu.SOURCE_IMAGE_UPDATER,
        "item_type_images_updated": wu.ITEM_TYPE_IMAGES_UPDATED,
        "statuses": sorted([wu.STATUS_DONE, wu.STATUS_FAILED, wu.STATUS_SKIPPED]),
        "key_template": "WU::{source}::{item_type}::{item_id}::{date}",
        "unit_fields": sorted(unit.keys()),
    }


def _fingerprint(shape):
    return hashlib.sha256(
        json.dumps(shape, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]


def test_the_shared_contract_has_not_drifted():
    assert _fingerprint(_contract_shape()) == CONTRACT_FINGERPRINT, DIVERGENCE_MESSAGE


def test_the_contract_values_are_the_exact_strings_the_other_side_writes():
    """Arabic: تثبيت صريح للقيم، فيُقرأ سبب السقوط فوراً بدل بصمة مبهمة. English: Pin the values explicitly so a failure reads clearly instead of as an opaque hash."""
    shape = _contract_shape()
    assert shape["record_kind_field"] == "record_kind"
    assert shape["record_kind_value"] == "work_unit"
    assert shape["source_image_updater"] == "image_updater"
    assert shape["item_type_images_updated"] == "product_images_updated"
    assert shape["statuses"] == ["done", "failed", "skipped"]
    assert shape["schema_version"] == 1
    assert shape["unit_fields"] == [
        "date", "item_id", "item_type", "quantity", "record_kind",
        "schema_version", "source", "status", "timestamp", "user",
    ]


def test_the_key_format_matches_the_documented_template():
    unit = wu.make_work_unit(
        wu.SOURCE_IMAGE_UPDATER, "يوسف", "2026-09-22", wu.ITEM_TYPE_IMAGES_UPDATED, "SC-1",
    )
    assert wu.work_unit_key(unit) == "WU::image_updater::product_images_updated::SC-1::2026-09-22"


def test_a_unit_written_by_the_app_survives_a_full_json_round_trip():
    """
    Arabic: وحدة العمل تعبر sync.php كـJSON. لو حمل الشكل قيمة غير قابلة للتحويل
            لفشل الدفع بصمت عند أول وحدة حقيقية.
    English: A work unit travels through sync.php as JSON. A non-serializable value in
             the shape would fail the push silently on the first real unit.
    """
    unit = wu.make_work_unit(
        wu.SOURCE_IMAGE_UPDATER, "يوسف", "2026-09-22", wu.ITEM_TYPE_IMAGES_UPDATED,
        "SC-1", quantity=5, timestamp="2026-09-22 10:00:00",
    )
    assert json.loads(json.dumps(unit, ensure_ascii=False)) == unit
