# إصلاح `/api/health` — مؤشرا "متصل" و"الذكاء الاصطناعي" يطلعون أحمر رغم إن السيرفر شغّال

**التاريخ:** 2026-09-02
**الملف المعدَّل:** `backend/app/api/routes/core_routes.py`

## التشخيص — فرضيتا المستخدم مرفوضتان، السبب الحقيقي مختلف تماماً

**الفرضية 1 (config.js/BackendPort ما جاهز وقت الفحص):** مرفوضة. حاكيت تحميل
`config.js` ثم تقييم سطر `API_BASE` بـpopup.js بنفس ترتيب تحميل السكربتات الحقيقي
بـ`popup.html` (`config.js` قبل `popup.js`، سكربتات كلاسيكية بدون async/defer) — النتيجة
`API_BASE = http://127.0.0.1:5000` صحيحة دايماً، ما فيه أي احتمال race حقيقي هنا.

**الفرضية 2 (كومت دمج البراند عطّل ترتيب استدعاء checkServer):** مرفوضة. `git show`
على كومت `d817b47` (دمج البراند) يبيّن: قبل الكومت، `loadBrandsIntoSelect()` كانت
تُستدعى بدون `await` قبل `try { await loadSavedConfig(); await checkLoginState(); await
Promise.all([checkServer(), ...]) }`. بعد الكومت، صارت `await loadBrandsIntoSelect()`
أول سطر **جوا** نفس الـtry block، بنفس الترتيب بعدها بالضبط (`loadSavedConfig` →
`checkLoginState` → `Promise.all([checkServer, ...])`). موضع `checkServer()` النسبي
لم يتغيّر إطلاقاً — فقط أُضيف انتظار واحد قبله.

## السبب الحقيقي (تحقق فعلي بـcurl + محاكاة منطق popup.js حرفياً)

`curl http://127.0.0.1:5000/api/health` (قبل الإصلاح) رجع:
```json
{"root_dir":"D:/sooqify","root_dir_configured":true,"status":"ok","sync_enabled":true}
```
**بدون حقل `success` إطلاقاً.** بينما `checkServer()` بـ`popup.js` يفحص:
```js
if (!response.ok || !data.success) { throw new Error(...); }
```
بما إن `data.success` غير موجود (`undefined`)، `!data.success` = `true` **دايماً** —
الفحص يفشل ويرمي خطأ حتى لو `response.ok` صحيح والسيرفر شغّال فعلاً 200 OK. كلا
المؤشرين (`serverDot`, `aiText`) يُحدَّثان داخل نفس try/catch بـ`checkServer()`، فيفشلان
مع بعض دايماً — يطابق تماماً العرض المُبلَّغ (الاثنين أحمر بنفس الوقت).

**هذا مو تعديل من هذي الجلسة.** بحث بتاريخ git (`git log -p -- backend/app.py`) كشف:
النسخة الأصلية القديمة لـ`/api/health` (قبل هدم `app.py`) كانت ترجع مجموعة حقول كاملة:
`success`, `service`, `version`, `ai_provider`, `ai_configured`, `ai_providers`,
`default_ai_model`, `needs_folder_setup`, بالإضافة لـ`root_dir`/`sync_enabled`. نسخة
`core_routes.py` الحالية (المبنية أثناء إصلاح Phase 5 اللي أضاف الـ5 مسارات الناقصة -
موثّق بـ`HANDOFF_DOCUMENTATION.md`) كانت **إعادة بناء مبسّطة أسقطت كل هذي الحقول** بدون
قصد، غالباً وقت كتابة النسخة الجديدة من الصفر بدل نقل المنطق الأصلي حرفياً. يعني هذا
خلل موجود منذ اكتمال Phase 5 (قبل هذي الجلسة بكثير)، مو ناتج عن أي تعديل حديث - على
الأغلب المستخدم اختبر المؤشرين آخر مرة قبل أو مباشرة بعد Phase 5 بدون إعادة اختبار لاحقاً.

## الإصلاح

استرجعت كل الحقول المفقودة بـ`health_check()` (`core_routes.py`)، بنفس منطق الحساب
الأصلي (قراءة `GROQ_API_KEY`/`OPENAI_API_KEY`/متغير المفتاح المخصّص من البيئة،
`normalize_ai_provider` من `ai_helpers.py` بدل نسخة محلية مكررة)، مع تحديث `version`
لـ`5.7.1` (يطابق ترقية الإصدار المطلوبة بنفس الجلسة).

## التحقق الفعلي

- `python -c "import py_compile; ..."` نجح.
- شغّلت الباك اند فعلياً + `curl http://127.0.0.1:5000/api/health`: رجع الآن
  `{"success":true, "version":"5.7.1", "ai_configured":true, "ai_provider":"groq",
  "default_ai_model":"llama-3.1-70b-versatile", ...}` — كل الحقول المطلوبة موجودة.
- حاكيت منطق `checkServer()`/`formatAiProvider()` **حرفياً** بـNode على الاستجابة
  الحقيقية: النتيجة `dot=ok (GREEN)`, `aiText: "GROQ جاهز — llama-3.1-70b-versatile"` —
  تأكيد مباشر إن المؤشرين هيرجعوا أخضر.
- **لم أفتح Chrome فعلياً** للتأكيد البصري النهائي (نفس القيد بكل الجلسة) — لكن المحاكاة
  الحرفية للمنطق ضد بيانات حقيقية توفر تحقق قوي بديل. يُنصح بـReload الإكستنشن وفتح
  popup للتأكيد البصري النهائي.
