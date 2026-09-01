# حذف نظام حظر الصور (pHash) من الإكستنشن

**التاريخ:** 2026-09-01
**الملفات المعدَّلة:** `extension/content.js`، `extension/content.css`

## التعديل

حُذف نظام حظر الصور الملوثة بالكامل من `content.js` و`content.css`:

- من `content.js`: الثابت `BANNED_SIGS_STORAGE_KEY`، والدوال `loadBannedSigs`،
  `saveBannedSigs`، `computeImagePHash`، `pHashSimilarity`، `banImageUrl`،
  `filterBannedImages` (~103 سطر، من نهاية `logPricePattern` حتى بداية
  `loadConfiguration`).
- زر 🚫 (`.batch-ban-image-btn`) ومستمع النقر عليه من بطاقة صورة واجهة مراجعة
  الدفعة (داخل حلقة `draft.images.forEach` بمكان بناء الـ image grid).
- تعليق بالقرب من `extractAllImages` كان يصف زر 🚫 كـ"القناة الوحيدة للاستبعاد"
  — عُدّل ليعكس عدم وجود أي قناة استبعاد إطلاقاً بعد الحذف.
- من `content.css`: قواعد `.batch-ban-image-btn` و`.batch-image-choice:hover .batch-ban-image-btn`
  (~20 سطر).

النتيجة: `content.js` نزل من 4089 إلى 3986 سطر، `content.css` من 2398 إلى 2378 سطر.

## السبب

الميزة كانت "نصف موصولة": `banImageUrl()` كانت تُستدعى فعلاً من زر 🚫 وتحفظ
توقيع الصورة (pHash) بـ`chrome.storage`، لكن `filterBannedImages()` — الدالة
المفروض تُطبّق قائمة الحظر فعلياً على أي استخراج جديد — لم تكن تُستدعى من أي
مكان بكامل المشروع (تحقق بـgrep شامل على `filterBannedImages(` قبل وبعد
التعديل). النتيجة: المستخدم يضغط 🚫 ويحس إن الحظر اشتغل (يُحفظ التوقيع فعلاً
ويُحذف من الدفعة الحالية)، لكن ما له أي أثر على أي استخراج مستقبلي — سلوك
مضلِّل. القرار (بعد عرض الخيارين: توصيل الفلتر أو حذف الميزة) كان الحذف.

## كيف يعمل الوضع الجديد

لا يوجد أي فلترة تلقائية أو يدوية للصور بعد الآن — كل الصور المكتشفة بالاستخراج
تظهر كاملة بواجهة المراجعة (سواء الفردية أو الدفعة)، ويختار المستخدم يدوياً
أي صور يرفعها عبر checkbox الرفع الموجود أصلاً (`batch-image-check`)، بدون أي
طبقة حظر إضافية.

## التحقق الفعلي

- `node --check extension/content.js` → نجح بدون أخطاء صياغة.
- grep شامل على `extension/*.js *.css *.html` للكلمات:
  `banImage`, `bannedImage`, `filterBanned`, `computeImagePHash`,
  `pHashSimilarity`, `loadBannedSigs`, `saveBannedSigs`, `BANNED_SIGS`,
  `batch-ban-image-btn` → **صفر نتائج**.
