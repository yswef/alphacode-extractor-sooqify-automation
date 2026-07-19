// =========================================================
// AlphaCode Extractor - Shared Default Configuration
// Arabic: مصدر موحد للقيم الافتراضية لتسهيل نقل الأداة إلى متجر آخر.
// English: Central defaults make future store migrations easier.
// =========================================================

(() => {
    const defaults = {
        // Arabic: هوية ملف المتجر النشط.
        // English: Active store-profile identity.
        StoreProfileName: 'Sooqify Online',
        StoreDomain: 'admin.sooqifyonline.com',

        CategoryId: 41,
        SubCategoryId: 42,
        UnitId: 1,
        Stock: 100,
        ExchangeRate: 0.5,
        AddedFeeYuan: 250,

        Discount: 0,
        DiscountType: 'percent',
        AvailableTimeStarts: '00:00:00',
        AvailableTimeEnds: '23:59:59',
        MaximumCartQuantity: '',
        StoreId: 3,
        ModuleId: 2,
        Status: 'active',
        Veg: 'no',
        Recommended: 'yes',

        BrandName: 'Air Jordan',
        BrandId: 6,
        BrandMapJson: '{"Air Jordan":6}',
        SizeAttributeId: 1,
        SizeChoiceNo: 1,
        SizeTitle: 'الحجم',
        DefaultLanguage: 'en',
        SooqifyAddUrl: 'https://admin.sooqifyonline.com/admin/item/add-new',

        // Arabic: اسم أول متجر مورد حسب طلب المستخدم.
        // English: First supplier-store name requested by the user.
        SupplierStoreName: 'BRANDKINGDOM',
        SupplierStoreId: '',

        ImageMaxDimension: 1200,
        ImageQuality: 75,
        ImageFormat: 'jpeg',
        OptimizeImageAtSource: true,
        RequireAllImages: true,
        MaxImages: 30,
        StoreImageLimit: 5,

        AIAutoGenerate: true,
        AIModel: 'openai/gpt-oss-20b',

        // Arabic: التشغيل الآلي اختياري ويظل معطلاً حتى يفعله المستخدم.
        // English: Full automation is optional and stays disabled until explicitly enabled.
        AutoAddProduct: false,
        AutoSubmitDelaySeconds: 3,

        // Arabic: موضع اللوحة العائمة، ويمكن سحبها يدوياً أيضاً.
        // English: Floating-panel placement; the panel is also draggable.
        AdminPanelPosition: 'middle-left'
    };

    globalThis.ALPHACODE_DEFAULT_CONFIG = Object.freeze(defaults);
})();
