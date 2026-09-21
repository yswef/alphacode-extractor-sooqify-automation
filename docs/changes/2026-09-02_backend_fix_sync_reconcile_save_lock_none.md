# إصلاح TypeError('NoneType' لا يدعم context manager) بـ /api/sync/reconcile

**التاريخ:** 2026-09-02
**الملفات المعدَّلة:** `backend/app/main.py`، `backend/app/services/ai_helpers.py`

## المشكلة

اختبار حقيقي: `POST /api/sync/reconcile` يفشل دايماً بـ500 و:
```
TypeError: 'NoneType' object does not support the context manager protocol
  File "sync_service.py", line 231, in sync_reconcile_full
    with _save_lock:
```

## التشخيص (الفحص الفعلي، ليس افتراضاً)

`_save_lock` (وكذلك `_load_archive`, `_save_archive`) بأعلى `sync_service.py` مُعرَّفة
افتراضياً كـ`None` (سطر 32-34)، وتُهيَّأ فقط عبر `bind_archive_runtime(...)`
(سطر 37-42) — دالة يجب استدعاؤها مرة عند إقلاع التطبيق.

`grep` شامل على كل المشروع لـ`bind_archive_runtime` أظهر استدعاء وحيد: بـ
`backend/app.py:353` (الملف الأحادي القديم). لكن نقطة التشغيل الفعلية للباك اند هي
`backend/app/main.py` (App Factory تسجّل الـBlueprints مباشرة) — و**لا تستورد ولا تستدعي
`bind_archive_runtime` إطلاقاً**. يعني `_save_lock`/`_load_archive`/`_save_archive` تبقى
`None` للأبد بالتطبيق الشغّال فعلياً، بغض النظر عن أي مسار.

مقارنة الاستخدامات: `sync_pull_updates()` (سطر 189) تستخدم `_save_lock` أيضاً، لكن فقط
داخل `if items:` — فما تنكسر إلا لو السيرفر رجّع عناصر فعلية بالسحب. أما
`sync_reconcile_full()` (سطر 231) تدخل `with _save_lock:` **دون أي شرط** — لذلك تفشل
100% من المرات، بينما `/api/sync/pull` و`/api/sync/now` قد ينجحان أحياناً (لما ما يكون
فيه عناصر جديدة للدمج) ويفشلان أحياناً أخرى بنفس الخطأ بالضبط.

هذا خلل أعمق من موضع واحد: القفل نفسه (وقراءة/كتابة الأرشيف كلها) داخل `sync_service.py`
كانت معطّلة كلياً بالتطبيق الفعلي، مو خاصة بـ`reconcile` فقط.

كذلك: ملفات ثانية (`upload_routes.py`, `reports_routes.py`, `ai_helpers.py`) كل وحدة
تعرّف `SAVE_LOCK = threading.RLock()` مستقلة خاصة فيها — ثلاث أقفال منفصلة غير متزامنة
مع بعض لعمليات كتابة الأرشيف (خارج نطاق هذا الإصلاح، لكن مذكور هنا للتوثيق).

## الإصلاح

بدل التهيئة الساكنة المقترحة أصلاً (`_save_lock = threading.Lock()` عند التعريف)، الجذر
الحقيقي هو غياب استدعاء `bind_archive_runtime` من نقطة التشغيل الفعلية. الإصلاح:

بـ`backend/app/main.py`، داخل `create_app()`:
```python
from app.services.ai_helpers import configure_application_logging, load_archive, save_archive, SAVE_LOCK
from app.services.sync_service import bind_archive_runtime
...
bind_archive_runtime(load_archive, save_archive, SAVE_LOCK)
```
استُخدم `SAVE_LOCK`/`load_archive`/`save_archive` الموجودين أصلاً بـ`ai_helpers.py`
(مستخدَمين هناك فعلياً بعمليات حفظ أخرى، أسطر 476 و974) بدل اختراع قفل رابع منفصل.

أثناء التحقق الفعلي ظهر خطأ ثانٍ منفصل تماماً بعد إصلاح `_save_lock`:
`NameError: name 'archive_repository' is not defined` — لأن `ai_helpers.load_archive()`/
`save_archive()` (أسطر 239-245) يستدعيان `archive_repository.*` بدون استيرادها بالملف
(كانت دوال ميتة فعلياً لأن كل الـroutes الأخرى تستورد `load_archive`/`save_archive`
مباشرة من `app.repositories.archive_repository`، لا من `ai_helpers`). أُضيف:
```python
from app.repositories import archive_repository
```
بأعلى `ai_helpers.py`.

## التحقق الفعلي

- تشغيل الباك اند فعلياً (`python -m app.main`) + `POST /api/sync/reconcile` بعد
  استرجاع إعدادات مزامنة حقيقية (راجع `2026-09-02_backend_sync_config_data_loss_incident_and_fix.md`):
  رجع `200` و`{"success": true, "local_count": 2474, "server_count": 2474, "pulled_in_count": 0, "pushed_immediate": 0, "will_push_count": 0, "errors": []}`
  — لا مزيد من الخطأ الأصلي ولا `NameError` الثانوي.
- `POST /api/sync/now`: رجع `200` و`{"success": true, ...}`.
