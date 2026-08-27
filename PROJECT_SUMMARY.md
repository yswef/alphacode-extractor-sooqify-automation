# PROJECT_SUMMARY.md — AlphaCode Extractor / Sooqify Automation

---

## 1. القواعد المتبعة

> منسوخة بالحرف كما وردت من المستخدم (الملف كان فارغًا عند القراءة، فلا توجد نسخة سابقة أخرى للنسخ منها).

```markdown
---
description:  قواعد العمل الإلزامية - يجب الالتزام بها في كل رد
---

1. ممنوع التخمين أو الافتراض: لا تصلح أو تجاوب عن طريق وضع افتراضات غير مؤكدة. 
   لو في شيء مش متأكد منه، أو مكان المشكلة مش واضح، أو مش فاهم جزئية معينة - توقف واسأل، ولا تكمل بالتخمين.

2. ممنوع تعديل المنطق الحالي (Logic) في الكود عند اكتشاف مشاكل أو عيوب.
   بدل التعديل المباشر: اعرض الحلول المقترحة في نهاية ردك فقط، وانتظر الموافقة.

3. لو في أي غموض أو عدم يقين: اسأل قبل ما تنفذ أي شيء.
   لو المشكلة تحتاج تحديد مكانها بالضبط: اشرح الخطوات اللي هنتبعها لتحديد المكان،
   ولو ممكن، اقترح سكربت Bash أو PowerShell بسيط يطلع ملف مخرجات (output file)
   يساعدنا نحدد المشكلة فين بالظبط.

4. ممنوع مراجعة الرسائل أو المحادثات السابقة (استهلاك توكنات كبير).
   خلي كل محادثة معزولة تمامًا عن غيرها.
   أي معلومة مهمة لازم تفضل موجودة، حطها في ملف خارجي بدل ما تعتمد على الذاكرة.

5. مع كل رد، أنشئ/حدّث ملف PROJECT_SUMMARY.md مقسم كالتالي:
   - القواعد المتبعة (بالحرف، كامل النص)
   - معلومات مهمة عن المشروع
   - تفاصيل مهمة (بنية الملفات، القرارات المتخذة)
   - أسلوب كتابة الكود المتبع في المشروع
   الهدف: أي محادثة أو موديل جديد يقدر يكمل من الملف ده مباشرة.

6. الردود تكون ملخصة فقط: إيش اللي اتنفذ، وفي أي دالة/ملف، بشكل موجز.
   ممنوع الشرح التفصيلي إلا لو طلبت صراحة "اشرح".

7. قلل استهلاك التوكنات قدر الإمكان في كل رد.
   لو حسيت إن الاستهلاك بقى كبير في المحادثة الحالية، أوقف واديني ملخص تفصيلي
   كامل للمشروع + المطلوب مني + طريقة العمل، عشان أقدر أنقله لمحادثة تانية.
```

---

## 2. معلومات مهمة عن المشروع

- **الاسم:** AlphaCode Extractor v5.0.0 — Sooqify Batch Automation (حسب `README.md` وحسب `extension/manifest.json`: `"name": "AlphaCode Product Extractor"`, `"version": "5.0.0"`).
- **الوظيفة الأساسية:** إضافة Chrome خاصة (Manifest V3) + باكند Flask محلي، تستخرج بيانات منتجات من موقع مورّد (SZWEGO)، تولّد وصف منتج إنجليزي/عربي بالذكاء الاصطناعي (Groq)، تعالج الصور محليًا، وترفع المنتج (منتج واحد أو دفعة/Batch) تلقائيًا إلى لوحة تحكم متجر Sooqify (مبني على 6amMart)، مع دعم اختياري لمزامنة بين جهازين يعملان على نفس المتجر عبر سيرفر PHP خارجي.
- **الحجم الإجمالي (بالسطور):** إجمالي أسطر ملفات الكود الفعلية (Python + JavaScript + CSS + HTML) = **16,319 سطر** (تم القياس بـ `wc -l`)، موزّعة كالتالي:
  - `backend/app.py`: 3685
  - `extension/content.js`: 3817
  - `extension/admin_autofill.js`: 2966
  - `extension/background.js`: 1496
  - `extension/popup.js`: 1646
  - `extension/content.css`: 1180
  - `extension/page_bridge.js`: 391
  - `extension/popup.html`: 481
  - `backend/Reports.py`: 198
  - `backend/watch_variant_extractor.py`: 120
  - `extension/config.js`: 118
  - `extension/admin_autofill.css`: 95
  - `extension/manifest.json`: 84
  - `backend/test_upload_main_image_only.py`: 35
  - `backend/requirements.txt`: 7
- **اللغات المستخدمة:** Python (باكند Flask)، JavaScript (إضافة كروم، Manifest V3، content scripts + service worker)، CSS، HTML، JSON (ملفات إعداد وقت التشغيل).
- **متطلبات التشغيل (حسب `README.md`):**
  - Windows 10/11.
  - Python 3.10+ مع مكوّن `tkinter` (لنافذة اختيار مجلد الحفظ).
  - Chrome أو Brave مع تفعيل Developer Mode.
  - جلسة تسجيل دخول فعّالة على Sooqify Admin في نفس بروفايل المتصفح.
  - مفتاح Groq API عند تفعيل توليد الذكاء الاصطناعي (متغيّر بيئة `GROQ_API_KEY`).
  - استضافة PHP (اختياري) فقط عند تفعيل مزامنة الجهازين.
  - حزم Python (من `backend/requirements.txt`): `Flask`, `Flask-Cors`, `pandas`, `openpyxl`, `Pillow`, `requests`, `certifi`. (`Reports.py` يذكر بالتعليقات أنه يحتاج أيضًا `reportlab`, وبشكل اختياري `arabic-reshaper` و`python-bidi` لدعم العربية في تقارير PDF — هذه الحزم غير مذكورة في `requirements.txt` نفسه).

---

## 3. تفاصيل مهمة

### 3.1 شجرة الملفات الكاملة (من الأرشيف المرفوع فعليًا، بدون `__pycache__`/`.pytest_cache`)

```
.gitignore
CHANGELOG.md                          سجل تغييرات نصي مفصّل لكل إصدار (v3.2.0 حتى v5.0.0)
README.md                             التوثيق الرئيسي: الوظائف، البنية، الإعداد، استكشاف الأخطاء
backend/
  app.py                              تطبيق Flask الرئيسي (37 route، ~140 دالة top-level): AI، صور، أرشيف، Excel، مزامنة، سجلات
  Reports.py                          توليد تقارير PDF يومية/شهرية من الأرشيف (reportlab)، معزول عن app.py الكبير
  watch_variant_extractor.py          يبني رسالة/سكيمة JSON لاستخراج ألوان وأسعار منتجات الساعات فقط (الاتصال الفعلي بالـ AI في app.py)
  test_upload_main_image_only.py      اختبار pytest لدالة resolve_store_images_for_upload (وضع "الصورة الرئيسية فقط")
  requirements.txt                    قائمة حزم Python المطلوبة
  paths_config.json                   ملف تشغيلي: مجلد الحفظ المختار على الجهاز (RootDir)
  sync_config.json                    ملف تشغيلي: إعدادات مزامنة الجهازين (رابط سيرفر + توكن + اسم المستخدم) — يحتوي بيانات حساسة فعلية
  sync_queue.json                     ملف تشغيلي: قائمة انتظار عناصر لم تُرفع للسيرفر المركزي بعد (فارغة حاليًا)
  sync_state.json                     ملف تشغيلي: طوابع زمنية لآخر Pull/Push ومزامنة
  reports_config.json                 ملف تشغيلي: بيانات دخول (Username/Password) تستخدمها التقارير — بيانات حساسة فعلية
  logs/alphacode.log                  ملف سجل نصي فعلي تم إنتاجه من تشغيل سابق للتطبيق
extension/
  manifest.json                       Manifest V3: صلاحيات، content_scripts (SZWEGO + Sooqify)، service worker، web_accessible_resources
  config.js                           القيم الافتراضية المشتركة (IIFE يضبط globalThis.ALPHACODE_DEFAULT_CONFIG)
  content.js                          يعمل على صفحات SZWEGO: استخراج بيانات المنتج، واجهة المراجعة، تجهيز الدفعة (Batch)
  content.css                         تنسيق عناصر الواجهة المُحقنة في صفحة SZWEGO
  admin_autofill.js                   يعمل على صفحة إضافة منتج في Sooqify: تعبئة النموذج تلقائيًا وإرساله
  admin_autofill.css                  تنسيق لوحة التحكم المُحقنة في صفحة Sooqify
  background.js                       Service worker: قائمة انتظار الإرسال التسلسلية، رفع الصور، الإشعارات، استرجاع بعد توقف
  page_bridge.js                      يُحقن في "MAIN world" لقراءة بيانات React والتقاط استجابات الشبكة (لاسترجاع معرض الصور الكامل)
  popup.html                          واجهة الـ popup (تبويبات: الإعدادات، المزامنة والمجلد، إصلاح البيانات، إلخ)
  popup.js                            منطق الـ popup: الإعدادات، طلبات المورد/المنتج، البيانات، التشخيص
  price_patterns.json                 قائمة Regex patterns لاستخراج السعر من نص المورد
  icon128.png / icons/icon16.png / icons/icon48.png / icons/icon128.png   أيقونات الإضافة
```

> **ملاحظة (وليست تخمينًا — ملاحظة تباين فعلي):** يذكر `README.md` (قسم "Project structure") مجلدين إضافيين غير موجودين فعليًا في هذا الأرشيف المرفوع: `hostinger/alphacode_storage/` (ملفات PHP لسيرفر المزامنة المركزي مثل `sync.php`, `db.php`, `db_config.php`, إلخ) و`docs/` (ملفات PDF للتوثيق)، بالإضافة إلى `LICENSE` وملفات `.bat` (`INSTALL_REQUIREMENTS.bat`, `START_ALPHACODE.bat`). هذه العناصر **غير موجودة** في الملف المضغوط الذي تم رفعه، لذلك لم تُدرَج في الشجرة أعلاه ولم أفترض محتواها.

### 3.2 تدفق العمل الأساسي (خطوة بخطوة، من `README.md` + كود `content.js`/`background.js`/`app.py`)

1. فتح صفحة قائمة منتجات على SZWEGO، وتحديد منتج واحد أو أكثر عبر **تحديد للدفعة**.
2. الضغط على **مراجعة وإضافة** في شريط أدوات AlphaCode الثابت (`content.js`).
3. مراجعة كل منتج عبر شرائح سابق/تالي، وتعديل المحتوى الإنجليزي/العربي، البراند، السعر، والمقاسات عند الحاجة.
4. بدء الدفعة (Batch): يُرسل `content.js` بيانات كل منتج إلى الباكند (`/api/extract`, `/api/ai/generate`, `/api/dry-run`) لتجهيزها بتزامن محدود (`BatchPreparationConcurrency`).
5. `background.js` يدير قائمة انتظار تسلسلية (`chrome.storage.local`) وترسل كل منتج جاهز إلى `admin_autofill.js` على تبويب Sooqify واحد نشط في كل مرة.
6. `admin_autofill.js` يعبّئ نموذج إضافة المنتج في Sooqify (تصنيف، تصنيف فرعي، براند، وحدة، سعر، مخزون، مقاسات، متغيرات، ترجمات، صور) ثم يرسله.
7. الصورة الرئيسية فقط تُرسل لـ Sooqify افتراضيًا (`UploadMainImageOnly: true`)، بينما تُحفظ المعرض الكامل محليًا بجودة كاملة دون تعديل.
8. لوحة قائمة الانتظار العائمة تسمح بالإيقاف المؤقت/الاستئناف/الإلغاء/إعادة محاولة العناصر الفاشلة، مع إشعار نظام تشغيل بعد كل منتج وبعد اكتمال الدفعة.
9. (اختياري) عند تفعيل مزامنة الجهازين، يتواصل الباكند مع سيرفر PHP خارجي (`sync_call` في `app.py`) لحجز ID فريد قبل أي تنزيل صور، مع رجوع تلقائي (fallback) للترقيم المحلي إذا تعذّر الوصول للسيرفر.

### 3.3 قرارات تصميم مذكورة صراحة في الكود/التوثيق (وليست استنتاجًا)

- **رفع الصورة الرئيسية فقط افتراضيًا (v5.0.0):** تغيير صريح مذكور في `CHANGELOG.md` — تبقى باقي صور المعرض على الجهاز المحلي فقط ما لم يُعطَّل الخيار يدويًا.
- **عدم إعادة المحاولة التلقائية عند HTTP 429 من مزوّد الذكاء الاصطناعي:** مذكور صراحة في `CHANGELOG.md` (v4.5.0) وفي كود `app.py` (`read_retry_after_seconds`)، مع إرجاع `retry_after_seconds` للإضافة بدل إعادة المحاولة فورًا.
- **بحث رسمي (Official research) اختياري فقط عند طلب المشغّل صراحة (Regenerate)**، ومقصور على النطاق الرسمي للبراند فقط، بطلب بحث واحد فقط لكل إعادة توليد (مذكور في `README.md` وقسم `generate_official_research` في `app.py`).
- **البراند المولَّد بالذكاء الاصطناعي يجب أن يكون ضمن `BrandMapJson`**، وإلا يُستخدم براند المتجر المُهيّأ بدلًا منه (`resolve_allowed_brand` في `app.py`، ومذكور في `README.md`).
- **منع تكرار نص البراند (`Air Jordan` / `إير جوردن`) في عنوان المنتج**، مذكور في `README.md` وموجود كدالتين منفصلتين: `enforce_product_name_rules` و`enforce_arabic_product_name`.
- **تبويب واحد نشط للإرسال إلى Sooqify في كل مرة**، لتقليل استهلاك الذاكرة ومنع اختلاط بيانات المنتجات (مذكور صراحة في `README.md`).
- **لا مسار حفظ افتراضي مثبت في الكود منذ v4.5.2** — يُحظر حفظ المنتج حتى يختار المستخدم مجلدًا صراحة عبر نافذة نظام تشغيل أصلية (`open_native_folder_dialog` في `app.py`، ومذكور في `CHANGELOG.md`).
- **مزامنة الجهازين تتراجع محليًا (local fallback) عند تعذّر الوصول للسيرفر المركزي**، بدل حظر المستخدم، مع تعليم العنصر بـ `local_fallback` لمراجعة لاحقة (مذكور في `README.md` و`CHANGELOG.md`).
- **تهدئة تلقائية (cooldown) عند استجابة HTTP 403 من سيرفر المزامنة (افتراضيًا 300 ثانية)، مع تباعد بين الطلبات (افتراضيًا 0.3 ثانية) أثناء المطابقة الكاملة**، والقيمتان ثوابت أعلى `backend/app.py` (`SYNC_THROTTLE_COOLDOWN_SECONDS`, `SYNC_REQUEST_PACING_SECONDS`)، مذكورتان صراحة في `README.md`.
- **الاختبار الموجود (`test_upload_main_image_only.py`) يثبت صراحة أن دالة `resolve_store_images_for_upload` يجب أن تُبقي فقط الصورة الرئيسية عند تفعيل الخيار، وتُبقي كل الصور (مع تقديم الرئيسية أولًا) عند تعطيله.**

---

## 4. أسلوب كتابة الكود المتبع في المشروع

### قواعد التسمية الفعلية
- **Python (`backend/*.py`):** `snake_case` للدوال والمتغيرات (مثل `normalize_text`, `safe_int`, `get_product_image_dir`)، `PascalCase` للاستثناءات المخصصة (`RootDirNotConfigured`, `AIProviderRequestError`)، وثوابت بصيغة `UPPER_SNAKE_CASE` (`LOG_PATH`, `SYNC_THROTTLE_COOLDOWN_SECONDS`, `INVALID_MARKERS`).
- **JavaScript (`extension/*.js`):** `camelCase` للدوال والمتغيرات (`waitForCondition`, `extractSearchCode`, `bindExternalCopyTemplateControls`)، وثوابت الإعداد/العناوين بصيغة `UPPER_SNAKE_CASE` أو `PascalCase` حسب طبيعتها (`API_BASE_URL`, `DEFAULT_CONFIG` بمفاتيح `PascalCase` مثل `CategoryId`, `BrandMapJson` لأنها تُرسل مباشرة كحمولة API/نموذج).
- أسماء الدوال في الطرفين وصفية بفعل واضح (extract_/build_/resolve_/normalize_/save_/load_ في بايثون، وما يقابلها extract/build/resolve/normalize/save/load في جافاسكريبت).

### نمط التعليقات / الـ docstrings
- **ثنائي اللغة بشكل ثابت**: كل ملف Python وكل قسم JS رئيسي يبدأ بترويسة على شكل:
  ```
  // =========================================================
  // اسم الوحدة
  // Arabic: وصف بالعربية
  // English: Description in English
  // =========================================================
  ```
- **الدوال في `app.py` تقريبًا كلها تحمل docstring بصيغة موحّدة**: `"""Arabic: <شرح عربي>. English: <English explanation>."""` — نمط متكرر لوحظ فعليًا في عشرات الدوال المفحوصة (`normalize_text`, `compact_prompt_text`, `is_valid_marker`, `safe_int`, `safe_float`, `safe_bool`, `unique_text_values`, `sanitize_log_value`, `read_recent_log_lines`, `load_json_file`، وغيرها).
- تعليقات inline توضيحية ثنائية اللغة أيضًا بجانب الثوابت أو القرارات غير الواضحة من الاسم وحده (مثال في `background.js` بخصوص مهلة المنتج الواحد أثناء الدفعة).
- `Reports.py` يحتوي كتلة تعليق طويلة أعلى الملف تشرح متطلبات تشغيل اختيارية (حزم ودعم خط عربي) بالعربي والإنجليزي معًا، مع توضيح أن غيابها fallback آمن ولا يعطّل التطبيق.

### طريقة معالجة الأخطاء
- **بايثون:** استخدام مكثف لـ `try/except` (54 استخدامًا لـ `try:` في `app.py` وحده) غالبًا مع استثناءات محددة (`TypeError, ValueError` في `safe_int`/`safe_float`) وتسجيل عبر `logger.warning(...)` أو `logger.error(...)` بدل الصمت أو الانهيار، مع رسالة تتضمن قيمة الخطأ نفسها (`"...: %s", exc`).
- دوال تحويل آمنة متكررة كنمط ثابت: `safe_int`, `safe_float`, `safe_bool` تُرجع قيمة افتراضية (`fallback`) بدل رفع استثناء للمستدعي.
- كتابة الملفات الحساسة (الأرشيف، Excel) تتم عبر أنماط "كتابة ذرية" صريحة: `write_json_temp` / `save_json_atomic` / `create_temp_excel` ثم `commit_transaction` — كتابة لملف مؤقت ثم استبدال الملف النهائي، لتفادي تلف البيانات عند انقطاع منتصف الكتابة.
- استثناء مخصص خاص بحالة عمل محددة: `RootDirNotConfigured` بدل استخدام استثناء عام، ودالة `require_root_dir()` تتحقق وترفعه بوضوح.
- **جافاسكريبت:** 31 استخدامًا لـ `try {` في `content.js` وحده؛ وجود دوال "آمنة" مقابلة لنمط بايثون: `safeRuntimeMessage`, `safeStorageGet`, `safeStorageSet`, `safeStorageRemove`, `isExtensionContextAvailable`، للتعامل مع حالة انقطاع سياق الإضافة (`Extension context invalidated`) دون رمي الخطأ للمستخدم مباشرة.
- استجابات الـ AI عند فشل تحليل JSON: هناك مسار "إصلاح JSON مرة واحدة فقط" (`repair_json_once`) بدل إعادة محاولات غير محدودة.

### نمط متكرر لوحظ فعليًا في الكود (وليس افتراضًا عامًا)
- كل ملف إعداد وقت تشغيل (`paths_config.json`, `sync_config.json`, `sync_queue.json`, `sync_state.json`) له زوج دوال `load_*` / `save_*` منفصل في `app.py` (`load_paths_config`/`save_paths_config`, `load_sync_config`/`save_sync_config`, إلخ) يعتمد جميعها على `load_json_file` العام كأساس مشترك.
- فصل منطق الذكاء الاصطناعي الخاص بالساعات إلى ملف مستقل (`watch_variant_extractor.py`) مع توثيق صريح داخل الـ docstring بأن سبب الفصل هو عدم تكرار منطق الاتصال بالمزوّد (`send_ai_request`/`make_provider_payload` يبقيان في `app.py` فقط).
- فصل توليد تقارير PDF إلى `Reports.py` بنفس المنطق (تعليق صريح: "بمعزل عن app.py الكبير").