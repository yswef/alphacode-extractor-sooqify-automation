"""
Arabic: مصدر الحقيقة الوحيد بالباك اند لكل الفروقات بين "أحذية" و"ساعات".
        نظير مطابق لـextension/product_types.js - أي تعديل هنا يجب أن يُطبَّق هناك أيضاً.
        قبل هذا الملف كان شرط `product_type == "watches"` مكرراً بـupload_service.py
        وupload_routes.py (مسار /api/extract ومسار /api/dry-run) بصياغات مختلفة، وهذا
        سبب اختلاف نتيجة dry-run عن المسار الفعلي للأحذية.
English: The backend single source of truth for every shoes/watches difference.
         Mirrors extension/product_types.js - any change here must be applied there too.
         Before this module, `product_type == "watches"` was duplicated across
         upload_service.py and upload_routes.py (both /api/extract and /api/dry-run) with
         diverging formulas, which is why dry-run disagreed with the real path for shoes.
"""

from __future__ import annotations

DEFAULT_PRODUCT_TYPE = "shoes"

# Arabic: التعريفات مطابقة حرفياً لنظيرتها بـproduct_types.js (المفاتيح والاحتياطيات).
# English: Definitions match product_types.js verbatim (setting keys and fallbacks).
PROFILES = {
    "shoes": {
        "id": "shoes",
        "label_ar": "أحذية",
        "label_en": "Shoes",
        "icon": "👟",
        "fee_setting_key": "AddedFeeYuan",
        "fee_fallback": 250,
        "category_setting_key": "CategoryId",
        "category_fallback": 41,
        "uses_sub_category": True,
        "sub_category_setting_key": "SubCategoryId",
        "sub_category_fallback": 42,
        "variant_axis": "sizes",
        "variant_attribute_id_key": "SizeAttributeId",
        "variant_attribute_id_fallback": 1,
        "variant_title_key": "SizeTitle",
        "variant_title_fallback": "الحجم",
        "uses_variant_attribute": True,
        "expects_style_code": True,
        "has_color_variant_editor": False,
    },
    "watches": {
        "id": "watches",
        "label_ar": "ساعات",
        "label_en": "Watches",
        "icon": "⌚",
        "fee_setting_key": "WatchFlatFeeYuan",
        "fee_fallback": 600,
        "category_setting_key": "WatchCategoryId",
        "category_fallback": 46,
        "uses_sub_category": False,
        "sub_category_setting_key": None,
        "sub_category_fallback": None,
        "variant_axis": "colors",
        "variant_attribute_id_key": "WatchColorAttributeId",
        "variant_attribute_id_fallback": 2,
        "variant_title_key": "WatchColorTitle",
        "variant_title_fallback": "اللون",
        # Arabic: بطلب المستخدم — الساعات بدون خاصية خيارات بالمتجر حالياً (لا توجد خاصية
        #         "اللون" رقم 2 بلوحة Sooqify). لإعادة تفعيلها: غيّر هذي القيمة إلى True.
        # English: Per the operator's request - watches carry no store variant attribute for now
        #          (the Sooqify panel has no "colour" attribute #2). To re-enable: flip to True.
        "uses_variant_attribute": False,
        # Arabic: الساعات كثيراً ما تصل بلا كود ستايل - الخانة اختيارية لها.
        # English: Watches often arrive with no style code - the field is optional for them.
        "expects_style_code": False,
        "has_color_variant_editor": True,
    },
}


def _to_float(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback or 0)


def resolve_product_type(value) -> str:
    """Arabic: يُرجع نوعاً صالحاً دائماً ("shoes" احتياطياً). English: Always returns a valid type ("shoes" as fallback)."""
    key = str(value or "").strip().lower()
    return key if key in PROFILES else DEFAULT_PRODUCT_TYPE


def get_profile(value) -> dict:
    return PROFILES[resolve_product_type(value)]


def product_type_fee(product_type, settings) -> float:
    """Arabic: الرسم الثابت باليوان لهذا النوع. English: The flat CNY fee for this type."""
    profile = get_profile(product_type)
    return _to_float((settings or {}).get(profile["fee_setting_key"]), profile["fee_fallback"])


def product_type_category_id(product_type, settings):
    """Arabic: الفئة الفعلية (الساعات تستخدم WatchCategoryId). English: Effective category (watches use WatchCategoryId)."""
    profile = get_profile(product_type)
    value = (settings or {}).get(profile["category_setting_key"])
    try:
        return int(value)
    except (TypeError, ValueError):
        return profile["category_fallback"]


def product_type_sub_category_id(product_type, settings):
    """
    Arabic: الفئة الفرعية الفعلية. للساعات تُرجع None عمداً - "لا فئة فرعية" قرار حقيقي
            وليست قيمة مفقودة؛ لا يجوز لأي مستدعٍ استبدالها باحتياطي الأحذية.
    English: The effective subcategory. Returns None for watches deliberately - "no
             subcategory" is a real decision, not a missing value; no caller may replace it
             with the shoes fallback.
    """
    profile = get_profile(product_type)
    if not profile["uses_sub_category"]:
        return None
    value = (settings or {}).get(profile["sub_category_setting_key"])
    try:
        return int(value)
    except (TypeError, ValueError):
        return profile["sub_category_fallback"]


def product_type_variant_attribute_id(product_type, settings) -> str:
    profile = get_profile(product_type)
    value = (settings or {}).get(profile["variant_attribute_id_key"])
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return str(profile["variant_attribute_id_fallback"])


def product_type_variant_title(product_type, settings) -> str:
    profile = get_profile(product_type)
    value = str((settings or {}).get(profile["variant_title_key"]) or "").strip()
    return value or profile["variant_title_fallback"]


def product_type_label(product_type, with_icon: bool = False) -> str:
    """Arabic: تسمية غير ملتبسة: "ساعات (Watches)" لا "ساعات" وحدها. English: Unambiguous label."""
    profile = get_profile(product_type)
    text = f'{profile["label_ar"]} ({profile["label_en"]})'
    return f'{profile["icon"]} {text}' if with_icon else text


def compute_product_type_price(original_price, product_type, settings) -> dict:
    """
    Arabic: الصيغة الوحيدة المعتمدة للنوعين: (السعر باليوان + رسم النوع) × سعر الصرف.
    English: The single approved formula for both types: (CNY price + type fee) x rate.
    """
    added_fee = product_type_fee(product_type, settings)
    base_price = _to_float(original_price, 0)
    exchange_rate = _to_float((settings or {}).get("ExchangeRate"), 0)
    price_after_fee = base_price + added_fee
    return {
        "added_fee": added_fee,
        "price_after_fee": price_after_fee,
        "price_sar": round(price_after_fee * exchange_rate),
    }


def list_product_types() -> list:
    return list(PROFILES.keys())
