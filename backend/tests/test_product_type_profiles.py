"""
Arabic: يضمن بقاء ملفات تعريف نوع المنتج مصدراً واحداً فعلياً:
        (1) تطابق تعريفات JS وPython حرفياً - أي تعديل بطرف دون الآخر يكسر الاختبار.
        (2) ثبات الصيغة الرياضية للسعر بعد الدمج (نفس نتائج ما قبل الدمج للمسارات الصحيحة).
        (3) الساعات بلا فئة فرعية، ولكل نوع خاصية خيارات صحيحة.
English: Keeps the product type profiles a genuinely single source:
         (1) the JS and Python definitions match verbatim - editing one side without the
             other fails this test.
         (2) the price formula is unchanged after the merge (same results as pre-merge for
             the paths that were already correct).
         (3) watches carry no subcategory, and each type gets the right variant attribute.
"""

import json
import re
from pathlib import Path

import pytest

from app.services.product_type_profiles import (
    PROFILES,
    compute_product_type_price,
    product_type_category_id,
    product_type_fee,
    product_type_label,
    product_type_sub_category_id,
    product_type_variant_attribute_id,
    product_type_variant_title,
    resolve_product_type,
)

JS_PROFILE_PATH = (
    Path(__file__).resolve().parents[2] / "extension" / "product_types.js"
)

SETTINGS = {
    "ExchangeRate": 0.5,
    "AddedFeeYuan": 250,
    "WatchFlatFeeYuan": 600,
    "CategoryId": 41,
    "SubCategoryId": 42,
    "WatchCategoryId": 46,
    "SizeAttributeId": 1,
    "SizeTitle": "الحجم",
    "WatchColorAttributeId": 2,
    "WatchColorTitle": "اللون",
}

# Arabic: خريطة أسماء المفاتيح بين النسختين (camelCase بالـJS، snake_case ببايثون).
# English: Key-name map between the two sides (camelCase in JS, snake_case in Python).
KEY_MAP = {
    "id": "id",
    "labelAr": "label_ar",
    "labelEn": "label_en",
    "icon": "icon",
    "feeSettingKey": "fee_setting_key",
    "feeFallback": "fee_fallback",
    "categorySettingKey": "category_setting_key",
    "categoryFallback": "category_fallback",
    "usesSubCategory": "uses_sub_category",
    "subCategorySettingKey": "sub_category_setting_key",
    "subCategoryFallback": "sub_category_fallback",
    "variantAxis": "variant_axis",
    "variantAttributeIdKey": "variant_attribute_id_key",
    "variantAttributeIdFallback": "variant_attribute_id_fallback",
    "variantTitleKey": "variant_title_key",
    "variantTitleFallback": "variant_title_fallback",
    "usesVariantAttribute": "uses_variant_attribute",
    "hasColorVariantEditor": "has_color_variant_editor",
}


def _parse_js_profiles():
    """Arabic: قراءة قيم PROFILES من ملف JS نصياً (بلا Node). English: Read the JS PROFILES values textually (no Node needed)."""
    source = JS_PROFILE_PATH.read_text(encoding="utf-8")
    parsed = {}
    for type_id in ("shoes", "watches"):
        block = re.search(
            rf"^        {type_id}: {{(.*?)^        }},$",
            source,
            re.S | re.M,
        )
        assert block, f"could not locate the {type_id} profile block in product_types.js"
        body = block.group(1)
        values = {}
        for js_key in KEY_MAP:
            match = re.search(rf"^            {js_key}: (.+?),$", body, re.M)
            if not match:
                continue
            raw = match.group(1).strip()
            if raw in ("true", "false"):
                values[js_key] = raw == "true"
            elif raw == "null":
                values[js_key] = None
            elif raw.startswith("'") and raw.endswith("'"):
                values[js_key] = raw[1:-1]
            else:
                values[js_key] = json.loads(raw)
        parsed[type_id] = values
    return parsed


def test_js_and_python_profiles_are_identical():
    """Arabic: أي فرق بين النسختين يعني أن "المصدر الواحد" انكسر. English: Any difference means the single source has broken."""
    js_profiles = _parse_js_profiles()
    assert set(js_profiles) == set(PROFILES)
    for type_id, js_values in js_profiles.items():
        for js_key, py_key in KEY_MAP.items():
            assert js_key in js_values, f"{type_id}.{js_key} missing from product_types.js"
            assert js_values[js_key] == PROFILES[type_id][py_key], (
                f"{type_id}.{js_key} differs between product_types.js and "
                f"product_type_profiles.py"
            )


@pytest.mark.parametrize("product_type,expected_fee", [("shoes", 250), ("watches", 600)])
def test_fee_comes_from_the_right_setting(product_type, expected_fee):
    assert product_type_fee(product_type, SETTINGS) == expected_fee


@pytest.mark.parametrize("original_price", [0, 1, 99, 100, 350, 999.5, 1234.56, 10000])
@pytest.mark.parametrize("product_type", ["shoes", "watches"])
def test_price_formula_matches_pre_merge_behaviour(product_type, original_price):
    """Arabic: الصيغة قبل الدمج: (السعر + رسم النوع) × سعر الصرف. English: Pre-merge formula, verbatim."""
    fee = SETTINGS["WatchFlatFeeYuan"] if product_type == "watches" else SETTINGS["AddedFeeYuan"]
    expected = round((original_price + fee) * SETTINGS["ExchangeRate"])
    assert compute_product_type_price(original_price, product_type, SETTINGS)["price_sar"] == expected


def test_shoes_fee_is_not_zero_regression():
    """
    Arabic: البلاغ الأصلي: حذاء بـ350 يوان ظهر برسم 0 وسعر 175 ريال بدل 300.
    English: The original report: a 350 CNY shoe showed a 0 fee and 175 SAR instead of 300.
    """
    result = compute_product_type_price(350, "shoes", SETTINGS)
    assert result["added_fee"] == 250
    assert result["price_sar"] == 300


def test_watches_have_no_subcategory_and_own_category():
    assert product_type_category_id("watches", SETTINGS) == 46
    assert product_type_sub_category_id("watches", SETTINGS) is None
    assert product_type_category_id("shoes", SETTINGS) == 41
    assert product_type_sub_category_id("shoes", SETTINGS) == 42


def test_watches_currently_use_no_variant_attribute():
    """
    Arabic: بطلب المستخدم — الساعات تُضاف للمتجر بلا خاصية خيارات (لوحة Sooqify ما فيها
            خاصية "اللون" رقم 2، فكان اختيارها يفشل الإضافة).
    English: Per the operator's request - watches are pushed with no variant attribute (the
             Sooqify panel has no "colour" attribute #2, so selecting it failed submission).
    """
    assert PROFILES["watches"]["uses_variant_attribute"] is False
    assert PROFILES["shoes"]["uses_variant_attribute"] is True


def test_variant_attribute_differs_by_type():
    assert product_type_variant_attribute_id("shoes", SETTINGS) == "1"
    assert product_type_variant_title("shoes", SETTINGS) == "الحجم"
    assert product_type_variant_attribute_id("watches", SETTINGS) == "2"
    assert product_type_variant_title("watches", SETTINGS) == "اللون"


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, "shoes"),
        ("", "shoes"),
        ("unknown", "shoes"),
        ("Shoes", "shoes"),
        ("WATCHES", "watches"),
        (" watches ", "watches"),
    ],
)
def test_resolver_normalizes_and_falls_back_to_shoes(raw, expected):
    assert resolve_product_type(raw) == expected


def test_labels_are_unambiguous_for_auto_translation():
    """
    Arabic: "ساعات" وحدها تُترجَم آلياً إلى "Hours" - لذلك كل تسمية تحمل الإنجليزية معها.
    English: Bare "ساعات" auto-translates to "Hours" - every label carries the English term.
    """
    watches_label = product_type_label("watches")
    assert "Watches" in watches_label
    assert watches_label != "ساعات"
    assert "Shoes" in product_type_label("shoes")
