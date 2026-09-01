# تبديل منفذ تلقائي للباك اند + قراءة المنفذ ديناميكياً من الإكستنشن

**التاريخ:** 2026-09-01
**الملفات المعدَّلة:** `backend/app/main.py`، `extension/config.js`، `extension/content.js`،
`extension/popup.js`، `extension/admin_autofill.js`، `extension/background.js`،
`extension/manifest.json`
**ملف جديد:** `start_backend.bat` (جذر المشروع)

## التعديل

### الباك اند (`app/main.py`)
دالة جديدة `find_available_port(start_port=5000, max_attempts=5)`: تجرّب 5000 أولاً،
ولو مشغول تجرّب 5001-5004 بالتسلسل عبر محاولة `bind()` فعلية على كل منفذ. `if __name__
== "__main__"` يستدعيها ويشغّل `app.run(port=chosen_port, ...)`، مع طباعة تحذير واضح
بالطرفية لو المنفذ اختلف عن 5000.

### الإكستنشن
مفتاح جديد `BackendPort: 5000` بـ`config.js` (`ALPHACODE_DEFAULT_CONFIG`). كل الملفات
الأربعة اللي عندها ثابت `http://127.0.0.1:5000` صارت تبنيه ديناميكياً:
`` `http://127.0.0.1:${(globalThis.ALPHACODE_DEFAULT_CONFIG || {}).BackendPort || 5000}` ``.
`background.js` (service worker كلاسيكي، بدون `type: module`) يحتاج `importScripts('config.js')`
بالأعلى عشان يوصله `globalThis.ALPHACODE_DEFAULT_CONFIG` أصلاً.
`manifest.json`: `host_permissions` صار فيه 5000 إلى 5004 صراحة (Manifest V3 يتطلب
إعلان الصلاحيات مسبقاً، ما فيه اكتشاف ديناميكي حقيقي من طرف الإكستنشن).

### `start_backend.bat` (جديد)
ملف تشغيل مؤقت بجذر المشروع: يجرّب `python` ثم `py`، ويشغّل `python -m app.main`
من `backend/`.

## السبب

قبل هذا التعديل، أي عملية باك اند سابقة عالقة على المنفذ 5000 (نسيان إغلاق نافذة،
تعليق العملية) تمنع أي تشغيل جديد بالكامل بدون رسالة واضحة، والمستخدم يحتاج يقتل
العملية يدوياً كل مرة. الحل: الباك اند ينتقل تلقائياً لمنفذ بديل، والإكستنشن يقرأ
نفس رقم المنفذ من مكان واحد (`config.js`) بدل ما يكون مكتوباً حرفياً بأربع ملفات JS
منفصلة.

## 🔴 خلل مكتشف بالتحقق الفعلي وتم إصلاحه بنفس الجلسة

التطبيق الأول لـ`find_available_port` استخدم `SO_REUSEADDR` بفحص `bind()`. اختبار
حقيقي (تشغيل نسختين متتاليتين + `netstat -ano`) كشف: **على Windows، `SO_REUSEADDR`
يخلي `bind()` ينجح حتى لو المنفذ مشغول فعلياً بسوكيت آخر LISTENING** — سلوك مختلف
جذرياً عن Linux. النتيجة: النسخة الثانية "ظنّت" 5000 متاح وحاولت تربط عليه هي كمان،
فصار عندنا فعلياً عمليتين LISTENING على نفس المنفذ بنفس الوقت (`netstat` أظهر
PIDين مختلفين على `127.0.0.1:5000` بنفس الوقت) — سلوك غير محدَّد لمين يستقبل أي طلب.

**الإصلاح:** حذف `probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)` بالكامل.
الفحص لا يفتح اتصال فعلي ولا يترك `TIME_WAIT`، فما يحتاج `SO_REUSEADDR` أصلاً؛ حذفه
يرجّع سلوك الربط الحصري الصحيح.

## التحقق الفعلي (بعد إصلاح SO_REUSEADDR)

- `python -c "import py_compile; ..."` نجح على `app/main.py`.
- شغّلت نسخة أولى فعلية (`python -m app.main`) → `netstat -ano | grep ":5000"` أظهر
  PID وحيد LISTENING.
- شغّلت نسخة ثانية بالتوازي والأولى لسا شغّالة → طبعت فعلياً:
  `[app.main] Port 5000 is busy - using port 5001 instead.` وربطت فعلياً على 5001.
- `netstat -ano | grep ":500[01] "` بعد تشغيل الاثنتين: PID مختلف تماماً على كل
  منفذ (لا تداخل) — تأكيد قاطع إن الإصلاح يعمل.
- `curl http://127.0.0.1:5000/api/health` و`curl http://127.0.0.1:5001/api/health`:
  كلاهما رجع 200 برد صحيح مستقل.
- `node --check` نجح على `content.js`, `popup.js`, `admin_autofill.js`, `background.js`,
  `config.js`. `manifest.json` تحقق صحته كـJSON صالح.
- أوقفت كل العمليات التجريبية بعد التحقق (لا عمليات باك اند خلفية عالقة).
- **لم أختبر فعلياً** أن الإكستنشن نفسها (Chrome حقيقي) تتصل بمنفذ غير 5000 لما
  `BackendPort` يتغيّر بـ`config.js` — هذا يحتاج تحميل الإكستنشن بمتصفح حقيقي، خارج
  الأدوات المتاحة لي بهالبيئة. الكود تحقق منطقياً (نفس النمط بكل الملفات الأربعة)
  وسياقياً (`importScripts` صحيح لأن `background.js` service worker كلاسيكي)، لكن
  التأكيد البصري بمتصفح فعلي يحتاج اختبار يدوي منك.
