# الاعتماد الكامل على /api/brands، حذف BrandMapJson المحلية

**التاريخ:** 2026-09-02
**الملفات المعدَّلة:** `extension/content.js`، `extension/popup.js`، `extension/popup.html`،
`extension/config.js`

## الفرق بين الطلب الأصلي والتصميم الفعلي المطبَّق

الطلب الأصلي افترض إن `resolveBrandId()` تقدر تصير `async` تقرأ `chrome.storage`
مباشرة بمنتصف تنفيذها. **الفحص الفعلي كشف العكس تماماً** — `resolveBrandId` دالة
`sync` بحتة، بـ9 نداءات فعلية موزّعة عبر مسار الاستخراج الحي (منها اثنان داخل
event listeners مباشرة: `addEventListener('input'/'change', () => {...})`). تحويلها
لـ`async` كان يتطلب تعديل بنيوي بكل الـ9 نداءات. **تم عرض هذا على المستخدم وقرر:
إبقاء `resolveBrandId` sync كما هي، واستخدام ذاكرة محلية (in-memory cache) متزامنة
بدل تحويلها لـasync.**

## التصميم النهائي المتفَق عليه

- **`popup.js`** يجيب `/api/brands` حياً من السيرفر (المُزامن على Hostinger، يتحكم فيه
  الأدمن حصراً عبر `/api/brands/add`) **بكل مرة يُفتح فيها popup** — أي موظف يفتح
  popup يحصل تلقائياً على آخر نسخة، بدون أي حاجة لتحديث يدوي من طرفه. النتيجة
  الناجحة تُحفظ بـ`chrome.storage.local['alphacode_brands_cache']` (مصفوفة
  `[{id, name}, ...]` - نفس شكل استجابة `/api/brands` تماماً).
- **`content.js`** تقرأ هذا الكاش **مرة وحدة** عند بدء تشغيل content script (داخل
  `loadConfiguration()`، قبل ظهور أي زر استخراج) وتبنيه بذاكرة محلية sync
  (`brandNameToIdMap`) - عشان `resolveBrandId()` تبقى sync بحتة. لو الكاش فاضي (أول
  استخدام قبل ما حد يفتح popup أبداً)، تسوي fetch احتياطي مباشر بنفسها لـ`/api/brands`
  (عندها وصول شبكة مباشر للباك اند أصلاً)، وتخزّن النتيجة بالكاش للمرات القادمة.
  ما تعيد فحص السيرفر بكل صفحة مورد جديدة (لتفادي تحويل `resolveBrandId` لasync) -
  البيانات تتحدّث فعلياً بمجرد ما المستخدم يفتح popup مرة، بغض النظر مين فتحه.

هذا يطابق النموذج المطلوب: **مصدر الحقيقة الوحيد هو السيرفر (كتابة الأدمن فقط)،
والموظفون يتزامنون معه تلقائياً بفتح popup (نفس آلية الـ"مزامنة كل فترة")، والكاش
المحلي يخلي content.js أسرع بدون طلب شبكة إضافي بكل صفحة.**

## التعديل بالتفصيل

- **`content.js`**: متغير جديد `let brandNameToIdMap = {}` + ثابت
  `BRANDS_CACHE_STORAGE_KEY = 'alphacode_brands_cache'`. دالة `parseBrandMap()`
  صارت `return brandNameToIdMap;` مباشرة (بدل تحليل `BrandMapJson`) - **خوارزمية
  المطابقة بـ`resolveBrandId`/`canonicalBrandName` لم تتغيّر إطلاقاً**، فقط مصدر
  البيانات. دالتان جديدتان: `brandListToNameMap(brands)` (تحويل مصفوفة `{id,name}`
  لخريطة اسم→id نظيفة، بنفس منطق التنظيف القديم `canonicalBrandAlias` + رفض id غير
  صالح) و`loadBrandsCache()` (تملأ `brandNameToIdMap` من الكاش أو fetch احتياطي).
  استدعاء `await loadBrandsCache();` أُضيف داخل `loadConfiguration()`.
- **`popup.js`**: `loadLocalBrandMap()` (كانت تقرأ `BrandMapJson`) استُبدلت بـ
  `loadBrandsCacheFallback()` (تقرأ `alphacode_brands_cache` نفسه - احتياط كامل لو
  فشل نداء `/api/brands` الحي، بدل الرجوع لخريطة ثابتة محلية). `loadBrandsIntoSelect()`
  صارت تكتب `chrome.storage.local.set({alphacode_brands_cache: brands})` بعد أي نجاح.
  حذفت التحقق `JSON.parse(config.BrandMapJson)` من `readForm()`.
- **`popup.html`**: حذف حقل `<textarea id="BrandMapJson">` بالكامل.
- **`config.js`**: حذف مفتاح `BrandMapJson` الافتراضي من `ALPHACODE_DEFAULT_CONFIG`.
- **تنظيف إضافي:** `content.js` عندها نسخة احتياطية محلية من الإعدادات الافتراضية
  (`const DEFAULT_CONFIG = globalThis.ALPHACODE_DEFAULT_CONFIG || {...}` - تُستخدم
  فقط لو config.js فشل بالتحميل) كانت فيها `BrandMapJson: '{"Air Jordan":6}'` مكرر
  ثابت - حذفته أيضاً للاتساق.

## التحقق الفعلي

- `node --check` نجح على `content.js`, `popup.js`, `config.js`.
- `python -m pytest -q`: 7/7 (بلا تغيير فعلي بالباك اند بهذا البند، تحقق سلامة عام).
- `grep` شامل بعد التعديل: صفر مرجع فعلي متبقي لـ`BrandMapJson` بأي ملف (فقط تعليقات
  توثيقية تشرح إنها انحذفت).
- **تحقق رقمي:** بنيت `brandListToNameMap()` على بيانات `/api/brands` الحقيقية (تحقق
  فعلي بـcurl على الباك اند الشغّال: 5 براندات) وقارنتها بخريطة `BrandMapJson`
  القديمة المطابقة لنفس البيانات — **تطابق دلالي كامل** (فرق ترتيب مفاتيح فقط
  بالمقارنة الأولى النصية، أُثبت بمقارنة entries مرتّبة إنه لا فرق فعلي). اختبرت
  `resolveBrandId` بالخريطة الجديدة على حالتين (اسم مطابق فعلي، اسم غير معروف) —
  كلاهما رجع النتيجة الصحيحة (تطابق مباشر، وfallback لـ`BrandId` العام).
- **لم أفتح Chrome فعلياً** للتأكيد البصري النهائي (نفس القيد بكل الجلسة) — يحتاج
  اختبار يدوي: افتح popup مرة (يملأ الكاش)، افتح صفحة مورد (content.js يقرأ الكاش
  فعلاً)، جرّب استخراج منتج ببراند موجود بالسيرفر والتأكد BrandId يتحدد صح.
