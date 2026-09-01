# إصلاح معاينة السعر بمودال المراجعة الفردي حسب نوع المنتج

**التاريخ:** 2026-09-01
**الملف المعدَّل:** `extension/content.js`، دالة `renderNewProductForm`

## التعديل

بدالة `renderNewProductForm` (مودال مراجعة المنتج الفردي)، كان حساب الرسم
المضاف يجري **قبل** حتى معرفة نوع المنتج:

```js
const addedFee = Number(extractorConfig.AddedFeeYuan || 0);
...
const detectedProductType = detectProductType(sourceText);
```

صار الترتيب معكوساً، مع تفرّع `addedFee` حسب `detectedProductType` — بنفس
منطق `submitProduct` و`prepareBatchDraftForStore` تماماً:

```js
const detectedProductType = detectProductType(sourceText);
const addedFee = detectedProductType === 'watches'
    ? Number(extractorConfig.WatchFlatFeeYuan || 0)
    : Number(extractorConfig.AddedFeeYuan || 0);
```

## السبب

الإكستنشن عندها قيمتا رسم منفصلتان بالإعدادات: `AddedFeeYuan` (250 يوان،
رسم الأحذية) و`WatchFlatFeeYuan` (600 يوان، رسم الساعات). دالة المعاينة كانت
تستخدم `AddedFeeYuan` دايماً بغض النظر عن نوع المنتج الفعلي المكتشَف —
فتعرض للساعات سعراً أقل من المُرسَل فعلياً وقت الرفع (مثال: سعر أساسي 1000
يوان وExchangeRate=0.5 → المعاينة تعرض (1000+250)×0.5=625 ريال، بينما
المُرسَل فعلياً (1000+600)×0.5=800 ريال).

هذا هو نفس صنف الخطأ الموثَّق سابقاً وأُصلح بمساري الإرسال الفعلي
(`submitProduct` سطر ~2390 سابقاً، و`prepareBatchDraftForStore` سطر ~3654
سابقاً) — موضع المعاينة (~1670 سابقاً) بقي معطوباً تجميلياً فقط: السعر
المُرسَل كان صحيحاً، لكن الرقم المعروض بالمعاينة قبل التأكيد كان مضلِّلاً
للمستخدم.

## كيف يعمل المنطق الجديد

`detectedProductType` (نتيجة `detectProductType(sourceText)`) تُحسب أولاً،
ثم يُستخدم نفس التفرّع الموجود بمساري الإرسال: لو `'watches'` يُستخدم
`WatchFlatFeeYuan`، غير ذلك (الأحذية والأنواع الأخرى) يُستخدم `AddedFeeYuan`.
بما إن نفس متغيّر `detectedProductType` يُمرَّر لاحقاً كـ`productType` بكائن
context المُرسَل للمعالجة (`submitProduct`)، الرقم المعروض بالمعاينة صار
مطابقاً تماماً للسعر الفعلي المُرسَل.

## التحقق الفعلي

- `node --check extension/content.js` → نجح بدون أخطاء صياغة.
- تأكدت بـgrep إن `detectedProductType === 'watches'` يظهر بموضع حساب
  `addedFee` (سطر 1580 بالنسخة الحالية)، وإن باقي استخدامات
  `detectedProductType` بنفس الدالة (عرض نوع المنتج بالمعاينة، وتمريره
  كـ`productType` بالـcontext) لم تتأثر بإعادة الترتيب.
