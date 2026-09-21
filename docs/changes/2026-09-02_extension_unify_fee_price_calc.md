# توحيد حساب الرسم/السعر بين submitProduct وprepareBatchDraftForStore

**التاريخ:** 2026-09-02
**الملف المعدَّل:** `extension/content.js`

## النطاق (محدود ومقصود، حسب طلب المستخدم)

فحصت الدالتين كاملتين فعلياً قبل أي تعديل (تغيّرتا بجلسات سابقة). النطاق المُعتمَد
لهذي الجولة: توحيد **فقط** حساب `addedFee`/`priceAfterFee`/`priceSAR` المتفرّع حسب
النوع (`watches`/`shoes`) — الجزء المؤكد إنه مكرر حرفياً بين الدالتين، ونفسه سبب أخطاء
الرسوم التاريخية الموثّقة. باقي منطق الدالتين (بناء payload، معالجة 409، استدعاء
المتجر) بقي منفصلاً كما هو - لا دمج للدالتين كاملتين.

## التعديل

دالة جديدة مشتركة `computeFeeAndPrice(originalPrice, productType, config)` (قبل
`submitProduct` مباشرة) ترجع `{ addedFee, priceAfterFee, priceSAR }`. كلا الدالتين
تستدعيانها الآن بدل نسختيهما المحليتين المنفصلتين:

- `submitProduct`: `const { priceAfterFee: finalFeePrice, priceSAR: finalSar } =
  computeFeeAndPrice(originalPrice, productType, extractorConfig);` (أسماء المتغيرات
  الأصلية `finalFeePrice`/`finalSar` محفوظة عبر destructuring rename، بدون تغيير أي
  كود لاحق يعتمد عليها).
- `prepareBatchDraftForStore`: `const { priceAfterFee, priceSAR } =
  computeFeeAndPrice(draft.originalPrice, draft.productType, extractorConfig);` (نفس
  الأسماء المستخدَمة أصلاً، بدون أي rename).

## السبب

نفس منطق الحساب (تفرّع `WatchFlatFeeYuan`/`AddedFeeYuan` حسب النوع، ثم ضرب
`ExchangeRate`) كان مكتوباً حرفياً مرتين منفصلتين. هذا التكرار بالذات هو السبب الجذري
وراء كل أخطاء الرسوم التاريخية الموثّقة (إصلاح مسار واحد، نسيان الثاني، تكرار نفس
الخطأ لاحقاً بمكان مختلف).

## 🟡 نقطة تكرار ثالثة اكتُشفت — لم تُلمس (حسب طلب المستخدم، للقرار لاحقاً)

`renderNewProductForm` (سطر ~1580-1585) عندها **نفس النمط بالضبط** (تفرّع
`WatchFlatFeeYuan`/`AddedFeeYuan` ثم `priceAfterFee`/`priceSAR`) لمعاينة السعر
بالمودال الفردي - هذا مسار المعاينة اللي أُصلح بجلسة سابقة (تفرّع الرسم حسب النوع)
لكنه **لم يُدمَج** بـ`computeFeeAndPrice()` هذي الجولة لأنه خارج النطاق المُعتمَد
صراحة. لو تحب توحيده لاحقاً، هذي نقطة رابعة استخدام جاهزة لنفس الدالة المشتركة -
يحتاج فقط استبدال السطور المذكورة باستدعاء `computeFeeAndPrice(originalPrice,
detectedProductType, extractorConfig)`.

لم ألقَ أي تكرار حقيقي ثانٍ غير الرسوم (بناء بيانات الصور أو الأسماء بين الدالتين
منفصل فعلاً بمنطق مختلف بما يكفي، مو نسخ حرفي).

## التحقق الفعلي

- `node --check extension/content.js` نجح.
- **تحقق رقمي مباشر بـNode:** أعدت بناء نسختي المنطق القديمتين (submitProduct
  وprepareBatchDraftForStore) كما كانتا حرفياً قبل التوحيد، وقارنتهما بنتيجة
  `computeFeeAndPrice()` الجديدة على 5 حالات اختبار (أحذية، ساعات، سعر صفر، سعر
  كسري، نوع غير محدَّد `undefined`) — **تطابق تام 100% بكل الحالات** بين النتيجة
  القديمة (كلا المسارين) والجديدة الموحّدة، صفر فرق بأي رقم.
