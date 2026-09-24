// =========================================================
// AlphaCode Extractor - Product Type Profiles (Single Source of Truth)
// Arabic: مصدر الحقيقة الوحيد لكل الفروقات بين "أحذية" و"ساعات". أي فرق بين النوعين
//         (الرسم، الفئة، الفئة الفرعية، محور الخيارات، النصوص المعروضة) يُعرَّف هنا مرة
//         واحدة فقط. قبل هذا الملف كان نفس شرط if (type === 'watches') مكرراً بأكثر من
//         عشر مواضع (content.js، background.js، admin_autofill.js، والباك اند)، وكل
//         إصلاح كان ينسى نسخة أو اثنتين - وهذا هو السبب الجذري لأخطاء الرسوم المتكررة.
// English: The single source of truth for every shoes/watches difference. Each difference
//          (fee, category, subcategory, variant axis, displayed labels) is declared here
//          exactly once. Before this file, the same `if (type === 'watches')` condition was
//          duplicated in a dozen places (content.js, background.js, admin_autofill.js, and
//          the backend), and every fix forgot one or two copies - the root cause of the
//          recurring fee bugs.
//
// Arabic: النظير المطابق بالباك اند هو backend/app/services/product_type_profiles.py -
//         أي تعديل هنا يجب أن يُطبَّق هناك أيضاً (الاختبارات تتحقق من التطابق).
// English: The mirrored backend counterpart is backend/app/services/product_type_profiles.py -
//          any change here must be applied there too (tests assert they stay in sync).
// =========================================================

(() => {
    'use strict';

    // Arabic: تعريف النوعين. مفاتيح الإعدادات تُذكر بالاسم فقط، وتُقرأ وقت الاستدعاء من
    //         كائن الإعدادات الحي (extractorConfig / settings) حتى تبقى قيم المستخدم فعّالة.
    // English: The two profiles. Setting keys are referenced by name only and read at call
    //          time from the live settings object, so operator-edited values stay effective.
    const PROFILES = {
        shoes: {
            id: 'shoes',
            // Arabic: النصوص المعروضة. ملاحظة مهمة: "ساعات" وحدها كلمة ملتبسة بالعربية
            //         (تعني watches وتعني hours)، وترجمة المتصفح التلقائية كانت تعرضها
            //         "Hours" بواجهة المراجعة. لذلك كل تسمية معروضة تحمل النص الإنجليزي
            //         بين قوسين لإزالة اللبس نهائياً.
            // English: Display labels. Important: the bare Arabic word "ساعات" is ambiguous
            //          (it means both "watches" and "hours"), and browser auto-translation
            //          rendered it as "Hours" in the review modal. Every displayed label
            //          therefore carries the English term in parentheses to remove the
            //          ambiguity for good.
            labelAr: 'أحذية',
            labelEn: 'Shoes',
            icon: '👟',
            // Arabic: مفتاح الرسم الثابت باليوان المضاف لكل منتج من هذا النوع.
            // English: The flat CNY fee setting key added to every product of this type.
            feeSettingKey: 'AddedFeeYuan',
            feeFallback: 250,
            // Arabic: الفئة والفئة الفرعية. الأحذية لها فئة فرعية، الساعات لا.
            // English: Category and subcategory. Shoes have a subcategory, watches do not.
            categorySettingKey: 'CategoryId',
            categoryFallback: 41,
            usesSubCategory: true,
            subCategorySettingKey: 'SubCategoryId',
            subCategoryFallback: 42,
            // Arabic: محور الخيارات: الأحذية تتفرّع بالمقاسات، الساعات بالألوان.
            // English: Variant axis: shoes branch by size, watches by colour.
            variantAxis: 'sizes',
            variantAttributeIdKey: 'SizeAttributeId',
            variantAttributeIdFallback: 1,
            variantTitleKey: 'SizeTitle',
            variantTitleFallback: 'الحجم',
            // Arabic: هل يُرسَل المنتج للمتجر بخاصية خيارات (مقاس/لون) أصلاً.
            // English: Whether the product is pushed to the store with a variant attribute at all.
            usesVariantAttribute: true,
            // Arabic: هل يعرض حقل الألوان/الأسعار بشاشة مراجعة الدفعة.
            // English: Whether the colour/price editor is shown in the batch review slide.
            hasColorVariantEditor: false,
        },
        watches: {
            id: 'watches',
            labelAr: 'ساعات',
            labelEn: 'Watches',
            icon: '⌚',
            feeSettingKey: 'WatchFlatFeeYuan',
            feeFallback: 600,
            categorySettingKey: 'WatchCategoryId',
            categoryFallback: 46,
            usesSubCategory: false,
            subCategorySettingKey: null,
            subCategoryFallback: null,
            variantAxis: 'colors',
            variantAttributeIdKey: 'WatchColorAttributeId',
            variantAttributeIdFallback: 2,
            variantTitleKey: 'WatchColorTitle',
            variantTitleFallback: 'اللون',
            // Arabic: بطلب المستخدم — الساعات حالياً تُضاف للمتجر بدون أي خاصية خيارات.
            //         لوحة Sooqify ما فيها خاصية "اللون" رقم 2، فكان اختيارها يفشل الإضافة
            //         برسالة "لم يتم العثور على الخاصية رقم 2". لإعادة تفعيلها لاحقاً بعد
            //         إنشاء الخاصية بالمتجر: غيّر هذي القيمة إلى true فقط.
            // English: Per the operator's request - watches are currently pushed to the store
            //          with no variant attribute at all. The Sooqify panel has no attribute #2
            //          ("colour"), so selecting it failed submission with "attribute #2 not
            //          found". To re-enable later, once that attribute exists in the store:
            //          flip this single value back to true.
            usesVariantAttribute: false,
            hasColorVariantEditor: true,
        },
    };

    const DEFAULT_PRODUCT_TYPE = 'shoes';

    // Arabic: يُرجع معرّف نوع صالح دائماً؛ أي قيمة مجهولة أو فارغة تعود إلى "shoes"
    //         (نفس السلوك الاحتياطي الذي كان مكرراً كـ`productType || 'shoes'` بكل مكان).
    // English: Always returns a valid type id; any unknown or empty value falls back to
    //          "shoes" (the same fallback previously duplicated as `productType || 'shoes'`).
    function resolveProductType(value) {
        const key = String(value == null ? '' : value).trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(PROFILES, key)
            ? key
            : DEFAULT_PRODUCT_TYPE;
    }

    function getProfile(value) {
        return PROFILES[resolveProductType(value)];
    }

    // Arabic: قراءة رقم من الإعدادات مع احتياطي آمن (نفس نمط Number(x || y) السابق).
    // English: Read a number from settings with a safe fallback (same as the old Number(x || y)).
    function readNumber(config, key, fallback) {
        if (!key) return fallback;
        const raw = (config || {})[key];
        const value = Number(raw);
        return Number.isFinite(value) ? value : Number(fallback) || 0;
    }

    // Arabic: الرسم الثابت باليوان لهذا النوع. هذا هو المصدر الوحيد للرسم بكل الإكستنشن.
    // English: The flat CNY fee for this type. The only fee source in the whole extension.
    function productTypeFee(productType, config) {
        const profile = getProfile(productType);
        return readNumber(config, profile.feeSettingKey, profile.feeFallback);
    }

    // Arabic: الفئة الفعلية المرسلة للمتجر (الساعات تستخدم WatchCategoryId).
    // English: The effective store category (watches use WatchCategoryId).
    function productTypeCategoryId(productType, config) {
        const profile = getProfile(productType);
        return readNumber(config, profile.categorySettingKey, profile.categoryFallback);
    }

    // Arabic: الفئة الفرعية الفعلية. للساعات تُرجع null عمداً - "لا فئة فرعية" قرار حقيقي
    //         وليس قيمة مفقودة، ولذلك لا يجوز لأي مستدعٍ أن يستبدلها باحتياطي الأحذية (42)
    //         عبر `|| 42`. هذا بالضبط ما كان يحصل بـbackground.js وadmin_autofill.js:
    //         الباك اند يرسل null للساعات، والواجهة تعيد حقنه 42 (فئة فرعية للأحذية).
    // English: The effective subcategory. For watches this deliberately returns null -
    //          "no subcategory" is a real decision, not a missing value, so no caller may
    //          replace it with the shoes fallback (42) through `|| 42`. That is exactly what
    //          background.js and admin_autofill.js were doing: the backend sent null for
    //          watches and the front end re-injected 42 (the shoes subcategory).
    function productTypeSubCategoryId(productType, config) {
        const profile = getProfile(productType);
        if (!profile.usesSubCategory) return null;
        return readNumber(config, profile.subCategorySettingKey, profile.subCategoryFallback);
    }

    function productTypeVariantAttributeId(productType, config) {
        const profile = getProfile(productType);
        return readNumber(config, profile.variantAttributeIdKey, profile.variantAttributeIdFallback);
    }

    function productTypeVariantTitle(productType, config) {
        const profile = getProfile(productType);
        const raw = (config || {})[profile.variantTitleKey];
        const value = String(raw == null ? '' : raw).trim();
        return value || profile.variantTitleFallback;
    }

    // Arabic: التسمية المعروضة غير الملتبسة: "ساعات (Watches)" لا "ساعات" وحدها.
    // English: The unambiguous display label: "ساعات (Watches)", never bare "ساعات".
    function productTypeLabel(productType, { withIcon = false } = {}) {
        const profile = getProfile(productType);
        const text = `${profile.labelAr} (${profile.labelEn})`;
        return withIcon ? `${profile.icon} ${text}` : text;
    }

    // Arabic: حساب الرسم والسعر النهائي - الصيغة الوحيدة المعتمدة للنوعين:
    //         (السعر الأساسي باليوان + رسم النوع) × سعر الصرف، مقرَّباً.
    // English: The fee/price computation - the single approved formula for both types:
    //          (base CNY price + the type's fee) x exchange rate, rounded.
    function computeProductTypePrice(originalPrice, productType, config) {
        const addedFee = productTypeFee(productType, config);
        const basePrice = Number(originalPrice) || 0;
        const exchangeRate = Number((config || {}).ExchangeRate) || 0;
        const priceAfterFee = basePrice + addedFee;
        return {
            addedFee,
            priceAfterFee,
            priceSAR: Math.round(priceAfterFee * exchangeRate),
        };
    }

    function listProductTypes() {
        return Object.keys(PROFILES);
    }

    // =====================================================================
    // Arabic: ربط البراند بنوع المنتج.
    //   قائمة البراندات القادمة من الخادم تحمل {id, name} فقط بلا نوع، فنستنتج النوع من
    //   اسم البراند. الفائدة العملية: لو اختار المستخدم "Rolex" كبراند افتراضي، يصير نوع
    //   المنتج "ساعات" تلقائياً بلا اختيار يدوي كل مرة.
    //
    //   لإضافة براند ساعات جديد لاحقاً: أضف اسمه بحروف صغيرة إلى WATCH_BRAND_KEYWORDS
    //   بسطر واحد. المطابقة تتم على الاسم كاملاً أو كلمة كاملة داخله، لا كجزء من كلمة،
    //   حتى لا يطابق براند اسمه يحتوي الكلمة صدفةً.
    // English: Brand-to-product-type mapping.
    //   The server's brand list carries only {id, name} with no type, so the type is inferred
    //   from the brand name. The practical benefit: picking "Rolex" as the default brand makes
    //   the product type "watches" automatically, instead of selecting it by hand every time.
    //
    //   To add a new watch brand later: append its lowercase name to WATCH_BRAND_KEYWORDS as a
    //   single line. Matching is on the whole name or a whole word inside it, never a substring,
    //   so a brand that merely contains the word by coincidence will not match.
    // =====================================================================
    const WATCH_BRAND_KEYWORDS = [
        'rolex', 'omega', 'cartier', 'patek philippe', 'audemars piguet', 'hublot',
        'tag heuer', 'breitling', 'tissot', 'longines', 'seiko', 'citizen', 'casio',
        'g-shock', 'fossil', 'daniel wellington', 'michael kors', 'richard mille',
        'vacheron constantin', 'jaeger-lecoultre', 'iwc', 'panerai', 'tudor', 'zenith',
        'chopard', 'bvlgari', 'montblanc', 'rado', 'oris', 'frederique constant',
    ];

    // Arabic: هل اسم البراند هذا براند ساعات؟ المطابقة على الاسم كاملاً أو كلمة كاملة.
    // English: Is this brand name a watch brand? Matches the whole name or a whole word.
    function isWatchBrand(brandName) {
        const name = String(brandName || '').trim().toLowerCase();
        if (!name) return false;
        // Arabic: نقارن على "كلمات" الاسم بدل regex - أبسط وأأمن ولا يحتاج هروب رموز.
        //         نُطبّع كل ما ليس حرفاً أو رقماً إلى مسافة، ثم نبحث عن الكلمة كاملة.
        // English: Compare on the name's "words" instead of a regex - simpler, safer and needs
        //          no escaping. Normalise every non-alphanumeric to a space, then look for the
        //          whole keyword as a standalone run of words.
        const normalised = ` ${name.replace(/[^a-z0-9]+/g, ' ').trim()} `;
        return WATCH_BRAND_KEYWORDS.some(keyword => {
            const key = ` ${keyword.replace(/[^a-z0-9]+/g, ' ').trim()} `;
            return normalised.includes(key);
        });
    }

    // Arabic: نوع المنتج المستنتج من البراند، أو '' لو البراند غير معروف/فاضٍ.
    //         يُرجع '' لا 'shoes' عمداً، حتى يفرّق المستدعي بين "براند أحذية مؤكَّد"
    //         و"لا نعرف" فيكمل بكشف النص.
    // English: The product type inferred from the brand, or '' when the brand is unknown/empty.
    //          Returns '' rather than 'shoes' deliberately, so the caller can tell "confirmed a
    //          shoe brand" apart from "no idea" and fall through to text detection.
    function productTypeForBrand(brandName) {
        const name = String(brandName || '').trim();
        if (!name) return '';
        return isWatchBrand(name) ? 'watches' : '';
    }

    globalThis.ALPHACODE_PRODUCT_TYPES = Object.freeze({
        WATCH_BRAND_KEYWORDS,
        isWatchBrand,
        productTypeForBrand,
        PROFILES: Object.freeze(PROFILES),
        DEFAULT_PRODUCT_TYPE,
        resolveProductType,
        getProfile,
        productTypeFee,
        productTypeCategoryId,
        productTypeSubCategoryId,
        productTypeVariantAttributeId,
        productTypeVariantTitle,
        productTypeLabel,
        computeProductTypePrice,
        listProductTypes,
    });
})();
