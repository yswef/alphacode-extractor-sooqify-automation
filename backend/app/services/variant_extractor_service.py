# -*- coding: utf-8 -*-
"""
Arabic: استخراج الألوان وسعر كل لون (وأي بيانات أخرى صريحة) من النص الخام للمورد لمنتجات
        الساعات فقط. الملف يبني الرسائل والمخطط (schema) فقط - الاتصال الفعلي بمزود
        الذكاء الاصطناعي يبقى في app.py (نفس الدوال المشتركة send_ai_request / make_provider_payload)
        عشان ما نكرر منطق الاتصال والتعامل مع الأخطاء.
        القاعدة الأساسية: لا يخترع الموديل أي لون أو سعر غير مكتوب صراحة بالنص. لو النص
        فيه فرق سعر مكتوب كـ"+50" لسعر أساسي، يحسبه كسعر مطلق لهذا اللون.

English: Extracts colors and each color's price (plus any other explicit facts) from the
         raw supplier text, for watch products only. This file only builds the prompt
         messages and JSON schema - the actual AI provider call stays in app.py (reusing
         the shared send_ai_request / make_provider_payload helpers) so the request/error
         handling logic isn't duplicated.
         Ground rule: the model must never invent a color or price that isn't explicitly
         written in the text. If the text has a price delta like "+50" over a base price,
         it should compute the absolute price for that color.
"""

WATCH_VARIANT_SCHEMA_NAME = "alphacode_watch_variants"

WATCH_VARIANT_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "base_price": {"type": "number"},
        "variants": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "color": {"type": "string"},
                    "price": {"type": "number"},
                },
                "required": ["color", "price"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["found", "base_price", "variants", "notes"],
    "additionalProperties": False,
}


def build_watch_variant_messages(source_text, original_product_name, style_code, search_code):
    """Arabic: بناء رسائل استخراج الألوان/الأسعار لمنتج ساعة واحد. English: Build the color/price extraction messages for a single watch product."""
    instructions = """
You extract structured facts from a raw supplier listing for a WATCH product. You never
write marketing copy and you never invent anything that is not explicitly present in the text.

TASK:
- Find every color/version explicitly mentioned in the text, each with its own price.
- Prices are usually in Chinese Yuan. If a color's price is written as a delta from a base
  price (e.g. "+50", "加50"), compute variants[].price as the ABSOLUTE price
  (base_price + delta), not the delta itself.
- base_price is the single starting/base price for the listing, if one is explicitly stated
  (a price with no color attached, or the lowest/first price mentioned). If you cannot
  determine one, use 0.
- If the text mentions colors but with NO price differences at all (all colors share the
  same single price), return each color with that same price.
- If the text has no identifiable colors/variants at all, return an empty variants array.
- Set found to true only if you extracted at least one usable fact (a base_price greater
  than 0, OR at least one variant). Set found to false if the text gave you nothing usable.
- notes: one short factual sentence about anything else explicit and useful you noticed
  (e.g. a stated movement type, case size, or box) - or an empty string if nothing.
- Never include Search Code, supplier name, or Chinese source text in your output.

Return exactly one JSON object matching the given schema. Nothing else.
""".strip()

    user_input = f"""
SUPPLIER TEXT:
{source_text or 'Not provided'}

ORIGINAL PRODUCT NAME:
{original_product_name or 'Not provided'}

STYLE CODE: {style_code or 'Not provided'}
INTERNAL SEARCH CODE — NEVER INCLUDE: {search_code or 'Not provided'}
""".strip()

    return [
        {"role": "system", "content": instructions},
        {"role": "user", "content": user_input},
    ]


def validate_watch_variants(generated):
    """Arabic: تحقق دفاعي من رد الموديل قبل الاستخدام. English: Defensively validate the model's response before use."""
    if not isinstance(generated, dict):
        raise ValueError("AI response was not a JSON object.")

    found = bool(generated.get("found"))
    try:
        base_price = float(generated.get("base_price") or 0)
    except (TypeError, ValueError):
        base_price = 0.0

    raw_variants = generated.get("variants")
    variants = []
    if isinstance(raw_variants, list):
        for item in raw_variants:
            if not isinstance(item, dict):
                continue
            color = str(item.get("color") or "").strip()
            try:
                price = float(item.get("price") or 0)
            except (TypeError, ValueError):
                price = 0.0
            if color and price > 0:
                variants.append({"color": color, "price": price})

    notes = str(generated.get("notes") or "").strip()[:400]

    # Arabic: found حقيقي فقط لو فعلاً في سعر أساسي أو نسخة واحدة صالحة على الأقل.
    # English: found is only true if there is a real base price or at least one usable variant.
    found = bool(found and (base_price > 0 or variants))

    return {"found": found, "base_price": base_price, "variants": variants, "notes": notes}
