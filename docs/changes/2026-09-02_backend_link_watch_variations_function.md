# ربط build_watch_variations_from_absolute_yuan بـ/api/extract بدل الكود المكرر

**التاريخ:** 2026-09-02
**الملف المعدَّل:** `backend/app/api/routes/upload_routes.py`

## التعديل

الكود inline بـ`/api/extract` (كان بالسطور 600-614 قبل الحذف) كان نسخة حرفية مكررة
من `build_watch_variations_from_absolute_yuan()` الموجودة أصلاً بـ`upload_service.py:375`
(نفس المنطق الرياضي: `_abs_price_yuan × ExchangeRate` بدون إعادة إضافة الرسم، وتعليق
الكود بالدالة نفسه يقول صراحة "منسوخ حرفياً من extract_product"). استبدلت الكتلة
inline باستدعاء فعلي للدالة:

```python
if watch_colors and settings["ProductType"] == "watches":
    variations, choice_options, attributes, total_stock, variant_price_rows = (
        build_watch_variations_from_absolute_yuan(
            watch_colors, settings, data.get("OriginalPrice"),
        )
    )
else:
    ...
```

التوقيع طابق تماماً بدون أي تعديل (`watch_colors, settings, original_price` →
`(variations, choice_options, attributes, total_stock, variant_price_rows)`)، فقط
أضفت `build_watch_variations_from_absolute_yuan` لقائمة الاستيراد من
`app.services.upload_service`.

## السبب

قرار الجرد الأصلي (`00_inventory.md`، بند 5) كان "حافظ على سلوك extract الفعلي بدون
ربطها" لحين التحقق اليدوي. المستخدم قرر الآن إن الوقت مناسب للربط، عشان يصير مصدر
وحيد لمنطق سعر الساعة المطلق بدل نسختين منفصلتين (خطر انحراف مستقبلي - بالضبط نفس
سبب أخطاء الرسوم التاريخية بالإكستنشن).

## التحقق الفعلي

- `python -c "import py_compile; ..."` نجح.
- `python -m pytest -q`: **7/7 نجح** — صفر رجوع.
- **تحقق رقمي مباشر:** أعدت بناء الكود الـinline القديم حرفياً بسكربت منفصل، واستوردت
  `build_watch_variations_from_absolute_yuan` الحقيقية من `upload_service.py`، وقارنت
  النتيجتين على 4 حالات (لونين بسعرين مختلفين، لا ألوان مع سعر أساسي، لا ألوان مع سعر
  صفر، لون واحد بسعر كسري) — **تطابق تام 100%** (بما فيها نص JSON الحرفي المُصدَّر
  لكل حقل، بعد تصحيح خطأ بسكربت الاختبار نفسه كان يستخدم دالة `json_cell` محلية
  بمسافات مختلفة عن الحقيقية بدل استيرادها فعلياً).
