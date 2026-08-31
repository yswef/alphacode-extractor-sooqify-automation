import re

def normalize_text(value):
    """Arabic: توحيد النصوص قبل التخزين أو المقارنة. English: Normalize text before storage or comparison."""
    return str(value).strip() if value is not None else ""

def compact_prompt_text(value, maximum_length):
    """Arabic: تقليص نصوص البرومبت وحذف الروابط والرموز الطويلة لتجنب 413. English: Compact prompt text and remove URLs or opaque tokens to prevent HTTP 413."""
    if not value or not isinstance(value, str):
        return ""
    value = re.sub(r'https?://\S+', '', value)
    if len(value) > maximum_length:
        return value[:maximum_length] + " (truncated)"
    return value

def is_valid_marker(value):
    """Arabic: التحقق من أن الكود ليس قيمة فارغة أو وهمية. English: Validate that a code is not empty or synthetic."""
    val = normalize_text(value).lower()
    return bool(val and val not in ("n/a", "undefined", "null", "none", ""))

def safe_int(value, fallback):
    """Arabic: تحويل آمن إلى عدد صحيح. English: Safely coerce a value to integer."""
    try:
        return int(float(value)) if value is not None and value != "" else fallback
    except (ValueError, TypeError):
        return fallback

def safe_float(value, fallback):
    """Arabic: تحويل آمن إلى عدد عشري. English: Safely coerce a value to float."""
    try:
        return float(value) if value is not None and value != "" else fallback
    except (ValueError, TypeError):
        return fallback

def safe_bool(value, fallback=False):
    """Arabic: قراءة القيم المنطقية القادمة من JavaScript. English: Parse boolean-like values received from JavaScript."""
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return bool(value)

def unique_text_values(values):
    """Arabic: إزالة القيم المكررة مع المحافظة على ترتيبها. English: Deduplicate text values while preserving order."""
    if not values:
        return []
    seen = set()
    result = []
    for v in values:
        normalized = normalize_text(v)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result
