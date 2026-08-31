# تقرير المرحلة: Phase 1 — إنشاء الهيكل الفارغ (Scaffolding)

**التاريخ:** 2026-08-27  
**الحالة:** مكتملة (نقل مسارات فقط — لم يُغيَّر منطق عمل)  
**المصدر:** `Backend refactor plan.md` Phase 1 + قرارات الجرد في `docs/reports/00_inventory.md`

## الملفات المتأثرة

### إنشاء (حزم فارغة)

- `backend/app/__init__.py` → إنشاء
- `backend/app/api/__init__.py` → إنشاء
- `backend/app/api/routes/__init__.py` → إنشاء (مجلد `routes` مذكور في الهيكلة المستهدفة تحت `api/`)
- `backend/app/core/__init__.py` → إنشاء
- `backend/app/services/__init__.py` → إنشاء
- `backend/app/repositories/__init__.py` → إنشاء
- `backend/app/models/__init__.py` → إنشاء
- `backend/app/watchers/__init__.py` → إنشاء (فارغ عمداً؛ قرار Phase 0 رقم 8)
- `backend/app/utils/__init__.py` → إنشاء
- `backend/tests/__init__.py` → إنشاء (مجلد الاختبارات في الهيكلة المستهدفة؛ لا اختبارات جديدة)
- `backend/config/` → إنشاء (وجهة ملفات الإعداد)
- `backend/data/` → إنشاء (وجهة ملفات الحالة)

لم يُنشأ `backend/docs/` لأن التقارير موجودة أصلاً في `docs/reports/` بجذر المستودع. لم يُنشأ `backend/logs/` لأنه موجود مسبقاً.

### نقل (بدون تعديل محتوى)

- `backend/paths_config.json` → `backend/config/paths_config.json`
- `backend/sync_config.json` → `backend/config/sync_config.json`
- `backend/reports_config.json` → `backend/config/reports_config.json` (غير مستخدم من الكود؛ النقل حسب خطة Phase 1؛ الحذف لاحقاً حسب قرار الجرد رقم 2)
- `backend/sync_queue.json` → `backend/data/sync_queue.json`
- `backend/sync_state.json` → `backend/data/sync_state.json`

### تعديل مسارات فقط

- `backend/app.py` → ثوابت المسارات الأربعة أعلاه فقط (انظر أدناه)
- `.gitignore` → إضافة المسارات الجديدة مع الإبقاء على القديمة حتى لا تُرفع ملفات تشغيل محلية بالخطأ

## ملخص التغيير

هيكل حزم Python فارغ تحت `backend/app/`، ونقل ملفات config/state إلى `backend/config/` و`backend/data/`. التطبيق ما زال يعمل من `backend/app.py` كما كان.

## سبب التغيير

تثبيت الهيكل المستهدف قبل استخراج الطبقات في المراحل التالية، مع بقاء قراءة/كتابة JSON من نفس الدوال في `app.py`.

## كيف يعمل المنطق الجديد

لا منطق جديد. `SCRIPT_DIR` ما زال مجلد `backend/` (مكان `app.py`). المسارات صارت:

- `PATHS_CONFIG_PATH` = `backend/config/paths_config.json`
- `SYNC_CONFIG_PATH` = `backend/config/sync_config.json`
- `SYNC_QUEUE_PATH` = `backend/data/sync_queue.json`
- `SYNC_STATE_PATH` = `backend/data/sync_state.json`

`save_json_atomic` / `write_json_temp` كانا ينشئان المجلد الأب عند الكتابة؛ لم يُمسّ هذا السلوك.

لا يوجد `import` يشير لملفات JSON (مسارات ملفات فقط). لا كود يقرأ `reports_config.json` قبل النقل ولا بعده.

## أجزاء `app.py` المعدَّلة

المسار الكامل: `d:\alphacode-extractor-sooqify-automation\backend\app.py` (الأسطر 60–63 تقريباً)

قبل:

```python
PATHS_CONFIG_PATH = os.path.join(SCRIPT_DIR, "paths_config.json")
SYNC_CONFIG_PATH = os.path.join(SCRIPT_DIR, "sync_config.json")
SYNC_QUEUE_PATH = os.path.join(SCRIPT_DIR, "sync_queue.json")
SYNC_STATE_PATH = os.path.join(SCRIPT_DIR, "sync_state.json")
```

بعد:

```python
PATHS_CONFIG_PATH = os.path.join(SCRIPT_DIR, "config", "paths_config.json")
SYNC_CONFIG_PATH = os.path.join(SCRIPT_DIR, "config", "sync_config.json")
SYNC_QUEUE_PATH = os.path.join(SCRIPT_DIR, "data", "sync_queue.json")
SYNC_STATE_PATH = os.path.join(SCRIPT_DIR, "data", "sync_state.json")
```

## ملاحظة انتقالية (ليست تخميناً لمنطق)

وجود `backend/app.py` و`backend/app/` معاً: تشغيل `python app.py` وتحميل الاختبار عبر مسار الملف (`test_upload_main_image_only.py`) لا يعتمدان على `import app`. أي `import app` من مجلد `backend/` قد يحمّل الحزمة الفارغة بدل الملف. يُحل في Phase 5 عند نقل نقطة الدخول إلى `app/main.py`.

## نقاط تحتاج اختبار يدوي من المستخدم

- [ ] تشغيل الخادم كالعادة (`python app.py` من `backend/`) والتأكد أن الإقلاع ينجح
- [ ] `GET /api/sync/status` و`GET /api/sync/config` يقرآن الحالة/الإعدادات من الملفات بعد النقل
- [ ] `GET /api/paths/status` ما زال يعكس `paths_config.json` في الموقع الجديد
- [ ] حفظ إعداد مزامنة أو مجلد حفظ يكتب في `backend/config/` أو `backend/data/` وليس بجانب `app.py`

## نقاط مشكوك فيها لم تُعدَّل (بانتظار توضيح)

لا شيء أوقف التنفيذ. لم يُحذف `reports_config.json` (قرار الحذف لاحقاً). لم يُمسّ منطق `app.py` خارج ثوابت المسارات.
