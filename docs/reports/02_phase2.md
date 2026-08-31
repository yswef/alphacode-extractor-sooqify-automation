# تقرير المرحلة: Phase 2 — طبقة الإعدادات والحالة (Config & State Layer)

**التاريخ:** 2026-08-27  
**الحالة:** مكتملة (نقل قراءة/كتابة JSON فقط — لم يُغيَّر منطق عمل)  
**المصدر:** `Backend refactor plan.md` Phase 2 + قرارات الجرد في `docs/reports/00_inventory.md` + تأكيد يدوي لـ Phase 1

## الملفات المتأثرة

### إنشاء

- `backend/app/core/config.py` → إنشاء
- `backend/app/repositories/paths_repository.py` → إنشاء
- `backend/app/repositories/sync_state_repository.py` → إنشاء
- `backend/app/repositories/sync_queue_repository.py` → إنشاء
- `docs/reports/02_phase2.md` → إنشاء (هذا الملف)

### تعديل (استدعاء الطبقات الجديدة فقط)

- `backend/app.py` → حذف أجسام دوال JSON/config/state واستبدالها باستيراد بنفس الأسماء
- `backend/PROGRESS.md` → تحديث حالة Phase 2

لم يُمس: `recompute_paths`، `is_root_dir_valid`، `reconfigure_logging_target`، `require_root_dir`، الأرشيف، المزامنة HTTP، الـ routes.

## ملخص التغيير

قراءة/كتابة ملفات الإعداد والحالة لم تعد مباشرة داخل `app.py`. نفس الدوال (نفس الأسماء والسلوك) صارت في `core/config.py` والمستودعات، و`app.py` يستوردها.

## سبب التغيير

Phase 2 من خطة الريفكتور: طبقة واحدة لتحميل JSON الإعدادات، ومستودعات لكل ملف حالة، قبل استخراج الـ services.

## كيف يعمل المنطق الجديد

لا منطق جديد. المسارات ما زالت:

- `PATHS_CONFIG_PATH` = `backend/config/paths_config.json`
- `SYNC_CONFIG_PATH` = `backend/config/sync_config.json`
- `SYNC_QUEUE_PATH` = `backend/data/sync_queue.json`
- `SYNC_STATE_PATH` = `backend/data/sync_state.json`

`BACKEND_ROOT` في `core/config.py` = أب حزمة `app` = نفس `SCRIPT_DIR` المحسوب من `backend/app.py` (مُتحقق: المساران متطابقان).

`app.py` يضيف `SCRIPT_DIR` إلى `sys.path` قبل `import app.*` حتى يعمل الاستيراد مع وجود `app.py` و`app/` معاً (نفس الملاحظة الانتقالية من Phase 1).

`load_archive` ما زال في `app.py` ويستدعي `load_json_file` المستورد (الأرشيف ليس ضمن هذه المرحلة).

`save_sync_config` يستخدم نسخاً محلية مطابقة لـ `normalize_text` / `safe_bool` داخل `core/config.py` (`_normalize_text` / `_safe_bool`) حتى لا يستورد `app.py` (حلقة استيراد). الأجسام منسوخة حرفياً من الدالتين الأصليتين.

## Repositories والدوال المنقولة

| المصدر في `app.py` | الوجهة | ملاحظات |
|--------------------|--------|---------|
| `load_json_file` | `app/core/config.py` | مشترك لكل كتّاب/قرّاء JSON |
| `write_json_temp` | `app/core/config.py` | نفس الكتابة الذرية |
| `save_json_atomic` | `app/core/config.py` | نفس الاستبدال الذري |
| `load_sync_config` | `app/core/config.py` | ملف إعداد (حسب خطة Phase 2: `core/config.py`) |
| `save_sync_config` | `app/core/config.py` | تنظيف Enabled/URL/Token/AddedByName كما كان |
| `load_paths_config` | `app/repositories/paths_repository.py` | كان مقرراً في Phase 4؛ نُقل الآن بطلب هذه المرحلة |
| `save_paths_config` | `app/repositories/paths_repository.py` | |
| `load_sync_state` | `app/repositories/sync_state_repository.py` | |
| `save_sync_state` | `app/repositories/sync_state_repository.py` | |
| `load_sync_queue` | `app/repositories/sync_queue_repository.py` | |
| `save_sync_queue` | `app/repositories/sync_queue_repository.py` | |

لم يُنشأ `sync_config_repository.py`: ملف `sync_config.json` إعداد وليس حالة تشغيل؛ مكانه `core/config.py` حسب الخطة. مسارات الملف ما زالت عبر الثوابت في `core/config.py`.

## أجزاء `app.py` المعدَّلة

المسار الكامل: `d:\alphacode-extractor-sooqify-automation\backend\app.py`

1) بعد `SCRIPT_DIR`: إدخال `sys.path` ثم استيراد الدوال أعلاه (بدل تعريف ثوابت المسارات الأربعة محلياً).

2) حذف أجسام: `load_json_file`، `write_json_temp`، `save_json_atomic`، `load_paths_config`، `save_paths_config`، `load_sync_config`، `save_sync_config`، `load_sync_state`، `save_sync_state`، `load_sync_queue`، `save_sync_queue`.

`recompute_paths()` ما زال يستدعي `load_paths_config()` و`/api/sync/*` ما زال يستدعي `load_sync_*` / `save_sync_*` بنفس الأسماء.

## نقاط تحتاج اختبار يدوي من المستخدم

- [ ] تشغيل الخادم (`python app.py` من `backend/`) والتأكد أن الإقلاع ينجح
- [ ] `GET /api/paths/status` ما زال يعكس `backend/config/paths_config.json`
- [ ] `GET /api/sync/config` و`GET /api/sync/status` يقرآن من `backend/config/sync_config.json` و`backend/data/sync_state.json` / `sync_queue.json`
- [ ] حفظ إعداد مزامنة أو مجلد حفظ يكتب في المواقع الجديدة وليس بجانب `app.py`

تحقق آلي محلي (ليس بديلاً عن التشغيل اليدوي): `test_upload_main_image_only.py` نجح؛ تحميل `app.py` كوحدة قرأ `RootDir` والإعدادات من الملفات المنقولة.

## نقاط مشكوك فيها لم تُعدَّل (بانتظار توضيح)

لا شيء أوقف التنفيذ. لم يُنقل `recompute_paths` ولا فحص صلاحية المجلد. لم يُحذف `reports_config.json`. لم تُستخرج دوال الأرشيف (`load_archive` وما يليها).
