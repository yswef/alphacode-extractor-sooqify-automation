# حادثة فقدان بيانات: POST فاضٍ مسح إعدادات المزامنة + إصلاح وقائي

**التاريخ:** 2026-09-02
**الملفات المعدَّلة:** `backend/app/api/routes/sync_routes.py`، `backend/config/sync_config.json` (استرجاع يدوي)

## الحادثة

أثناء تشخيص أخطاء أخرى، أُرسل `POST /api/sync/config` بجسم فاضٍ `{}` لغرض فحص الحالة
الحالية فقط — بدون قراءة الإعدادات المحفوظة أولاً. `set_sync_config()` كانت تكتب
`ServerUrl` و`Enabled` و`AddedByName` كما وردت بالطلب حرفياً وبدون أي حماية (فقط `Token`
كان محمياً: `normalize_text(data.get("Token")) or existing["Token"]`). النتيجة: الحقول
الثلاثة انكتبت فاضية/`false` فوق `backend/config/sync_config.json`، ومسحت الإعدادات
الحقيقية للمستخدم (`ServerUrl`, `Enabled: true`, `AddedByName: "يوسف"`).

الملف مستثنى من git (`backend/config/sync_config.json` مذكور بـ`.gitignore:51`)، فما
كان فيه أي نسخة بتاريخ git لاسترجاعها. تم الاسترجاع يدوياً من قيم زوّدها صاحب المشروع
(مؤكَّدة من لقطات شاشة سابقة، ليست تخميناً):

- `ServerUrl`: `https://engyusef.alpha-code.net/alphacode_storage`
- `AddedByName`: `يوسف`
- `Enabled`: `true`
- `Token`: لم يتأثر (كان محمياً أصلاً) — تحقق حرفي أن القيمة المخزّنة تطابق
  `V0HEuwdDAPwCfNO10WYnnbtCd6YNpaSd0YUa` قبل عدم لمسه.

تم التحقق من صيغة `ServerUrl` مقابل `sync_call()` بـ`sync_service.py` (يبني
`f"{ServerUrl}/sync.php"`) قبل الكتابة — القيمة المسترجعة بدون `/` بآخرها فتطابق الصيغة
المتوقعة تماماً.

## الإصلاح الوقائي

`set_sync_config()` بـ`sync_routes.py` صارت تحمي الحقول الأربعة كلها من المسح غير
المقصود عبر POST فاضٍ أو جزئي، بنفس نمط `Token` الأصلي:

- `ServerUrl`, `AddedByName`: نص فاضٍ/غائب بالطلب → يُحافَظ على القيمة القديمة.
- `Enabled`: حقل منطقي — `False` الصريحة تُحترم (تعطيل مقصود من المستخدم)؛ فقط غياب
  الحقل تماماً (`None`) يرجع للقيمة القديمة، حتى لا تنكسر إمكانية تعطيل المزامنة فعلياً.

## التحقق الفعلي

- `GET /api/sync/config` بعد الاسترجاع اليدوي: رجعت القيم الثلاث صح
  (`Enabled: true`, `ServerUrl` الصحيح, `AddedByName: "يوسف"`).
- `POST /api/sync/reconcile` (سيرفر حقيقي، Token حقيقي): رجع `200` و
  `{"success": true, "local_count": 2474, "server_count": 2474, ...}` — تأكيد أن
  الإعدادات المسترجعة صحيحة وتعمل فعلياً مع سيرفر المزامنة الحقيقي.
- `POST /api/sync/now`: رجع `200` و`{"success": true, ...}`.
- بعد تطبيق الإصلاح، أُعيد إرسال `POST /api/sync/config` بجسم فاضٍ `{}` عمداً:
  `GET /api/sync/config` بعدها رجع نفس القيم الأربع بدون أي تغيير — الحماية تعمل فعلياً.

## الدرس

أي عملية تفحص حالة API عبر POST يجب أن تُسبَق بقراءة الحالة الحالية (`GET`) أولاً، لا أن
يُفترض أن جسم فاضٍ "آمن بلا تأثير جانبي" بدون التحقق من كود الـroute فعلياً.
