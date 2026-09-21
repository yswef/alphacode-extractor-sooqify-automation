# فحص شامل لأسماء ناقصة بـai_helpers.py (نمط "نقل جزئي" متكرر) + إصلاح ما هو فعلياً قابل للتنفيذ

**التاريخ:** 2026-09-02
**الملفات المعدَّلة:** `backend/app/services/ai_helpers.py`

## المشكلة الفعلية (traceback حقيقي)

```
File "upload_routes.py", line 752, in check_product
    existing = find_existing_product(archive, data.get("SearchCode"), data.get("StyleCode"))
File "ai_helpers.py", line 572, in find_existing_product
    if is_valid_marker(search_code) and ...
File "ai_helpers.py", line 181, in is_valid_marker
    return normalize_text(value).upper() not in INVALID_MARKERS
NameError: name 'INVALID_MARKERS' is not defined
```

نفس نمط الأخطاء السابقة بهالجلسة (`subprocess`, `archive_repository`): دالة انتقلت من
`backend/app.py` القديم لـ`ai_helpers.py` لكن الثابت اللي تعتمد عليه ما انتقل معها.

## الفحص الشامل (`pyflakes`)

بدل انتظار كل خطأ يظهر وحده وقت التشغيل، شُغِّل `python -m pyflakes app/services/ai_helpers.py`
لمسك كل الأسماء المستخدمة وغير المعرَّفة/غير المستوردة دفعة وحدة. النتيجة الكاملة (18 تحذير)
مقسَّمة حسب إمكانية الوصول الفعلي (هل الدالة الحاوية لها مستوردة/مستدعاة فعلياً من أي route،
تحقّق بـgrep شامل على كل الاستيرادات بـ`core_routes.py` و`upload_routes.py` و`main.py`):

### أ) قابلة للتنفيذ فعلياً — تم إصلاحها

| الاسم الناقص | الدالة الحاوية | الوصول الفعلي |
|---|---|---|
| `INVALID_MARKERS` | `is_valid_marker` (يستدعيها `find_existing_product`، مستوردة ومستخدمة بـ`upload_routes.py`) | `/api/check`, `/api/upload` وغيرها |
| `jsonify` | `handle_local_request_too_large` | **غير مستدعاة فعلياً** (انظر أدناه) — أُصلحت احترازياً لأنها استيراد سطر واحد بلا أي مخاطرة |

**الإصلاح:** نُسخ `INVALID_MARKERS` حرفياً من `backend/app.py:226`:
```python
INVALID_MARKERS = {"", "NONE", "NULL", "UNDEFINED", "غير محدد", "NO_CODE", "NO_STYLE"}
```
وأُضيف `jsonify` لاستيراد `flask` الموجود أصلاً (`from flask import request, jsonify`).

### ب) كود ميت فعلاً — لم يُلمَس (قرار متعمَّد، ليس نسياناً)

الفحص أظهر أن باقي الأسماء الناقصة (16 من أصل 18) كلها داخل دوال **غير مستوردة من أي مكان
بالتطبيق الفعلي** (تحقّق: بحث شامل عن اسم كل دالة بكل ملفات `backend/app/` — صفر نتائج
استيراد):

1. **`recompute_paths()` و`require_root_dir()`** (أسطر 273-308): تعتمد على
   `load_paths_config`, `SCRIPT_DIR`, `IMAGES_FOLDER_NAME`, `ROOT_DIR_CONFIGURED`,
   `RootDirNotConfigured` — كلها غير معرَّفة. هذي ليست مجرد استيراد ناقص: الدالة نفسها
   *مكسورة بنيوياً* حتى لو أُضيفت الاستيرادات، لأنها تكتب لمتغيرات محلية
   (`ROOT_DIR`, `AI_CACHE_PATH`, `LOG_DIR`, `PRICE_PATTERNS_LOG_PATH`,
   `ROOT_DIR_CONFIGURED`) بدون `global`، فما تنعكس فعلياً على أي حالة يقرأها باقي
   الكود. النظام الفعلي البديل والوحيد المستخدم بكل الـroutes هو
   `app.core.runtime.paths_state` (كائن يُحدَّث صح عبر `paths_state.recompute(...)`
   بـ`app/core/runtime.py`). نسخ الثوابت الناقصة هنا كان سيُنشئ نظام مسارات مواز
   مكسور بنيوياً - نفس فخ حادثة `sync_config.json` (مصدرين للحقيقة يتعارضان) - فتُرك
   بدون تعديل.

2. **`sync_background_worker()`** (أسطر 361-369): تستخدم `sync_pull_updates`,
   `sync_flush_queue`, `time` (غير مستوردة). موثّق صراحة بـ`PROGRESS.md:21`: "تصميم
   المزامنة = مرة عند الإقلاع فقط. الحلقة الدورية كود ميت." — كود ميت مقصود، مو خطأ.

3. **`scan_data_repair_issues()` و`apply_data_repair_fix()`** (أسطر 383-514): تعتمد على
   `REFERENCE_PRODUCT_FIELDS`, `load_sync_config`, `sync_call`,
   `DATA_REPAIR_CONFLICT_IGNORED_FIELDS`, `sync_push_product`, `time` — كلها غير
   معرَّفة. هذي نسخة مكررة ميتة تماماً من تطبيق فعلي شغّال وسليم موجود بملف مختلف:
   `_scan_data_repair_issues()` و`_apply_data_repair_fix()` بـ`reports_routes.py`
   (مستوردة صح من `app.services.sync_service` هناك وتعمل فعلاً بتبويب "إصلاح
   البيانات"). نسخ الثوابت الناقصة هنا كان سينشئ تطبيقاً موازياً ثانياً لنفس الميزة.

**القرار:** الفئة (ب) بحاجة قرار من صاحب المشروع (حذف الكود الميت كلياً، أو تجاهله لأنه
غير قابل للوصول أصلاً وبالتالي لا يشكّل خطراً فعلياً) — لا إصلاح تلقائي أعمى، لأن "نقل
الثوابت الناقصة" هنا يعني بناء نظام مواز مكسور أو مكرر، لا مجرد سد فجوة استيراد بسيطة.

## التحقق الفعلي

- `python -m pyflakes app/services/ai_helpers.py` قبل الإصلاح: 18 تحذير. بعده: 16 تحذير
  (باقية كلها بالفئة ب أعلاه، مؤكَّدة غير قابلة للوصول).
- `python -m py_compile app/services/ai_helpers.py app/api/routes/upload_routes.py`: نجح
  بدون أخطاء.
- تشغيل الباك اند من الصفر (تحقق `tasklist`/`netstat` أن لا عملية قديمة عالقة على 5000
  قبل التشغيل).
- `POST /api/check` بجسم فاضٍ `{}`: `200` — لا مزيد من `NameError` (كان يفشل بهذا
  بالضبط قبل الإصلاح).
- `POST /api/check` بـ`SearchCode` حقيقي من الأرشيف الفعلي (`"660281"`, منتج مُضاف
  مسبقاً - Nike/BRANDKINGDOM): `200` و`"exists": true` مع بيانات المنتج الصحيحة
  (`id`, `workflow_status`, `image_count`, ...) — يؤكد ظهور "العلامة الخضراء" على
  المنتجات المكررة فعلياً يعمل بعد الإصلاح.
- `POST /api/check` بـ`StyleCode` حقيقي (`"IR2266-010"`) بدون `SearchCode`: `200` و
  `"exists": true` — مسار البحث الاحتياطي بـ`style_code` يعمل أيضاً.
- `GET /api/archive/stats`: `200`، الأرشيف الفعلي يحتوي 2391 منتج و18038 صورة —
  الاختبار تم على بيانات حقيقية لا أرشيف فاضٍ.
- هذا الإصلاح هو نفس السبب الجذري وراء فشل "Archive check failed" أثناء مراجعة الدفعة
  (`/api/check` تُستدعى أثناء بناء دفعة المراجعة) — الاختبار أعلاه يغطي نفس مسار الكود
  بالضبط.
