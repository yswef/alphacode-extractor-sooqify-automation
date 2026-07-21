// =========================================================
// AlphaCode Extractor v4 - Shared Default Configuration
// Arabic: مصدر موحد للإعدادات مع دعم المورد والصور ومزودي الذكاء الاصطناعي.
// English: Central defaults for supplier navigation, images, and AI providers.
// =========================================================

(() => {
    'use strict';

    const defaults = {
        // Arabic: هوية المتجر المستهدف.
        // English: Target-store identity.
        StoreProfileName: 'Sooqify Online',
        StoreDomain: 'admin.sooqifyonline.com',
        SooqifyAddUrl: 'https://admin.sooqifyonline.com/admin/item/add-new',

        // Arabic: إعدادات المورد؛ يترك الرابط فارغاً ليُحفظ آخر رابط SZWEGO تلقائياً.
        // English: Supplier settings; the latest SZWEGO URL is remembered automatically.
        SupplierStoreName: 'BRANDKINGDOM',
        SupplierStoreId: '',
        SupplierHomeUrl: '',
        SupplierSearchSelector: '',
        SupplierAutoScrollRounds: 80,
        OpenSupplierAtLastProduct: true,

        // Arabic: إعدادات التصنيف والسعر والمخزون.
        // English: Category, pricing, and stock settings.
        CategoryId: 41,
        SubCategoryId: 42,
        UnitId: 1,
        Stock: 100,
        ExchangeRate: 0.5,
        AddedFeeYuan: 250,
        Discount: 0,
        DiscountType: 'percent',
        AvailableTimeStarts: '00:00',
        AvailableTimeEnds: '23:59',
        MaximumCartQuantity: '',
        StoreId: 3,
        ModuleId: 2,
        Status: 'active',
        Veg: 'no',
        Recommended: 'yes',

        // Arabic: البراند والمقاسات.
        // English: Brand and size variants.
        BrandName: 'Air Jordan',
        BrandId: 6,
        BrandMapJson: '{"Air Jordan":6}',
        SizeAttributeId: 1,
        SizeChoiceNo: 1,
        SizeactualChoiceNo: 1,
        SizeTitle: 'الحجم',
        DefaultLanguage: 'en',

        // Arabic: الصور؛ الخيار الجديد يسمح بتنزيل الصور المحددة فقط محلياً.
        // English: Images; the new option can download only selected images locally.
        ImageMaxDimension: 1200,
        ImageQuality: 75,
        ImageFormat: 'jpeg',
        OptimizeImageAtSource: true,
        RequireAllImages: true,
        MaxImages: 30,
        StoreImageLimit: 6,
        DownloadSelectedImagesOnly: false,

        // Arabic: إعدادات الذكاء الاصطناعي القابلة للتبديل.
        // English: Switchable AI-provider settings.
        AIAutoGenerate: true,
        AIProvider: 'groq',
        AIModel: 'openai/gpt-oss-120b',
        AIBaseUrl: '',
        AIKeyEnv: 'GROQ_API_KEY',
        AIJsonRepairEnabled: true,
        ArabicCopyStyle: 'sales-natural',
        OfficialResearchOnRegenerate: true,

        // Arabic: التشغيل الآلي للمتجر.
        // English: Store automation.
        AutoAddProduct: false,
        AutoSubmitDelaySeconds: 0,
        FastAutofillMode: true,

        // Arabic: طابور الدفعات يجهز منتجاً واحداً في كل مرة افتراضياً لتفادي حدود Groq، ويرسل منتجاً واحداً فقط إلى المتجر.
        // English: Batch preparation defaults to one AI task to avoid Groq limits, while store submission remains strictly sequential.
        BatchModeEnabled: true,
        BatchPreparationConcurrency: 1,
        BatchMaximumProducts: 25,
        BatchContinueOnFailure: true,
        BatchNotifyEachProduct: true,
        BatchMaxRetries: 1,
        BatchDownloadSelectedImagesOnly: true,
        BatchReuseStoreTab: true,
        BatchSelectionPersistence: true,
        AdminPanelPosition: 'middle-left',
    };

    globalThis.ALPHACODE_DEFAULT_CONFIG = Object.freeze(defaults);
})();
