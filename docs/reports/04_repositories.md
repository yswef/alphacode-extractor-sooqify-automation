# تقرير المرحلة: Phase 4 — طبقة الـ Repositories المتبقية

**التاريخ:** 2026-08-29
**الحالة:** مكتملة
**المصدر:** `Backend refactor plan.md` Phase 4

## ملخص الجرد قبل التنفيذ

- `paths_repository.py` كان موجوداً وصحيحاً من Phase 2 — لم يُعدَّل.
- `sync_queue_repository.py` و`sync_state_repository.py` كانا مغطّين صح من Phase 2 — لم يُعدَّلا.
- لُقي هدفين حقيقيين يخالفان قاعدة "ممنوع أي `open()`/JSON مباشر خارج الـ repositories":
  1. `archive_db.json`: `load_archive()` وحفظان مباشران (`save_json_atomic(ARCHIVE_PATH, ...)`) معرّفون داخل `app.py` نفسه، بلا دالة `save_archive()` موحّدة، ومستخدمة أيضاً مباشرة داخل `app/services/sync_service.py` (تصرف من Phase 3).
  2. `sync_config.json`: `load_sync_config()`/`save_sync_config()` كانتا معرّفتين داخل `app/core/config.py` نفسه (طبقة الـ primitives)، بعكس نمط `sync_queue`/`sync_state` اللي لهم ملف repository مستقل من Phase 2.
- `ai_copy_cache.json`: استُبعد عمداً (قرار 5: كود ميت بالهجرة) — الاستدعاء المباشر الوحيد المتبقي بـ`app.py` تركته كما هو.
- `price_patterns.jsonl` و`alphacode.log`: بقرار المستخدم (تفويض للحكم)، اعتُبرا خارج نطاق طبقة الـ repositories — نفس حدود Phase 1-2 اللي اقتصرت على ملفات config/state فقط، مو سجلات الأحداث (logs).

## نقطة تصميم مهمة اكتُشفت أثناء الفحص

`ARCHIVE_PATH` **ليس ثابتاً** — قيمة عامة (`global`) تُعاد حسابها وقت التشغيل عبر `recompute_paths()` حسب مجلد الحفظ الذي يختاره المستخدم (`/api/paths/choose-folder`). لو حُسب هذا المسار مرة واحدة داخل ملف الـ repository نفسه (كما فعلت بمحاولة أولى ثم تراجعت عنها)، كان سينكسر أي مستخدم غيّر مجلد الحفظ بعد الإقلاع. لذلك:

- `app/repositories/archive_repository.py` لا يحسب المسار إطلاقاً — دواله (`load_archive(archive_path)`/`save_archive(archive_path, archive)`) تستقبل المسار كمعامل صريح في كل استدعاء.
- `app.py` يبقى المصدر الوحيد لقيمة `ARCHIVE_PATH` الحالية، ويمرّرها لكل استدعاء عبر غلافين رفيعين (`load_archive()`/`save_archive(archive)` بلا معاملات، للحفاظ على نفس الاستدعاءات القديمة بكل الملف دون تغيير أي موضع من الـ 16 استدعاء الموجودة).

## الملفات المتأثرة

### إنشاء

- `backend/app/repositories/archive_repository.py` — `load_archive(archive_path)` و`save_archive(archive_path, archive)`.
- `backend/app/repositories/sync_config_repository.py` — `load_sync_config()` و`save_sync_config()` (منقولتان حرفياً من `core/config.py` مع دالتيهما المساعدتين الخاصتين `_normalize_text`/`_safe_bool`، بنفس نمط `upload_service.py` بالاحتفاظ بنسخة محلية بدل استيراد أسماء خاصة من وحدة ثانية).

### تعديل

- `backend/app/core/config.py`: حذف `load_sync_config`/`save_sync_config`/`_normalize_text`/`_safe_bool` بعد نقلهم — الملف صار طبقة primitives خالصة (مسارات + `load_json_file`/`save_json_atomic`/`write_json_temp` فقط).
- `backend/app.py`:
  - `load_archive()` صارت غلافاً رفيعاً يستدعي `archive_repository.load_archive(ARCHIVE_PATH)`.
  - إضافة `save_archive(archive)` كغلاف موحّد يستدعي `archive_repository.save_archive(ARCHIVE_PATH, archive)` — يحل محل استدعاءين متفرقين كانا يكرران `save_json_atomic(ARCHIVE_PATH, ...)` مباشرة.
  - `bind_archive_runtime(load_archive, save_archive, SAVE_LOCK)` — الوسيط الثاني صار دالة حفظ موحّدة بدل `lambda: ARCHIVE_PATH` (مسار خام).
  - تحديث الاستيراد: `load_sync_config`/`save_sync_config` من `app.repositories.sync_config_repository` بدل `app.core.config`؛ حذف `SYNC_CONFIG_PATH`/`load_json_file` من الاستيراد لعدم استخدامهما بعد النقل.
- `backend/app/services/sync_service.py`:
  - `bind_archive_runtime(load_archive, get_archive_path, save_lock)` → `bind_archive_runtime(load_archive, save_archive, save_lock)` — الوسيط `_get_archive_path` (كان يُستخدم فقط لبناء `save_json_atomic(_get_archive_path(), archive)`) استُبدل بـ`_save_archive(archive)` مباشرة، بموضعين.
  - تصحيح استيراد `load_sync_config` من `app.repositories.sync_config_repository` بدل `app.core.config` (كان سينكسر فوراً بعد نقل الدالة لولا هذا التصحيح — اكتُشف أثناء الاختبار الديناميكي).
  - حذف استيراد `save_json_atomic` غير المستخدم بعد استبدال موضعيه بـ`_save_archive`.

### إنشاء توثيق

- `docs/reports/04_repositories.md` (هذا الملف).
- تحديث `backend/PROGRESS.md`.

## ملخص التغيير

لا تغيير سلوكي. الحجم: `backend/app.py` 3138 → 3141 سطر (زيادة طفيفة: إضافة `save_archive()` كدالة موحّدة عوّضت استدعاءين متكررين). تحقّق فعلي (تحميل ديناميكي، مو افتراض):

| الدالة | المصدر بعد النقل | تحقّق round-trip |
|---|---|---|
| `load_archive` / `save_archive` (بـ`app.py`) | أغلفة رفيعة → `app.repositories.archive_repository` | ✅ كتابة وقراءة فعلية نجحت |
| `load_sync_config` / `save_sync_config` | `app.repositories.sync_config_repository` | ✅ كتابة وقراءة فعلية نجحت |

اختبار `test_upload_main_image_only.py` الموجود مسبقاً: **نجح 2/2** بعد كل التعديلات.

## سبب التغيير

كانت هناك نقطتا وصول JSON مباشرتان (الأرشيف وإعدادات المزامنة) خارج طبقة الـ repositories، بعكس ما توثقه Phase 2 لـ`sync_queue`/`sync_state`/`paths`. هذا يخالف القاعدة الصريحة لـ Phase 4، ويجعل نقطة الحقيقة الوحيدة لكل ملف بيانات متسقة عبر المشروع تمهيداً لطبقة الـ Routes (Phase 5).

## كيف يعمل المنطق الجديد

لا منطق جديد — فقط توحيد نقطة الوصول. الحالة الوحيدة اللي احتاجت تصميماً مختلفاً عن `paths`/`sync_queue`/`sync_state` هي الأرشيف، بسبب مساره المتغيّر وقت التشغيل (موضّح أعلاه) — الحل يمرر المسار كمعامل صريح بدل تثبيته داخل الـ repository.

## القرارات المتعلقة بهذي المرحلة

- **قرار 5 (كاش AI):** التزمت به — `ai_copy_cache.json` لم يُمس.
- **نطاق السجلات (log/jsonl):** بتفويض من المستخدم، اعتُبرت خارج نطاق طبقة الـ repositories (نفس حدود Phase 1-2) — لم تُمس `alphacode.log` ولا `price_patterns.jsonl`.

## نقاط تحتاج اختبار يدوي منك قبل Phase 5

- [ ] تشغيل السيرفر (`python app.py`) والتأكد من إقلاع نظيف بدون أي `ImportError`.
- [ ] تجربة حفظ منتج فعلي (`/api/extract`) والتأكد أن الأرشيف يُحدَّث ويُقرأ صح.
- [ ] تغيير مجلد الحفظ من الإعدادات (`/api/paths/choose-folder`) والتأكد أن الأرشيف يُقرأ/يُكتب من المجلد الجديد صح (هذا يتحقق تحديداً من إصلاح نقطة "المسار المتغيّر" الموضحة أعلاه).
- [ ] فتح/حفظ إعدادات المزامنة من الواجهة والتأكد أنها تُحفظ وتُسترجع صح.
- [ ] تشغيل `pytest backend/test_upload_main_image_only.py` عندك (نجح هنا 2/2).
