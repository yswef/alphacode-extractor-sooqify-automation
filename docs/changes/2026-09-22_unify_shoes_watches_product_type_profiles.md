# دمج منطق الأحذية/الساعات في مصدر حقيقة واحد (Product Type Profiles)

**التاريخ:** 2026-09-22
**الفرع:** `dev` (لم يُدمج في `master`)
**النطاق:** الإكستنشن + الباك اند معاً

---

## 1. نقطة البداية: البلاغ الحقيقي وتشخيصه

### البلاغ كما ورد
> بمودال مراجعة منتج، النوع "Shoes"، ظهر: `Additional fixed fee: 0`، `Price in Yuan: 350`،
> `Total: 175 SAR`. وكمان تسمية نوع المنتج تطلع "Hours" بدل "Watches".

### التحقق قبل أي تعديل

**أولاً — أي مودال هو فعلاً؟**
البلاغ ذكر `renderNewProductForm`، لكن الفحص أثبت أن هذا **ليس** المودال المقصود:
`renderNewProductForm` لا يحتوي أي **اختيار** لنوع المنتج — النوع فيها للقراءة فقط
(`detectedProductType` مكتشف تلقائياً ويُعرض كنص). المودال الذي فيه **أزرار اختيار النوع**
وحقل باسم "رسوم ثابتة إضافية (يوان)" هو `renderBatchReviewSlides` (مودال مراجعة الدفعة).
الأرقام المبلَّغ عنها تطابقه حرفياً.

**ثانياً — هل `AddedFeeYuan` = 0 قيمة مستخدم أم باغ؟**
القيمة الافتراضية في `extension/config.js:44` هي **250**، وليست 0. الصفر لم يأتِ من إعدادات
المستخدم إطلاقاً — كان **مكتوباً حرفياً في القالب**:

```js
// extension/content.js (قبل التعديل)
<input class="batch-fee-yuan" ... value="${draft.productType === 'watches'
    ? Number(extractorConfig.WatchFlatFeeYuan || 0)
    : 0}">   // ← صفر حرفي للأحذية، ويتجاهل AddedFeeYuan كلياً
```

**إذن: باغ حقيقي، وليس سلوكاً متوقعاً بإعدادات المستخدم.**

**ثالثاً — من أين جاء `175 SAR`؟**
`updateSarPreview` كانت تحمل **صيغة ثالثة مستقلة** للأحذية:

```js
sar = Math.round(yuan * rate * (1 + feePercent / 100));   // للأحذية
```

و`FeePercent` **غير موجود أصلاً** في `config.js` ولا في `extract_settings` بالباك اند، فيؤول
دايماً إلى `0`. النتيجة: `350 × 0.5 × 1 = 175`. بينما مسار الإرسال الفعلي
(`prepareBatchDraftForStore` → `computeFeeAndPrice`) كان يحسب `(350 + 250) × 0.5 = 300`.

> **الخلاصة:** المعاينة كانت تعرض للمستخدم **125 ريالاً أقل** من السعر المُرسَل فعلياً للمتجر،
> في كل حذاء يمر عبر مودال الدفعة.

**رابعاً — مصدر كلمة "Hours":**
لا توجد كلمة `Hours` في أي ملف بالمشروع (بحث حرفي وغير حساس لحالة الأحرف عبر كل الملفات).
الواجهة عربية بالكامل، وزر النوع كان مكتوباً `⌚ ساعات` فقط. وكلمة **"ساعات" بالعربية ملتبسة**:
تعني *watches* وتعني *hours*. الترجمة التلقائية للمتصفح تختار "Hours". نفس اللبس كان في
`popup.html` (`<option value="watches">ساعات</option>`) وفي عناوين بطاقات الإعدادات.

---

## 2. الجرد الشامل لنقاط التفرّع حسب نوع المنتج

فُحصت كل الملفات المطلوبة بعمق، ومنها `admin_autofill.js` و`background.js` اللذان لم يُفحصا
منطقياً بعمق من قبل.

### `extension/content.js`

| # | الموقع | ما كان يختلف | الحالة قبل الدمج |
|---|--------|---------------|------------------|
| 1 | `detectProductType` | كشف النوع من نص الصفحة | موحّدة أصلاً ✅ |
| 2 | `computeFeeAndPrice` | الرسم حسب النوع | **المصدر المعتمد** ✅ |
| 3 | `renderNewProductForm` (~1640) | نسخة مكررة حرفياً من #2 | مكرر (رياضياً صحيح) ⚠️ |
| 4 | `renderNewProductForm` (~1706) | تسمية النوع | `'ساعة (Watches)'` مكتوبة يدوياً |
| 5 | `renderNewProductForm` (~1708) | `CategoryId / SubCategoryId` | **يعرض فئة الأحذية دايماً حتى للساعة** 🐛 |
| 6 | `renderBatchReviewSlides` (~3349) | تسميات الأزرار | `⌚ ساعات` — ملتبسة 🐛 |
| 7 | `renderBatchReviewSlides` (~3359) | قيمة حقل الرسم | **صفر حرفي للأحذية** 🐛 |
| 8 | `updateSarPreview` (~3059) | صيغة السعر | **صيغة ثالثة بـ`FeePercent` غير الموجود** 🐛 |
| 9 | زر تبديل النوع (~3079) | لا يحدّث الرسم عند التبديل | **رسم النوع السابق يبقى** 🐛 |
| 10 | جمع المسودة (~3490) | `draft.feeYuan` | **يُكتب ولا يُقرأ إطلاقاً (كود ميت)** 🐛 |
| 11 | `prepareBatchDraftForStore` (~3618) | الرسم حسب النوع | يستخدم #2 ✅ |
| 12 | `submitProduct` (~2375) | الرسم حسب النوع | يستخدم #2 ✅ |
| 13 | مواضع متفرقة | `productType \|\| 'shoes'` | 5 نسخ مكررة من نفس الاحتياطي |

### `extension/background.js`

| # | الموقع | ما كان يختلف | الحالة |
|---|--------|---------------|--------|
| 14 | `buildSooqifyFormData` (~350) | `settings.CategoryId \|\| 41` | لا يوجد **أي** تفرّع حسب النوع |
| 15 | `buildSooqifyFormData` (~356) | `settings.SubCategoryId \|\| 42` | **الباك اند يرسل `null` للساعات عمداً، والـ`\|\| 42` يعيد حقن فئة الأحذية الفرعية بكل ساعة** 🐛 |
| 16 | `buildSooqifyFormData` (~285) | `SizeAttributeId` / `SizeTitle` | **مثبّت على "الحجم" حتى للساعات، مع أن قائمة "المقاسات" للساعة هي أسماء ألوان** 🐛 |

### `extension/admin_autofill.js`

| # | الموقع | ما كان يختلف | الحالة |
|---|--------|---------------|--------|
| 17 | `fillCoreFields` (~1794) | `SubCategoryId` | نفس باغ #15 حرفياً 🐛 |
| 18 | دالة تعبئة المقاسات (~1467) | `SizeAttributeId` / `SizeTitle` | نفس باغ #16 حرفياً 🐛 |

### `extension/popup.html` / `popup.js`

| # | الموقع | الحالة |
|---|--------|--------|
| 19 | `<option value="watches">ساعات</option>` | تسمية ملتبسة 🐛 |
| 20 | عناوين بطاقات الإعدادات | تسميات ملتبسة 🐛 |
| 21 | `updateProductTypeCardVisibility` | سليمة (تعتمد `data-producttype-card`) ✅ |

### `backend/app/services/upload_service.py`

| # | الموقع | الحالة |
|---|--------|--------|
| 22 | `extract_settings` | مركز الإعدادات ✅ |
| 23 | `build_variant_fields` (~324) | تفرّع بنيوي صحيح، لكن `WatchColorAttributeId`/`SizeAttributeId` مقروءة يدوياً |
| 24 | `build_watch_variations_from_absolute_yuan` | نفس الملاحظة |

### `backend/app/api/routes/upload_routes.py`

| # | الموقع | الحالة |
|---|--------|--------|
| 25 | `/api/dry-run` (~341) | **نفس صيغة `FeePercent` الخاطئة → dry-run يخالف المسار الفعلي لكل حذاء** 🐛 |
| 26 | `/api/extract` (~613) | `effective_category_id` / `effective_subcategory_id` — شرط مكرر |
| 27 | `/api/extract` (~601، ~679) | شروط `== "watches"` مكررة |

### ملفات أخرى

| # | الموقع | الحالة |
|---|--------|--------|
| 28 | `ai_helpers.py` (4 مواضع) | فروقات **محتوى تحريري** للبرومبت — ليست إعدادات |
| 29 | `report_service.py` (~95) | صفوف الأنواع مكتوبة يدوياً |

---

## 3. التصميم الجديد: ملف تعريف نوع المنتج

### الفكرة

مصدر حقيقة **واحد** لكل فرق بين النوعين، بنسختين متطابقتين (واحدة لكل بيئة تشغيل):

- **`extension/product_types.js`** → `globalThis.ALPHACODE_PRODUCT_TYPES`
- **`backend/app/services/product_type_profiles.py`**

كل ملف تعريف يحمل — لكل نوع — **اسم مفتاح الإعداد** لا قيمته، فتبقى قيم المستخدم المحفوظة
فعّالة وتُقرأ وقت الاستدعاء:

| الحقل | shoes | watches |
|-------|-------|---------|
| `labelAr` / `labelEn` / `icon` | أحذية / Shoes / 👟 | ساعات / Watches / ⌚ |
| `feeSettingKey` | `AddedFeeYuan` (250) | `WatchFlatFeeYuan` (600) |
| `categorySettingKey` | `CategoryId` (41) | `WatchCategoryId` (46) |
| `usesSubCategory` | `true` → `SubCategoryId` (42) | `false` → **`null`** |
| `variantAxis` | `sizes` | `colors` |
| `variantAttributeIdKey` | `SizeAttributeId` (1) | `WatchColorAttributeId` (2) |
| `variantTitleKey` | `SizeTitle` (الحجم) | `WatchColorTitle` (اللون) |
| `hasColorVariantEditor` | `false` | `true` |

### الدوال المشتركة (بنفس الأسماء في النسختين)

`resolveProductType` · `getProfile` · `productTypeFee` · `productTypeCategoryId` ·
`productTypeSubCategoryId` · `productTypeVariantAttributeId` · `productTypeVariantTitle` ·
`productTypeLabel` · `computeProductTypePrice` · `listProductTypes`

### ثلاثة قرارات تصميمية مهمة

1. **`productTypeSubCategoryId` تُرجع `null` للساعات عمداً.**
   "لا فئة فرعية" **قرار حقيقي**، وليس قيمة مفقودة. هذا يمنع بنيوياً نمط `|| 42` الذي كان
   يعيد حقن فئة الأحذية الفرعية بكل ساعة — لأن المستدعي الآن يفحص `=== null` صراحةً.

2. **التسميات تحمل الإنجليزية دايماً:** `ساعات (Watches)` لا `ساعات`.
   هذا هو الإصلاح الجذري لمشكلة "Hours" — الترجمة التلقائية لم تعد تملك كلمة ملتبسة تترجمها.

3. **نصوص البرومبت في `ai_helpers.py` بقيت مكانها.** هي محتوى تحريري لا إعدادات؛ وُحِّد منها
   **فحص النوع فقط** (عبر `resolve_product_type`) حتى لا تختلف قاعدة التطبيع بين الملفات.

---

## 4. الملفات المتأثرة

### ملفات جديدة
- `extension/product_types.js`
- `backend/app/services/product_type_profiles.py`
- `backend/tests/test_product_type_profiles.py`
- `docs/changes/2026-09-22_unify_shoes_watches_product_type_profiles.md` (هذا الملف)

### ملفات معدَّلة
| الملف | التعديل |
|-------|---------|
| `extension/manifest.json` | تحميل `product_types.js` قبل `content.js` وقبل `admin_autofill.js` |
| `extension/popup.html` | `<script src="product_types.js">` + إزالة اللبس من 4 تسميات |
| `extension/background.js` | `importScripts(... 'product_types.js')` + الفئة/الفئة الفرعية/خاصية الخيارات من الملف التعريفي |
| `extension/admin_autofill.js` | نفس الثلاثة + تخطّي حقل الفئة الفرعية للساعات |
| `extension/content.js` | `computeFeeAndPrice` يقرأ من الملف التعريفي؛ حذف النسخة المكررة في `renderNewProductForm`؛ إصلاح حقل الرسم وصيغة المعاينة بالدفعة؛ تحديث الرسم عند تبديل النوع؛ تفعيل `draft.feeYuan`؛ تسميات غير ملتبسة |
| `backend/app/services/upload_service.py` | خاصية/عنوان الخيارات وتطبيع النوع من الملف التعريفي |
| `backend/app/api/routes/upload_routes.py` | إصلاح صيغة dry-run؛ الفئة/الفئة الفرعية الفعليتان من الملف التعريفي |
| `backend/app/services/ai_helpers.py` | تطبيع فحص النوع (4 مواضع) |
| `backend/app/services/report_service.py` | صفوف تقرير الأنواع تُولَّد من الملف التعريفي |

---

## 5. الأخطاء التي أُصلحت فعلياً

| # | الخطأ | قبل | بعد |
|---|-------|-----|-----|
| 1 | حقل الرسم بمودال الدفعة للأحذية | `0` حرفي | `AddedFeeYuan` = 250 |
| 2 | معاينة السعر بالدفعة للأحذية (350 يوان) | **175 ر.س** | **300 ر.س** (= المُرسَل فعلياً) |
| 3 | تسمية النوع | `ساعات` → تُترجَم "Hours" | `ساعات (Watches)` |
| 4 | الفئة الفرعية للساعات بالمتجر | `42` (فئة أحذية) | لا يُعبَّأ الحقل |
| 5 | خاصية الخيارات للساعات بالمتجر | `1 — الحجم` | `2 — اللون` |
| 6 | `/api/dry-run` لحذاء 350 يوان | 175 ر.س (≠ الفعلي) | 300 ر.س (= الفعلي) |
| 7 | تبديل النوع يدوياً بالدفعة | الرسم يبقى على النوع السابق | يتبدّل مع النوع |
| 8 | تعديل المستخدم اليدوي للرسم | يُلتقط ثم يُهمَل تماماً | يصل للمتجر فعلياً |
| 9 | `Category / SubCategory` بالمودال الفردي | فئة الأحذية حتى للساعة | حسب النوع المكتشف |

---

## 6. الاختبارات

### فحص الصياغة
- `node --check` على 6 ملفات `.js` معدَّلة → **نجحت كلها**
- تحقق `JSON.parse` لـ`manifest.json` → **سليم**
- `python -m compileall` على 5 ملفات `.py` → **نجحت**

### مجموعة اختبارات الباك اند
```
36 passed
```
(7 اختبارات موجودة مسبقاً + 29 اختباراً جديداً؛ لا اختبار قائم انكسر.)

### محاكاة رقمية: قبل الدمج مقابل بعده

نُفِّذت بتطبيق الصيغ **القديمة منسوخة حرفياً** ومقارنتها بالجديدة، على 8 أسعار × نوعين،
في جافاسكربت وبايثون معاً:

**المسارات التي كانت تعمل صح — تطابق تام (0 اختلاف):**

| المسار | النتيجة |
|--------|---------|
| `computeFeeAndPrice` (الإرسال الفردي + الدفعة) | **متطابق 16/16** |
| معاينة المودال الفردي `renderNewProductForm` | **متطابق 16/16** |
| سعر مسار `/api/extract` الفعلي (بايثون) | **متطابق 16/16** |
| فئة/فئة فرعية الأحذية | `41 / 42` → `41 / 42` |
| خاصية خيارات الأحذية | `1 — الحجم` → `1 — الحجم` |

**المسارات المعطوبة — تغيّرت عمداً:**

```
=== معاينة الدفعة مقابل السعر المُرسَل فعلياً ===
type     yuan   oldPreview  newPreview  actual   oldMatched  newMatched
shoes    100    50          175         175      false       true
shoes    350    175         300         300      false       true      ← البلاغ
shoes    1000   500         625         625      false       true
watches  100    350         350         350      true        true
watches  350    475         475         475      true        true
watches  1000   800         800         800      true        true
```

```
=== dry-run مقابل /api/extract (بايثون) ===
shoes    350    OLDdry=175  NEWdry=300  REAL=300   oldMatched=False  newMatched=True
watches  350    OLDdry=475  NEWdry=475  REAL=475   oldMatched=True   newMatched=True
```

```
=== الفئة الفرعية وخاصية الخيارات ===
watches  sub:  old=42 (فئة أحذية!)  new=null
watches  attr: old=1 — الحجم        new=2 — اللون
```

### حارس دائم ضد انفصال النسختين
`test_js_and_python_profiles_are_identical` يقرأ `extension/product_types.js` نصياً ويقارن
كل حقل بنظيره في بايثون. **تُحقِّق من أنه يعمل فعلاً:** غُيِّرت `feeFallback` من 250 إلى 999
في نسخة JS فقط → الاختبار **فشل** (`assert 999 == 250`)، ثم أُعيدت القيمة → **نجح**.
فأي تعديل مستقبلي على طرف دون الآخر يكسر البناء فوراً.

### تشغيل فعلي للباك اند
شُغِّل الباك اند من الصفر (`python -m app.main`، منفذ 5000) واستُدعي `/api/dry-run` حقيقةً:

```
shoes    yuan=350 fee=250 (AddedFeeYuan)      -> 300 SAR | cat=41 sub=42
watches  yuan=350 fee=600 (WatchFlatFeeYuan)  -> 475 SAR | cat=46 sub=None
```

### تحقق بصري في متصفح حقيقي
رُكّبت صفحة اختبار تُحمِّل `product_types.js` الفعلي وتُصيّر **نفس قالب `renderBatchReviewSlides`
وبنفس دالة `updateSarPreview`**، وعُرضت في متصفح فعلي:

```
مودال مراجعة الدفعة — shoes (سعر أساسي 350 يوان)
  نوع المنتج:        👟 أحذية (Shoes)   ⌚ ساعات (Watches)
  رسوم ثابتة إضافية: 250
  الإجمالي:          300 ر.س
  Category/Sub:      41 / 42
  خاصية الخيارات:    1 — الحجم

مودال مراجعة الدفعة — watches (سعر أساسي 350 يوان)
  رسوم ثابتة إضافية: 600
  الإجمالي:          475 ر.س
  Category/Sub:      46 / بدون (None)
  خاصية الخيارات:    2 — اللون
```

لا توجد أي كلمة "ساعات" مجردة قابلة للترجمة إلى "Hours" في أي تسمية معروضة.

---

## 7. ملاحظات وحدود

- **لم يُدمج شيء في `master`.** كل العمل على `dev` بانتظار تجربة المستخدم وتأكيده.
- فرع `dev` كان **متأخراً** عن `master` بـ75+ كوميت (وصفر كوميت خاص به)، فتم `git merge master`
  وكان fast-forward نظيف. لم تكن هناك أي تعديلات غير محفوظة على `master` (شجرة العمل نظيفة).
- **`FeePercent` أُزيل من مسارَي الحساب** لأنه لم يكن معرَّفاً في أي مصدر إعدادات؛ لو أراد
  المستخدم لاحقاً رسماً نسبياً بدل الثابت، المكان الصحيح لإضافته هو ملف التعريف وحده.
- **حد معروف باقٍ (سابق للتعديل، خارج نطاقه):** في مودال الدفعة، محرِّر ألوان الساعة يُصيَّر
  فقط إذا بدأت المسودة كساعة. لو بدأت كحذاء ثم بدّلها المستخدم يدوياً لساعة، لا يظهر المحرِّر
  (لا يوجد عنصر لإظهاره). الأمر الآن مقاد بـ`hasColorVariantEditor` فأصبح إصلاحه لاحقاً نقطة
  واحدة، لكنه **لم يُصلَح في هذه الجولة** ولم يتغيّر سلوكه.
