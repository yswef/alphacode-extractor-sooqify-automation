// =========================================================
// AlphaCode Extractor v5.7.1 - Popup Controller
// Arabic: إدارة الإعدادات، المورد، طلب المنتجات، البيانات، والتشخيص.
// English: Manages settings, supplier workflows, product requests, data, and diagnostics.
// =========================================================

'use strict';

const API_BASE = `http://127.0.0.1:${(globalThis.ALPHACODE_DEFAULT_CONFIG || {}).BackendPort || 5000}`;
const DEFAULTS = globalThis.ALPHACODE_DEFAULT_CONFIG || {};

const NUMBER_FIELDS = new Set([
    'CategoryId',
    'SubCategoryId',
    'UnitId',
    'Stock',
    'ExchangeRate',
    'AddedFeeYuan',
    'Discount',
    'StoreId',
    'ModuleId',
    'BrandId',
    'SizeAttributeId',
    'SizeChoiceNo',
    'SizeactualChoiceNo',
    'ImageMaxDimension',
    'ImageQuality',
    'MaxImages',
    'StoreImageLimit',
    'AutoSubmitDelaySeconds',
    'SupplierAutoScrollRounds',
    'BatchPreparationConcurrency',
    'BatchMaximumProducts',
    'BatchMaxRetries',
    'WatchCategoryId',
    'WatchFlatFeeYuan',
    'WatchColorAttributeId',
]);

const BOOLEAN_FIELDS = new Set([
    'OptimizeImageAtSource',
    'RequireAllImages',
    'AutoAddProduct',
    'DownloadSelectedImagesOnly',
    'UploadMainImageOnly',
    'OpenSupplierAtLastProduct',
    'FastAutofillMode',
    'BatchModeEnabled',
    'BatchContinueOnFailure',
    'BatchNotifyEachProduct',
    'BatchDownloadSelectedImagesOnly',
    'BatchReuseStoreTab',
    'BatchSelectionPersistence',
]);

const CONFIG_FIELDS = Object.keys(DEFAULTS);
let currentConfig = { ...DEFAULTS };
let lastSearchProduct = null;

// Arabic: تفعيل تبويب واحد وإخفاء بقية التبويبات.
// English: Activate one tab and hide all other panels.
function activateTab(tabName) {
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.toggle('active', button.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });

    if (tabName === 'data') {
        refreshArchiveStats();
    }

    if (tabName === 'sync') {
        refreshFolderStatus();
        refreshSyncStatus();
        refreshRecentProducts();
    }

    if (tabName === 'sync') {
        refreshFolderStatus();
        loadSyncSettings();
        refreshSyncStatus();
        refreshRecentProducts();
    }

    if (tabName === 'reports' && byId('reportDate') && !byId('reportDate').value) {
        byId('reportDate').value = new Date().toISOString().slice(0, 10);
    }

    if (tabName === 'diagnostics') {
        refreshLogs();
    }
}

// Arabic: قراءة عنصر من الواجهة دون افتراض وجوده.
// English: Read a UI element without assuming it exists.
function byId(id) {
    return document.getElementById(id);
}

// Arabic: تعبئة عناصر النموذج من الإعدادات.
// English: Populate form controls from configuration.
// Arabic: يجعل BrandId المصدر الوحيد للحقيقة ويشتق منه BrandName دائماً، ثم يعرض نوع
//         المنتج المستنتج من البراند (ساعات/أحذية) حتى يرى المستخدم الأثر فوراً.
// English: Makes BrandId the single source of truth, always deriving BrandName from it, then
//          shows the product type inferred from the brand so the effect is visible at once.
function syncBrandNameFromSelect() {
const select = byId('BrandId');
if (!select) return;
const chosen = select.selectedOptions[0];
const name = (chosen && chosen.value) ? chosen.textContent.trim() : '';
if (byId('BrandName')) byId('BrandName').value = name;
currentConfig.BrandName = name;

const hint = byId('brandTypeHint');
if (!hint) return;
const types = globalThis.ALPHACODE_PRODUCT_TYPES;
if (!name || !types) { hint.textContent = ''; return; }
const inferred = types.productTypeForBrand(name) || 'shoes';
const profile = types.getProfile(inferred);
hint.textContent = `${profile.icon} نوع المنتج لهذا البراند: ${profile.labelAr} (${profile.labelEn}) — يُختار تلقائياً عند الاستخراج.`;
hint.dataset.type = inferred;
}

function populateForm(config) {
    for (const key of CONFIG_FIELDS) {
        const element = byId(key);
        if (!element) continue;

        if (BOOLEAN_FIELDS.has(key)) {
            element.checked = Boolean(config[key]);
        } else {
            element.value = config[key] ?? '';
        }
    }

    if (byId('profileChip')) {
        byId('profileChip').textContent = config.StoreProfileName || 'Sooqify Online';
    }

    if (byId('storeCardName')) {
        byId('storeCardName').textContent = config.StoreProfileName || 'Sooqify Online';
    }

    if (byId('supplierCardName')) {
        byId('supplierCardName').textContent = config.SupplierStoreName || 'BRANDKINGDOM';
    }

    // Arabic: BrandId هو مصدر الحقيقة، وBrandName يُشتق منه دائماً بعد تعبئة الفورم.
    //         بدون هذا السطر يبقى الباغ قائماً: populateForm تكتب BrandName المحفوظ (وقد
    //         يكون فاضياً أو لبراند آخر) فوق ما ضبطته loadBrandsIntoSelect، وتحديدها
    //         لـBrandId برمجياً لا يُطلق change فلا يُعاد الاشتقاق أبداً.
    // English: BrandId is the source of truth and BrandName is always derived from it after the
    //          form is populated. Without this line the bug stands: populateForm writes the
    //          saved BrandName (possibly empty, or for a different brand) over whatever
    //          loadBrandsIntoSelect set, and its programmatic BrandId assignment fires no
    //          change event, so the value is never re-derived.
    syncBrandNameFromSelect();

    updateProductTypeCardVisibility();
}

// Arabic: قراءة الحقول مع المحافظة على القيم غير المعروضة.
// English: Read rendered controls while preserving hidden configuration keys.
function readForm() {
    const config = { ...currentConfig };

    for (const key of CONFIG_FIELDS) {
        const element = byId(key);
        if (!element) continue;

        if (BOOLEAN_FIELDS.has(key)) {
            config[key] = element.checked;
        } else if (NUMBER_FIELDS.has(key)) {
            const parsed = Number(element.value);
            config[key] = Number.isFinite(parsed) ? parsed : DEFAULTS[key];
        } else {
            config[key] = String(element.value || '').trim();
        }
    }

    config.SizeChoiceNo = Number(
        config.SizeChoiceNo
        ?? config.SizeactualChoiceNo
        ?? 1,
    );
    config.SizeactualChoiceNo = config.SizeChoiceNo;

    return {
        ...DEFAULTS,
        ...config,
    };
}

// Arabic: عرض رسالة حالة مؤقتة.
// English: Display a temporary status notification.
function showStatus(message, type = 'success', durationMs = 5200) {
    const status = byId('status');
    if (!status) return;

    status.className = type;
    status.textContent = message;
    status.style.display = 'block';

    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => {
        status.style.display = 'none';
    }, durationMs);
}

// Arabic: ترحيل المفاتيح القديمة دون كسر إعدادات المستخدم الحالية.
// English: Migrate legacy keys without breaking existing user settings.
function migrateLegacyConfig(config) {
    const migrated = {
        ...DEFAULTS,
        ...config,
    };

    if (migrated.StoreProfileName === 'BRANDKINGDOM') {
        migrated.StoreProfileName = 'Sooqify Online';
    }

    if (!migrated.SupplierStoreName) {
        migrated.SupplierStoreName = 'BRANDKINGDOM';
    }

    // Arabic: تعديل بطلب المستخدم — تركيب صحيحة سابقاً كانت فارغة تُعبّأ الآن بالرابط الجديد.
    // English: Changed per operator request — previously-empty saved installs now get the new URL.
    if (!migrated.SupplierHomeUrl) {
        migrated.SupplierHomeUrl = 'https://brandkingdoms.com/';
    }

    migrated.SizeChoiceNo = Number(
        migrated.SizeChoiceNo
        ?? migrated.SizeactualChoiceNo
        ?? 1,
    );
    migrated.SizeactualChoiceNo = migrated.SizeChoiceNo;

    return migrated;
}

// Arabic: تحميل الإعدادات المحفوظة وتطبيق الترحيل.
// English: Load saved configuration and apply migration.
async function loadSavedConfig() {
    const stored = await chrome.storage.local.get([
        'extractorConfig',
        'lastSupplierPageUrl',
    ]);

    currentConfig = migrateLegacyConfig({
        ...DEFAULTS,
        ...(stored.extractorConfig || {}),
    });

    if (!currentConfig.SupplierHomeUrl && stored.lastSupplierPageUrl) {
        currentConfig.SupplierHomeUrl = stored.lastSupplierPageUrl;
    }

    populateForm(currentConfig);
    await chrome.storage.local.set({
        extractorConfig: currentConfig,
    });
}

// Arabic: إظهار/إخفاء بانر إعداد المجلد أعلى اللوحة.
// English: Show/hide the folder-setup banner at the top of the popup.
function setFolderBannerVisible(visible) {
    const banner = byId('folderSetupBanner');
    if (banner) banner.style.display = visible ? 'block' : 'none';
}

// Arabic: فحص جاهزية خادم Flask.
// English: Check Flask backend readiness.
async function checkServer() {
    const dot = byId('serverDot');
    const serverText = byId('serverText');

    try {
        const response = await fetch(`${API_BASE}/api/health`, {
            cache: 'no-store',
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Server error');
        }

        if (dot) dot.className = 'status-dot ok';
        if (serverText) serverText.textContent = `Python ${data.version || ''} متصل`;
        setFolderBannerVisible(Boolean(data.needs_folder_setup));
    } catch (_) {
        if (dot) dot.className = 'status-dot bad';
        if (serverText) serverText.textContent = 'خادم Python غير متصل';
        setFolderBannerVisible(false);
    }
}

// Arabic: حفظ الإعدادات وإرسالها إلى صفحات المورد والمتجر المفتوحة.
// English: Save settings and broadcast them to open supplier/store pages.
async function saveConfiguration() {
    currentConfig = migrateLegacyConfig(readForm());

    await chrome.storage.local.set({
        extractorConfig: currentConfig,
    });

    populateForm(currentConfig);

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id) continue;

        if (
            tab.url?.includes('szwego.com')
            || tab.url?.includes(currentConfig.StoreDomain)
        ) {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: 'UPDATE_CONFIG',
                    config: currentConfig,
                });
            } catch (_) { }
        }
    }

    showStatus('تم حفظ إعدادات AlphaCode v5.7.1 وتطبيقها.', 'success');
    await checkServer();
}

// Arabic: جلب منتج مؤرشف بالـ ID المحلي.
// English: Fetch an archived product by local ID.
async function fetchArchivedProduct(productId) {
    const response = await fetch(`${API_BASE}/api/archive/product/${productId}`, {
        cache: 'no-store',
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || 'لم يتم العثور على المنتج.');
    }

    return data.product;
}

// Arabic: قراءة آخر منتج محفوظ ومسار صفحة المورد.
// English: Read the latest archived product and supplier-page URL.
async function fetchLastArchivedProduct() {
    const response = await fetch(`${API_BASE}/api/archive/last`, {
        cache: 'no-store',
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || 'لا يوجد منتج محفوظ بعد.');
    }

    return data.product;
}

// Arabic: البحث عن منتج بواسطة ID المحلي وعرض ملخصه.
// English: Search an archived product by local ID and display its summary.
async function searchArchive() {
    const id = Number(byId('ArchiveProductId')?.value || 0);
    const resultBox = byId('searchResult');

    if (!id) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = 'أدخل ID صحيحاً.';
        }
        return null;
    }

    try {
        const product = await fetchArchivedProduct(id);
        lastSearchProduct = product;

        if (resultBox) {
            resultBox.className = 'result-box success';
            resultBox.textContent = [
                `المنتج: ${product.name_en || product.name || '-'}`,
                `البراند: ${product.brand_name || '-'}`,
                `المورد: ${product.supplier_store_name || '-'}`,
                `Search Code: ${product.search_code || '-'}`,
                `Style Code: ${product.style_code || '-'}`,
                `الحالة: ${product.workflow_status || 'prepared'}`,
                `الصور المحلية: ${(product.images || []).length}`,
                `المقاسات: ${(product.sizes || []).join(', ') || '-'}`,
            ].join('\n');
        }

        return product;
    } catch (error) {
        lastSearchProduct = null;
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = error.message;
        }
        return null;
    }
}

// Arabic: تجهيز منتج محفوظ وفتح صفحة إضافة Sooqify عند الطلب اليدوي.
// English: Prepare an archived product and open Sooqify for manual processing.
async function prepareArchivedProduct() {
    const id = Number(byId('ArchiveProductId')?.value || 0);
    if (!id) {
        showStatus('أدخل ID المنتج أولاً.', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/pending/${id}`, {
            cache: 'no-store',
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر تجهيز المنتج.');
        }

        await chrome.storage.local.set({
            pendingSooqifyProduct: data.pending_product,
            lastAlphaCodeProductId: id,
        });

        await chrome.tabs.create({
            url: currentConfig.SooqifyAddUrl,
        });

        showStatus(`تم تجهيز المنتج ${id} وفتح Sooqify.`, 'success');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

// Arabic: اختيار أحدث تبويب SZWEGO مفتوح.
// English: Select the most recently used open SZWEGO tab.
async function findSupplierTab() {
    const tabs = await chrome.tabs.query({
        url: ['*://*.szwego.com/*'],
    });

    return tabs
        .filter(tab => tab.id)
        .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0]
        || null;
}

// Arabic: انتظار اكتمال تحميل تبويب جديد.
// English: Wait until a newly opened tab finishes loading.
async function waitForTabComplete(tabId, timeoutMs = 20000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return tab;
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return chrome.tabs.get(tabId);
}

// Arabic: فتح المورد الموجود أو إنشاء تبويب جديد باستخدام آخر رابط محفوظ.
// English: Focus the supplier tab or open the latest saved supplier URL.
async function ensureSupplierTab(preferredUrl = '') {
    const existingTab = await findSupplierTab();

    if (existingTab?.id) {
        await chrome.tabs.update(existingTab.id, {
            active: true,
        });
        if (existingTab.windowId) {
            await chrome.windows.update(existingTab.windowId, {
                focused: true,
            });
        }
        return existingTab;
    }

    const stored = await chrome.storage.local.get([
        'lastSupplierPageUrl',
    ]);

    const lastProduct = preferredUrl
        ? null
        : await fetchLastArchivedProduct().catch(() => null);

    const supplierUrl = preferredUrl
        || stored.lastSupplierPageUrl
        || currentConfig.SupplierHomeUrl
        || lastProduct?.source_url
        || '';

    if (!supplierUrl) {
        throw new Error('افتح صفحة المورد مرة واحدة أو أضف رابط المورد في الإعدادات.');
    }

    const createdTab = await chrome.tabs.create({
        url: supplierUrl,
        active: true,
    });

    if (!createdTab.id) {
        throw new Error('تعذر فتح صفحة المورد.');
    }

    return waitForTabComplete(createdTab.id);
}

// Arabic: إرسال رسالة إلى content script مع إعادة محاولة قصيرة بعد فتح الصفحة.
// English: Message the supplier content script with a short readiness retry.
async function sendSupplierCommand(tabId, message) {
    let lastError = null;

    for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
            const result = await chrome.tabs.sendMessage(tabId, message);
            if (result) return result;
        } catch (error) {
            lastError = error;
        }

        await new Promise(resolve => setTimeout(resolve, 350));
    }

    throw lastError || new Error('صفحة المورد لم تصبح جاهزة لاستقبال الأمر.');
}

// Arabic: فتح رابط متجر المورد الثابت مباشرة (زر "فتح المورد" بالـfooter) - بدون أي
//         منطق ديناميكي أو محاولة تموضع لآخر منتج.
// English: Open the fixed supplier store link directly (footer "Open supplier" button) -
//          no dynamic lookup or last-product positioning.
async function openSupplierHomeDirectly() {
    try {
        await chrome.tabs.create({ url: 'https://brandkingdoms.com/', active: true });
        window.close();
    } catch (error) {
        showStatus(error.message, 'error', 7500);
    }
}

// Arabic: فتح المورد والنزول تلقائياً إلى آخر منتج أضيف.
// English: Open the supplier and automatically locate the last added product.
async function openSupplierAtLastProduct() {
    currentConfig = migrateLegacyConfig(readForm());

    try {
        const lastProduct = await fetchLastArchivedProduct();
        const tab = await ensureSupplierTab(lastProduct.source_url || '');

        const result = await sendSupplierCommand(tab.id, {
            action: 'SCROLL_TO_LAST_ADDED',
            searchCode: lastProduct.search_code || '',
            maximumRounds: Number(currentConfig.SupplierAutoScrollRounds || 80),
        });

        if (!result?.success) {
            throw new Error(result?.error || 'لم يتم العثور على آخر منتج في الصفحة.');
        }

        showStatus(`تم فتح المورد والوصول إلى Search Code ${lastProduct.search_code}.`, 'success');
        window.close();
    } catch (error) {
        showStatus(error.message, 'error', 7500);
    }
}

// Arabic: فتح المورد وكتابة Search Code للمنتج في خانة البحث تلقائياً.
// English: Open the supplier and automatically enter the product Search Code.
async function requestProductFromSupplier() {
    try {
        let product = lastSearchProduct;
        const requestedId = Number(byId('ArchiveProductId')?.value || 0);

        if (!product || Number(product.id) !== requestedId) {
            product = requestedId
                ? await fetchArchivedProduct(requestedId)
                : await fetchLastArchivedProduct();
        }

        const searchCode = String(product.search_code || '').trim();
        if (!searchCode) {
            throw new Error('المنتج المحدد لا يحتوي على Search Code صالح.');
        }

        const tab = await ensureSupplierTab(product.source_url || '');
        const result = await sendSupplierCommand(tab.id, {
            action: 'OPEN_SUPPLIER_SEARCH',
            searchCode,
            customSelector: currentConfig.SupplierSearchSelector || '',
        });

        if (!result?.success) {
            throw new Error(result?.error || 'تعذر إدخال كود البحث في صفحة المورد.');
        }

        showStatus(`تم إدخال Search Code ${searchCode} في بحث المورد.`, 'success');
        window.close();
    } catch (error) {
        showStatus(error.message, 'error', 7500);
    }
}

// Arabic: قراءة إحصاءات الأرشيف.
// English: Load archive statistics.
async function refreshArchiveStats() {
    try {
        const response = await fetch(`${API_BASE}/api/archive/stats`, {
            cache: 'no-store',
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر قراءة الإحصائيات.');
        }

        if (byId('statsProducts')) byId('statsProducts').textContent = data.products;
        if (byId('statsImages')) byId('statsImages').textContent = data.images;
        if (byId('statsLastId')) byId('statsLastId').textContent = data.last_id;
    } catch (error) {
        if (byId('statsProducts')) byId('statsProducts').textContent = '!';
        if (byId('statsImages')) byId('statsImages').textContent = '!';
        if (byId('statsLastId')) byId('statsLastId').textContent = '!';
        showStatus(error.message, 'error');
    }
}

// Arabic: حذف منتج واحد من JSON وExcel مع خيار مجلد الصور.
// English: Delete one product from JSON/Excel with optional image-folder removal.
async function deleteProductData() {
    const id = Number(byId('DeleteProductId')?.value || 0);
    const deleteImages = Boolean(byId('DeleteProductImages')?.checked);
    const resultBox = byId('deleteResult');

    if (!id) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = 'أدخل ID صحيحاً.';
        }
        return;
    }

    if (!confirm(`سيتم حذف المنتج ${id}${deleteImages ? ' مع مجلد الصور' : ''}. هل أنت متأكد؟`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/archive/product/${id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                delete_images: deleteImages,
            }),
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر حذف المنتج.');
        }

        const stored = await chrome.storage.local.get([
            'pendingSooqifyProduct',
        ]);

        if (stored.pendingSooqifyProduct?.local_id === id) {
            await chrome.storage.local.remove([
                'pendingSooqifyProduct',
                'lastAlphaCodeProductId',
                'lastAutoSubmitProductId',
            ]);
        }

        if (resultBox) {
            resultBox.className = 'result-box success';
            resultBox.textContent = `تم حذف المنتج ${id}.${data.images_deleted ? ' تم حذف مجلد الصور.' : ''}`;
        }

        await refreshArchiveStats();
    } catch (error) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = error.message;
        }
    }
}

// Arabic: مسح جميع المنتجات والملفات الاختيارية.
// English: Clear all products and optional local files.
async function clearAllData() {
    const deleteImages = Boolean(byId('ClearDeleteImages')?.checked);
    const resultBox = byId('clearResult');
    const confirmation = prompt('اكتب DELETE لتأكيد مسح جميع سجلات JSON وExcel:');

    if (confirmation !== 'DELETE') {
        if (resultBox) {
            resultBox.className = 'result-box warning';
            resultBox.textContent = 'تم إلغاء العملية.';
        }
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/archive/clear`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                delete_images: deleteImages,
            }),
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر مسح البيانات.');
        }

        await chrome.storage.local.remove([
            'pendingSooqifyProduct',
            'lastAlphaCodeProductId',
            'lastAutoSubmitProductId',
            'lastAutoFilledProductId',
            'lastAutoFillAt',
            'lastAutoSubmitAttemptAt',
        ]);

        if (resultBox) {
            resultBox.className = 'result-box success';
            resultBox.textContent = `تم حذف ${data.products_deleted} منتج و${data.folders_deleted} مجلد صور.`;
        }

        await refreshArchiveStats();
    } catch (error) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = error.message;
        }
    }
}


// Arabic: عرض آخر أسطر السجل الخارجي.
// English: Display recent external-log lines.
// Arabic: يحوّل نص HTML الخاص إلى كيانات آمنة قبل إدراجه بـinnerHTML - يمنع أي حقن HTML
//         من محتوى السجل.
// English: Escapes special HTML characters before inserting into innerHTML - prevents
//          any HTML injection from log content.
function escapeLogHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Arabic: يحدد كلاس CSS حسب مستوى السطر (ERROR/CRITICAL أحمر، WARNING أصفر، DEBUG رمادي).
// English: Picks a CSS class based on the line's level (ERROR/CRITICAL red, WARNING
//          yellow, DEBUG gray).
function logLevelClass(line) {
    const parts = line.split('|');
    const level = (parts[1] || '').trim().toUpperCase();
    if (level === 'ERROR' || level === 'CRITICAL') return 'log-line log-line-error';
    if (level === 'WARNING') return 'log-line log-line-warning';
    if (level === 'DEBUG') return 'log-line log-line-debug';
    return 'log-line log-line-info';
}

async function refreshLogs() {
    const logBox = byId('logBox');
    if (logBox) logBox.textContent = 'جاري تحميل السجل...';

    try {
        const response = await fetch(`${API_BASE}/api/logs/recent?lines=300`, {
            cache: 'no-store',
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر قراءة السجل.');
        }

        if (byId('logPath')) byId('logPath').textContent = data.log_path || '';
        if (logBox) {
            const lines = data.lines || [];
            if (!lines.length) {
                logBox.textContent = 'لا توجد أحداث مسجلة حتى الآن.';
            } else {
                logBox.innerHTML = lines
                    .map(line => `<div class="${logLevelClass(line)}">${escapeLogHtml(line)}</div>`)
                    .join('');
            }
            logBox.scrollTop = logBox.scrollHeight;
        }
    } catch (error) {
        if (logBox) logBox.textContent = `تعذر قراءة السجل: ${error.message}`;
    }
}

// Arabic: تنزيل ملف السجل الخارجي.
// English: Download the external log file.
async function downloadLogs() {
    await chrome.tabs.create({
        url: `${API_BASE}/api/logs/download`,
    });
}

// Arabic: مسح إحداثيات اللوحة المسحوبة.
// English: Clear saved floating-panel coordinates.
async function resetPanelPosition() {
    await chrome.storage.local.remove('adminPanelCoordinates');
    showStatus('تم مسح الموضع اليدوي. حدّث صفحة المتجر.', 'success');
}

// =========================================================
// Arabic: مجلد الحفظ - عرض الحالة واختيار مجلد جديد عند الحاجة.
// English: Save folder - status display and picking a new folder when needed.
// =========================================================

function renderFolderStatus(data) {
    const box = byId('folderStatusBox');
    const banner = byId('folderSetupBanner');

    if (data && data.configured) {
        if (box) {
            box.className = 'result-box success';
            box.textContent = `المجلد الحالي: ${data.root_dir}\nمجلد الصور: ${data.images_root}`;
        }
        if (banner) banner.style.display = 'none';
    } else {
        if (box) {
            box.className = 'result-box warning';
            box.textContent = 'لم يتم اختيار مجلد حفظ بعد. لن يستطيع الخادم حفظ أي منتج قبل اختيار مجلد.';
        }
        if (banner) banner.style.display = 'block';
    }
}

// Arabic: قراءة حالة مجلد الحفظ الحالي من الخادم.
// English: Read the current save-folder status from the server.
async function refreshFolderStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/paths/status`, { cache: 'no-store' });
        const data = await response.json();
        renderFolderStatus(data);
        return data;
    } catch (_) {
        renderFolderStatus({ configured: false });
        return null;
    }
}

// Arabic: فتح نافذة اختيار مجلد أصلية على جهاز المستخدم عبر الخادم المحلي.
// English: Open a native folder picker on the user's machine through the local server.
async function chooseFolder() {
    showStatus('افتح نافذة اختيار المجلد على جهازك وانتظر...', 'warning', 15000);
    const response = await fetch(`${API_BASE}/api/paths/choose-folder`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok || !data.success) {
        if (data.cancelled) {
            showStatus('لم يتم اختيار أي مجلد.', 'warning');
        } else {
            throw new Error(data.error || 'تعذر فتح نافذة اختيار المجلد.');
        }
        return;
    }

    renderFolderStatus(data);
    showStatus('تم حفظ مجلد الحفظ بنجاح.', 'success');
    await refreshArchiveStats();
}

// =========================================================
// Arabic: مزامنة بين مستخدمين - تحميل/حفظ الإعدادات وعرض الحالة.
// English: Two-user sync - load/save settings and render status.
// =========================================================

// Arabic: قراءة إعدادات المزامنة الحالية وتعبئة الحقول (المفتاح لا يُعاد كاملاً لأسباب أمنية).
// English: Read current sync settings and populate the fields (the token is never sent back in full).
async function loadSyncSettings() {
    try {
        const response = await fetch(`${API_BASE}/api/sync/config`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) return;

        if (byId('SyncEnabled')) byId('SyncEnabled').checked = Boolean(data.Enabled);
        if (byId('SyncServerUrl')) byId('SyncServerUrl').value = data.ServerUrl || '';
        if (byId('AddedByName')) byId('AddedByName').value = data.AddedByName || '';
        if (byId('SyncToken')) {
            byId('SyncToken').placeholder = data.TokenSet
                ? `مفتاح محفوظ (${data.TokenPreview}) - اتركه فارغاً للإبقاء عليه`
                : 'لم يُضبط بعد';
        }
    } catch (_) {
        // Arabic: عدم توفر الخادم لا يمنع بقية اللوحة من العمل. English: Server unavailability should not break the rest of the popup.
    }
}

// Arabic: حفظ إعدادات المزامنة (رابط، مفتاح اختياري، اسم المستخدم).
// English: Save sync settings (URL, optional token, user name).
async function saveSyncSettings() {
    const resultBox = byId('syncSettingsResult');
    const payload = {
        Enabled: Boolean(byId('SyncEnabled')?.checked),
        ServerUrl: String(byId('SyncServerUrl')?.value || '').trim(),
        Token: String(byId('SyncToken')?.value || '').trim(),
        AddedByName: String(byId('AddedByName')?.value || '').trim(),
    };

    if (payload.Enabled && (!payload.ServerUrl)) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = 'أدخل رابط مجلد المزامنة قبل التفعيل.';
        }
        return;
    }

    const response = await fetch(`${API_BASE}/api/sync/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر حفظ إعدادات المزامنة.');
    }

    if (byId('SyncToken')) byId('SyncToken').value = '';
    if (resultBox) {
        resultBox.className = 'result-box success';
        resultBox.textContent = 'تم حفظ إعدادات المزامنة.';
    }
    await loadSyncSettings();
    await refreshSyncStatus();
}

function formatSyncTimestamp(value) {
    if (!value) return '—';
    try {
        return new Date(value).toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    } catch (_) {
        return value;
    }
}

// Arabic: عرض آخر سحب/رفع وعدد العناصر بالطابور.
// English: Render last pull/push and the pending queue size.
async function refreshSyncStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/sync/status`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) return;

        if (byId('syncPendingCount')) byId('syncPendingCount').textContent = data.pending_queue;
        if (byId('syncLastPull')) byId('syncLastPull').textContent = formatSyncTimestamp(data.last_pull_at);
        if (byId('syncLastPush')) byId('syncLastPush').textContent = formatSyncTimestamp(data.last_push_at);

        const resultBox = byId('syncStatusResult');
        if (resultBox) {
            if (!data.enabled) {
                resultBox.className = 'result-box warning';
                resultBox.textContent = 'المزامنة معطّلة حالياً.';
            } else if (data.last_error) {
                resultBox.className = 'result-box error';
                resultBox.textContent = `آخر خطأ: ${data.last_error}`;
            } else {
                resultBox.className = 'result-box success';
                resultBox.textContent = `متصلة بـ ${data.server_url}`;
            }
        }
    } catch (_) {
        // Arabic: يُترك بصمت؛ checkServer يعرض بالفعل حالة اتصال Python العامة. English: Left silent; checkServer already surfaces general Python connectivity.
    }
}

// Arabic: تشغيل دورة مزامنة فورية عند الضغط على الزر.
// English: Run one immediate sync cycle on button press.
async function triggerSyncNow() {
    const response = await fetch(`${API_BASE}/api/sync/now`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر تشغيل المزامنة.');
    }

    showStatus('تمت المزامنة.', 'success');
    await refreshSyncStatus();
    await refreshRecentProducts();
}

// Arabic: شاشة تشخيص صغيرة تعرض آخر المنتجات ومن أضافها من الطرفين.
// English: A small diagnostics view showing the latest products and who added them from either side.
async function refreshRecentProducts() {
    const box = byId('recentProductsBox');
    if (!box) return;
    box.textContent = 'جارِ التحميل...';

    try {
        const response = await fetch(`${API_BASE}/api/archive/recent?limit=40`, { cache: 'no-store' });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر تحميل القائمة.');
        }

        if (!data.products.length) {
            box.textContent = 'لا توجد منتجات بعد.';
            return;
        }

        box.innerHTML = data.products.map(product => `
            <div class="store-card">
                <div>
                    <strong>#${product.id} — ${escapeHtmlForPopup(product.name_en || '')}</strong>
                    <span>${escapeHtmlForPopup(product.brand_name || '')} • أضافه: ${escapeHtmlForPopup(product.added_by || 'غير محدد')}</span>
                </div>
                <span class="badge">${product.id_source === 'local_fallback' ? 'محلي' : 'مركزي'}</span>
            </div>
        `).join('');
    } catch (error) {
        box.textContent = error.message;
    }
}

// Arabic: تنظيف بسيط للنصوص قبل حقنها كـ HTML في قائمة آخر المنتجات.
// English: A small text-escape helper before injecting HTML into the recent-products list.
function escapeHtmlForPopup(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}

// Arabic: توليد تقرير PDF (يومي/شهري) وفتح رابط التنزيل مباشرة.
// English: Generate a PDF report (daily/monthly) and open the download link directly.
// Arabic: الأيام المتفرقة المختارة حالياً لتقرير "أيام محددة" (YYYY-MM-DD، مرتّبة وبلا تكرار).
// English: The scattered days currently picked for a "selected days" report (YYYY-MM-DD, sorted, unique).
let selectedReportDays = [];

// Arabic: يُظهر الحقول المناسبة للنطاق المختار فقط، ويخفي ما لا يخصّه.
// English: Shows only the fields the chosen scope needs, hiding the rest.
function refreshReportScopeFields() {
    const scope = byId('reportScope')?.value || 'daily';
    const show = (id, visible) => {
        const el = byId(id);
        if (el) el.style.display = visible ? '' : 'none';
    };
    show('reportDateField', scope === 'daily' || scope === 'monthly');
    show('reportDaysBlock', scope === 'days');
    show('reportRangeBlock', scope === 'range');

    const dateLabel = byId('reportDateField')?.querySelector('label');
    if (dateLabel) dateLabel.textContent = scope === 'monthly' ? 'أي يوم داخل الشهر المطلوب' : 'التاريخ';
}

// Arabic: يرسم قائمة الأيام المختارة مع زر حذف لكل يوم.
// English: Renders the picked days with a remove button on each.
function renderSelectedReportDays() {
    const list = byId('reportDaysList');
    if (!list) return;
    if (!selectedReportDays.length) {
        list.className = 'result-box';
        list.textContent = 'لم تُختر أي أيام بعد.';
        return;
    }
    list.className = 'result-box success';
    list.innerHTML = selectedReportDays
        .map(day => `<span class="report-day-chip">${day}<button type="button" data-day="${day}" title="حذف">×</button></span>`)
        .join(' ');
    list.querySelectorAll('button[data-day]').forEach(button => {
        button.onclick = () => {
            selectedReportDays = selectedReportDays.filter(day => day !== button.dataset.day);
            renderSelectedReportDays();
        };
    });
}

function addSelectedReportDay() {
    const value = byId('reportDayPicker')?.value || '';
    if (!value) return;
    if (!selectedReportDays.includes(value)) {
        selectedReportDays.push(value);
        selectedReportDays.sort();
    }
    renderSelectedReportDays();
}

// English: Generate a PDF report for any scope and open the download link directly.
async function generateReport() {
    const resultBox = byId('reportResult');
    const scope = byId('reportScope')?.value || 'daily';
    const payload = { scope, date: byId('reportDate')?.value || '' };

    // Arabic: أي فشل يجب أن يمسح نتيجة التوليد السابقة، وإلا بقيت رسالة نجاح قديمة معروضة
    //         بجانب رسالة الخطأ فيظن المستخدم أن التقرير تولّد فعلاً.
    // English: Any failure must clear the previous result, otherwise a stale success message
    //          stays on screen next to the error and the operator thinks a report was produced.
    const failWith = message => {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = message;
        }
        throw new Error(message);
    };

    if (resultBox) {
        resultBox.className = 'result-box';
        resultBox.textContent = 'جاري توليد التقرير...';
    }

    // Arabic: تحقق محلي قبل إزعاج الخادم برسائل خطأ متوقعة.
    // English: Validate locally before bothering the server with predictable errors.
    if (scope === 'days') {
        if (!selectedReportDays.length) failWith('أضف يوماً واحداً على الأقل إلى القائمة.');
        payload.days = selectedReportDays;
    }
    if (scope === 'range') {
        const from = byId('reportFrom')?.value || '';
        const to = byId('reportTo')?.value || '';
        if (!from || !to) failWith('حدد تاريخ البداية وتاريخ النهاية.');
        payload.from = from;
        payload.to = to;
    }

    const response = await fetch(`${API_BASE}/api/reports/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
        failWith(data.error || 'تعذر توليد التقرير.');
    }

    if (resultBox) {
        const covered = data.days_covered ? ` (${data.days_covered} يوم)` : '';
        resultBox.className = 'result-box success';
        resultBox.innerHTML = `تم التوليد${covered}: <a href="${data.download_url}" target="_blank">${data.filename}</a>`;
    }
    chrome.tabs.create({ url: data.download_url });
}

// =========================================================
// Arabic: تبويب "إصلاح البيانات" - فحص المنتجات الناقصة/الزائدة حقولاً والأخطاء، تطبيق
//         قيم افتراضية بعد موافقة صريحة، وتنزيل تقريرين منفصلين (أخطاء / حقول زائدة).
// English: "Data repair" tab - scans products for missing/extra fields and errors,
//          applies default values after explicit confirmation, and downloads two
//          separate report files (errors / extra fields).
// =========================================================

let lastDataRepairScan = null;

// Arabic: تسمية عربية مقروءة لكل حقل من الشكل المرجعي. English: A readable Arabic label for each reference-shape field.
function fieldLabelArabic(fieldName) {
    const labels = {
        id: 'المعرّف (id)', product_type: 'نوع المنتج', name: 'الاسم', description: 'الوصف',
        name_en: 'الاسم بالإنجليزية', description_en: 'الوصف بالإنجليزية', name_ar: 'الاسم بالعربية',
        description_ar: 'الوصف بالعربية', brand_name: 'اسم البراند', brand_id: 'معرّف البراند',
        style_code: 'Style Code', search_code: 'Search Code', price: 'السعر', variants: 'المقاسات والأسعار',
        sizes: 'المقاسات', date: 'التاريخ', created_at: 'تاريخ الإنشاء', workflow_status: 'حالة التجهيز',
        store_submission_status: 'حالة الإرسال للمتجر', folder: 'مجلد المنتج', brand_folder: 'مجلد البراند',
        date_folder: 'مجلد التاريخ', added_by: 'أضافه', id_source: 'مصدر الـ ID',
        upload_main_image_only: 'رفع الصورة الرئيسية فقط', images: 'الصور', store_images: 'صور المتجر',
        store_main_image: 'الصورة الرئيسية', selected_image_indexes: 'فهارس الصور المختارة',
        download_selected_images_only: 'تنزيل الصور المختارة فقط', source_image_count: 'عدد صور المصدر',
        downloaded_image_count: 'عدد الصور المنزّلة', source_url: 'رابط المصدر',
        supplier_store_name: 'اسم متجر المورد', supplier_store_id: 'معرّف متجر المورد', settings: 'الإعدادات',
    };
    return labels[fieldName] || fieldName;
}

// Arabic: فحص الأرشيف وعرض ملخص الحقول الناقصة/الزائدة والأخطاء، مع حقل إدخال لكل نوع حقل ناقص.
// English: Scan the archive and render the missing/extra-fields and errors summary, with one input per missing field type.
async function scanDataRepair() {
    const summaryBox = byId('dataRepairScanSummary');
    const fieldsCard = byId('dataRepairFieldsCard');
    const fieldsList = byId('dataRepairFieldsList');
    if (summaryBox) { summaryBox.className = 'result-box'; summaryBox.textContent = 'جارٍ الفحص...'; }

    const response = await fetch(`${API_BASE}/api/data-repair/scan`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر فحص البيانات.');
    }

    lastDataRepairScan = data;
    const missingCount = Object.keys(data.missing_fields || {}).length;
    const extraCount = Object.keys(data.extra_fields || {}).length;
    const errorsCount = (data.errors || []).length;

    if (summaryBox) {
        const hasIssues = missingCount || extraCount || errorsCount;
        summaryBox.className = hasIssues ? 'result-box warning' : 'result-box success';
        summaryBox.innerHTML = hasIssues
            ? `تم اكتشاف: ${missingCount} نوع حقل ناقص، ${extraCount} نوع حقل زائد، ${errorsCount} خطأ. راجع القسم أدناه وحمّل التقارير للتفاصيل.`
            : 'لا توجد مشاكل - كل المنتجات مطابقة للشكل المرجعي.';
    }

    if (fieldsList) fieldsList.innerHTML = '';
    if (missingCount > 0 && fieldsCard && fieldsList) {
        fieldsCard.style.display = '';
        Object.entries(data.missing_fields).forEach(([field, entries]) => {
            const row = document.createElement('div');
            row.className = 'field';
            row.innerHTML = `
                <label>${escapeHtmlForPopup(fieldLabelArabic(field))} <span class="hint">(${entries.length} منتج ناقصه)</span></label>
                <input type="text" class="data-repair-field-input" data-field="${escapeHtmlForPopup(field)}" placeholder="القيمة الافتراضية لهذا الحقل">
            `;
            fieldsList.appendChild(row);
        });
    } else if (fieldsCard) {
        fieldsCard.style.display = 'none';
    }
}

// Arabic: تطبيق القيم الافتراضية اللي أدخلها المشغّل على الحقول الناقصة، بعد تأكيد صريح.
// English: Apply the operator-entered default values to the missing fields, after explicit confirmation.
async function applyDataRepairFix() {
    const resultBox = byId('dataRepairApplyResult');
    const inputs = document.querySelectorAll('.data-repair-field-input');
    const values = {};
    inputs.forEach(input => {
        const field = input.dataset.field;
        const value = input.value.trim();
        if (field && value) values[field] = value;
    });

    if (Object.keys(values).length === 0) {
        throw new Error('عبّئ قيمة واحدة على الأقل قبل الموافقة على الإصلاح.');
    }

    const confirmed = confirm(
        `سيتم تعبئة ${Object.keys(values).length} نوع حقل على المنتجات الناقصة لها فقط، ثم رفعها للسيرفر. ` +
        `سيُؤخذ نسخة احتياطية تلقائياً من archive_db.json قبل ذلك. متابعة؟`
    );
    if (!confirmed) return;

    if (resultBox) { resultBox.className = 'result-box'; resultBox.textContent = 'جارٍ التطبيق...'; }

    const response = await fetch(`${API_BASE}/api/data-repair/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر تطبيق الإصلاح.');
    }

    if (resultBox) {
        resultBox.className = 'result-box success';
        resultBox.innerHTML = `تم تعديل ${data.updated_products} منتج، ورُفع ${data.pushed} منها للسيرفر.` +
            (data.push_errors && data.push_errors.length
                ? `<br>تحذير: فشل رفع ${data.push_errors.length} منتج للسيرفر الآن (سيُعاد تلقائياً عبر طابور المزامنة).`
                : '') +
            (data.backup_path ? `<br>نسخة احتياطية: ${escapeHtmlForPopup(data.backup_path)}` : '');
    }

    await scanDataRepair();
}

// Arabic: توليد تقريري الأخطاء والحقول الزائدة وفتح رابطي التنزيل مباشرة.
// English: Generate the errors and extra-fields reports and open both download links directly.
async function downloadDataRepairReports() {
    const resultBox = byId('dataRepairReportResult');
    if (resultBox) { resultBox.className = 'result-box'; resultBox.textContent = 'جارٍ توليد التقارير...'; }

    const response = await fetch(`${API_BASE}/api/data-repair/report`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر توليد التقارير.');
    }

    if (resultBox) {
        resultBox.className = 'result-box success';
        resultBox.innerHTML =
            `<a href="${data.errors_report.download_url}" target="_blank">تنزيل تقرير الأخطاء</a> — ` +
            `<a href="${data.extra_fields_report.download_url}" target="_blank">تنزيل تقرير الحقول الزائدة</a>`;
    }
    chrome.tabs.create({ url: data.errors_report.download_url });
    chrome.tabs.create({ url: data.extra_fields_report.download_url });
}

// Arabic: يعرض بطاقة تصنيف الأحذية أو بطاقة إعدادات الساعات فقط - حسب النوع المختار في "نوع المنتج" -
//         بدل عرض تصنيفَي الأحذية والساعات معاً دائماً.
// English: Shows only the shoes-classification card or the watches-settings card - based on the
//          selected ProductType - instead of always showing both classification cards at once.
function updateProductTypeCardVisibility() {
    const productType = byId('ProductType') ? byId('ProductType').value : 'shoes';
    document.querySelectorAll('[data-producttype-card]').forEach(card => {
        card.style.display = card.dataset.producttypeCard === productType ? '' : 'none';
    });
}

// Arabic: ربط حدث بأمان حتى لا تتعطل اللوحة إذا غاب عنصر اختياري.
// English: Safely bind an event so optional missing controls cannot break the popup.
function bindClick(id, handler) {
    const element = byId(id);
    if (!element) return;

    element.addEventListener('click', event => {
        Promise.resolve(handler(event)).catch(error => {
            showStatus(error.message || String(error), 'error', 7500);
        });
    });
}

// Arabic: تسجيل الدخول عبر الخادم
// English: Login via server
// =========================================================
// Arabic: مزامنة من شاشة تسجيل الدخول.
//         تسجيل الدخول يمر فعلياً عبر خادم المزامنة: ‎/api/sync/login يرفض الطلب برسالة
//         "أدخل كود المزامنة من تبويب الإعدادات أولاً" إذا كان ServerUrl أو Token ناقصاً.
//         فبدل إرسال المستخدم لتبويب آخر، تُضبط المزامنة وتُختبر من نفس الشاشة.
// English: Sync from the login screen.
//          Login genuinely goes through the sync server: /api/sync/login rejects the request
//          with "enter the sync code from the settings tab first" when ServerUrl or Token is
//          missing. So instead of sending the operator to another tab, sync is configured and
//          tested right here.
// =========================================================

// Arabic: يعكس حالة المزامنة على الواجهة ويقرر تفعيل زر تسجيل الدخول.
// English: Reflects the sync state in the UI and decides whether login is enabled.
function setLoginSyncState(kind, message) {
    const box = byId('loginSyncStatus');
    const loginButton = byId('loginBtnCheck');
    if (box) {
        box.className = `result-box ${kind === 'ok' ? 'success' : kind === 'error' ? 'error' : ''}`;
        box.textContent = message;
    }
    // Arabic: "local" = المزامنة غير مفعّلة، ويبقى دخول الأدمن المحلي ممكناً (سلوك قائم
    //         بالباك اند لا يصح كسره)، فنسمح بالمحاولة مع تنبيه واضح.
    // English: "local" = sync is disabled, and the local admin login still works (existing
    //          backend behaviour that must not be broken), so allow the attempt with a clear notice.
    if (loginButton) loginButton.disabled = !(kind === 'ok' || kind === 'local');
}

// Arabic: تعبئة رابط المزامنة المحفوظ مسبقاً، وبيان هل الكود محفوظ أصلاً.
// English: Prefill the saved sync URL and show whether a code is already stored.
async function loadLoginSyncSettings() {
    try {
        const response = await fetch(`${API_BASE}/api/sync/config`, { cache: 'no-store' });
        const data = await response.json();
        if (!data.success) return;
        if (byId('loginSyncUrl') && data.ServerUrl) byId('loginSyncUrl').value = data.ServerUrl;
        if (byId('loginSyncToken')) {
            byId('loginSyncToken').placeholder = data.TokenSet
                ? `كود محفوظ (${data.TokenPreview}) — اتركه فارغاً للإبقاء عليه`
                : 'أدخل كود المزامنة';
        }
        if (data.Enabled && data.ServerUrl && data.TokenSet) {
            setLoginSyncState('', 'توجد إعدادات مزامنة محفوظة — اضغط "حفظ المزامنة والتحقق" للتأكد.');
        } else if (!data.Enabled && !data.ServerUrl) {
            // Arabic: لا مزامنة مضبوطة إطلاقاً - الباك اند يسمح بدخول أدمن محلي (admin/admin).
            //         لا نقفل الزر نهائياً حتى لا نكسر هذا المسار القائم.
            // English: No sync configured at all - the backend still allows a local admin login
            //          (admin/admin). Don't hard-lock the button and break that existing path.
            setLoginSyncState('local', 'لا توجد مزامنة مضبوطة — يمكن دخول الأدمن المحلي فقط. اضبط المزامنة لدخول الأعضاء.');
        }
    } catch (_) {
        setLoginSyncState('error', 'تعذر الوصول للخادم المحلي. شغّل الباك اند ثم أعد المحاولة.');
    }
}

// Arabic: يحفظ إعدادات المزامنة ثم يختبرها فعلياً بدورة مزامنة حقيقية (‎/api/sync/now)،
//         ولا يُفعّل زر تسجيل الدخول إلا بعد نجاح فعلي لا بمجرد الحفظ.
// English: Saves the sync settings then genuinely tests them with a real sync cycle
//          (/api/sync/now), enabling the login button only on an actual success - never on a
//          mere save.
async function handleLoginSync() {
    const button = byId('loginSyncBtn');
    const serverUrl = String(byId('loginSyncUrl')?.value || '').trim();
    const token = String(byId('loginSyncToken')?.value || '').trim();

    if (!serverUrl) {
        setLoginSyncState('error', 'أدخل رابط المزامنة أولاً.');
        return;
    }

    if (button) { button.disabled = true; button.textContent = 'جاري التحقق...'; }
    setLoginSyncState('', 'جاري حفظ الإعدادات واختبار الاتصال...');

    try {
        const saveResponse = await fetch(`${API_BASE}/api/sync/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Arabic: Token فاضٍ يعني "أبقِ المحفوظ" (الباك اند يتعامل مع هذا أصلاً).
            // English: An empty Token means "keep the stored one" (the backend already handles this).
            body: JSON.stringify({ Enabled: true, ServerUrl: serverUrl, Token: token }),
        });
        const saveData = await saveResponse.json();
        if (!saveResponse.ok || !saveData.success) {
            throw new Error(saveData.error || 'تعذر حفظ إعدادات المزامنة.');
        }

        const testResponse = await fetch(`${API_BASE}/api/sync/now`, { method: 'POST' });
        const testData = await testResponse.json();
        if (!testResponse.ok || !testData.success) {
            throw new Error(testData.error || 'فشل الاتصال بخادم المزامنة.');
        }

        const pending = Number(testData.pending_queue || 0);
        setLoginSyncState('ok', `نجحت المزامنة ✔ يمكنك تسجيل الدخول الآن.${pending ? ` (${pending} عنصر بالطابور)` : ''}`);
    } catch (error) {
        setLoginSyncState('error', `فشلت المزامنة: ${error.message}`);
    } finally {
        if (button) { button.disabled = false; button.textContent = 'حفظ المزامنة والتحقق'; }
    }
}

async function handleLoginOverlay() {
    const errorBox = byId('loginErrorBox');
    const name = byId('loginName').value.trim();
    const password = byId('loginPass').value.trim();

    if (!name) {
        errorBox.textContent = 'أدخل الاسم أولاً.';
        errorBox.style.display = 'block';
        return;
    }

    errorBox.style.display = 'none';
    byId('loginBtnCheck').textContent = 'جاري التحقق...';

    try {
        const response = await fetch(`${API_BASE}/api/sync/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, password })
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'فشل التحقق، تأكد من بياناتك أو من اتصال الأداة بالخادم.');
        }

        const role = data.member?.role || 'member';
        const displayName = data.member?.display_name || name;
        await chrome.storage.local.set({ sessionLoggedIn: true, sessionRole: role, sessionTime: Date.now(), sessionName: displayName });

        applyRoleRestrictions(role);
        byId('profileChip').textContent = displayName;
        byId('loginOverlay').style.display = 'none';
        showStatus(`مرحباً ${displayName} (${role})`, 'success');
    } catch (e) {
        errorBox.textContent = e.message;
        errorBox.style.display = 'block';
    } finally {
        byId('loginBtnCheck').textContent = 'تسجيل الدخول';
    }
}

// Arabic: فحص الجلسة وإغلاق الشاشة إذا كان مسجلاً
// English: Check session and hide login screen if logged in
async function checkLoginState() {
    const stored = await chrome.storage.local.get(['sessionLoggedIn', 'sessionRole', 'sessionName']);
    if (stored.sessionLoggedIn) {
        applyRoleRestrictions(stored.sessionRole);
        byId('profileChip').textContent = stored.sessionName || 'Sooqify Online';
        byId('loginOverlay').style.display = 'none';
    } else {
        byId('profileChip').textContent = 'Sooqify Online';
        byId('loginOverlay').style.display = 'flex';
        // Arabic: شاشة الدخول ظاهرة - جهّز حقول المزامنة وابقِ زر الدخول معطّلاً حتى التحقق.
        // English: The login screen is visible - prepare the sync fields and keep login disabled
        //          until the check passes.
        setLoginSyncState('', 'اضبط المزامنة أولاً ثم سجّل الدخول.');
        await loadLoginSyncSettings();
    }
}

// Logout: clear session-related local storage and restore overlay
async function handleLogout() {
    await chrome.storage.local.remove(['sessionLoggedIn', 'sessionRole', 'sessionTime', 'sessionName']);
    applyRoleRestrictions(''); // hide admin areas
    byId('profileChip').textContent = 'Sooqify Online';
    byId('loginOverlay').style.display = 'flex';
    showStatus('تم تسجيل الخروج.', 'success');
}

// Arabic: إخفاء التبويبات والمميزات المخصصة للأدمن عن الأعضاء
// English: Hide admin tabs and features from regular members
function applyRoleRestrictions(role) {
    // role: 'admin' or 'project_manager' => full access
    // regular members => only show 'settings' and 'product-type' tabs
    const memberVisible = ['settings', 'product-type'];
    if (role === 'admin' || role === 'project_manager') {
        document.querySelectorAll('.admin-only-element').forEach(el => { el.style.display = 'block'; });
        document.querySelectorAll('.tab-button').forEach(btn => { btn.style.display = ''; });
        return;
    }

    // Default to member view: hide admin sections and most tabs
    document.querySelectorAll('.admin-only-element').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.style.display = memberVisible.includes(btn.dataset.tab) ? '' : 'none';
    });

    const activeTab = document.querySelector('.tab-button.active')?.dataset.tab;
    if (!memberVisible.includes(activeTab)) {
        activateTab('settings');
    }
}

// Arabic: نسخ الأسماء
// English: Copy batches
async function copyAdminBatchNames() {
    const list = document.querySelectorAll('#recentProductsBox .store-card strong');
    let names = [];
    list.forEach(el => {
        let text = el.textContent || '';
        let parts = text.split('—');
        if (parts.length > 1) {
            names.push(parts[1].trim());
        }
    });

    if (names.length === 0) {
        showStatus('لا أجد منتجات معروضة لنسخها.', 'warning');
        return;
    }

    const joined = names.join('\n+\n');
    try {
        await navigator.clipboard.writeText(joined);
        showStatus('تم نسخ ' + names.length + ' أسماء بنجاح', 'success');
    } catch (e) {
        showStatus('فشل في نسخ النص: ' + e.message, 'error');
    }
}

// Arabic: تهيئة جميع أحداث لوحة v4.
// English: Initialize all v4 popup events.
async function initializePopup() {
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => activateTab(button.dataset.tab));
    });

    if (byId('ProductType')) {
        byId('ProductType').addEventListener('change', updateProductTypeCardVisibility);
    }

    bindClick('saveBtn', saveConfiguration);
    bindClick('searchArchiveBtn', searchArchive);
    bindClick('prepareArchiveBtn', prepareArchivedProduct);
    bindClick('requestSupplierProductBtn', requestProductFromSupplier);
    bindClick('openStoreBtn', openSupplierHomeDirectly);
    bindClick('openStoreBtnInline', openSupplierAtLastProduct);
    bindClick('refreshStatsBtn', refreshArchiveStats);
    bindClick('deleteProductBtn', deleteProductData);
    bindClick('clearAllBtn', clearAllData);
    bindClick('refreshLogsBtn', refreshLogs);
    bindClick('downloadLogsBtn', downloadLogs);
    bindClick('resetPanelPositionBtn', resetPanelPosition);
    bindClick('chooseFolderBtn', chooseFolder);
    bindClick('folderSetupBannerBtn', chooseFolder);
    bindClick('saveSyncBtn', saveSyncSettings);
    bindClick('syncNowBtn', triggerSyncNow);
    bindClick('reconcileFullBtn', async () => {
        const btn = byId('reconcileFullBtn');
        const resultBox = byId('syncStatusResult');
        try {
            btn.disabled = true;
            btn.textContent = 'جارٍ الدمج...';
            const resp = await fetch(`${API_BASE}/api/sync/reconcile`, { method: 'POST' });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                resultBox.className = 'result-box error';
                resultBox.textContent = data.error || 'تعذر إجراء الدمج.';
            } else {
                resultBox.className = 'result-box success';
                resultBox.textContent = `نجح الدمج: تم سحب ${data.server_count || 0} عناصر، رفع ${data.pushed_immediate || 0} منتجات محلية.`;
            }
        } catch (error) {
            byId('syncStatusResult').className = 'result-box error';
            byId('syncStatusResult').textContent = error.message || String(error);
        } finally {
            btn.disabled = false;
            btn.textContent = 'دمج كامل مع الأرشيف المركزي';
            await refreshSyncStatus();
        }
    });
    bindClick('refreshRecentBtn', refreshRecentProducts);
    bindClick('generateReportBtn', generateReport);
    bindClick('reportAddDayBtn', addSelectedReportDay);
    byId('reportScope')?.addEventListener('change', refreshReportScopeFields);
    refreshReportScopeFields();
    renderSelectedReportDays();
    bindClick('loginBtnCheck', handleLoginOverlay);
    bindClick('loginSyncBtn', handleLoginSync);
    bindClick('logoutBtn', handleLogout);
    bindClick('copyBatchNamesBtn', copyAdminBatchNames);
// Arabic: مفتاح الكاش المشترك مع content.js (resolveBrandId) - نفس الاسم بالضبط
//         بالملفين، القراءة/الكتابة تصير عبر chrome.storage.local بكلا الاتجاهين.
// English: Cache key shared with content.js (resolveBrandId) - the exact same name in
//          both files, read/write happens through chrome.storage.local both ways.
const BRANDS_CACHE_STORAGE_KEY = 'alphacode_brands_cache';

// Arabic: يقرأ آخر نسخة محفوظة من قائمة البراندات بـchrome.storage (كتبها آخر نداء
//         ناجح لـ/api/brands، من هذا popup أو من content.js) - يُستخدم فقط لو نداء
//         /api/brands الحي فشل بالكامل الآن. لا يوجد أي مصدر محلي ثابت بعد الآن
//         (BrandMapJson انحذفت بالكامل - الاعتماد صار كلياً على السيرفر + كاش منه).
// English: Reads the last cached brand list from chrome.storage (written by the last
//          successful /api/brands call, from this popup or from content.js) - used only
//          when the live /api/brands call fails entirely right now. No fixed local
//          source exists anymore (BrandMapJson was removed entirely - reliance is fully
//          on the server + a cache of it).
async function loadBrandsCacheFallback() {
    try {
        const stored = await chrome.storage.local.get([BRANDS_CACHE_STORAGE_KEY]);
        const cached = stored[BRANDS_CACHE_STORAGE_KEY];
        return Array.isArray(cached) ? cached : [];
    } catch (_) {
        return [];
    }
}

// Arabic: يبني قائمة اختيار البراند الموحّدة (تعرض الاسم، تخزّن id) من /api/brands
//         مباشرة، ويحفظ النتيجة الناجحة بـchrome.storage (alphacode_brands_cache) عشان
//         content.js (resolveBrandId) يقدر يستخدمها بدون أي نداء شبكة إضافي. لو فشل
//         نداء /api/brands نفسه (خطأ شبكة/502) ترجع لآخر نسخة محفوظة بالكاش كاحتياط
//         كامل. تُزامن input#BrandName المخفي مع كل تغيير اختيار.
// English: Builds the unified brand-select (shows the name, stores the id) straight
//          from /api/brands, and persists a successful result to chrome.storage
//          (alphacode_brands_cache) so content.js (resolveBrandId) can use it without an
//          extra network call. Falls back entirely to the last cached list when the
//          /api/brands call itself fails (network error/502). Keeps the hidden
//          #BrandName input synced with every selection change.
async function loadBrandsIntoSelect() {
    const select = byId('BrandId');
    if (!select) return;

    let brands = [];
    try {
        const res = await fetch(`${API_BASE}/api/brands`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok && data.success && Array.isArray(data.brands) && data.brands.length) {
            brands = data.brands.map(b => ({
                id: b.id,
                name: b.name || `براند #${b.id}`,
            }));
            await chrome.storage.local.set({ [BRANDS_CACHE_STORAGE_KEY]: brands });
        }
    } catch (_) {
        // Arabic: تُترك فارغة؛ الاحتياط الكامل بالأسفل يتكفّل بها. English: Left empty; the full fallback below takes over.
    }

    if (!brands.length) {
        brands = await loadBrandsCacheFallback();
    }

    // Arabic: نحتفظ بالاختيار الحالي، ولو كان فاضياً نرجع لـBrandId المحفوظ بالإعدادات -
    //         لأن loadBrandsIntoSelect قد تعمل بعد populateForm فتمسح اختيارها.
    // English: Keep the current selection; if it is empty fall back to the saved BrandId,
    //          because loadBrandsIntoSelect can run after populateForm and wipe its choice.
    const currentVal = select.value || String(currentConfig.BrandId || '');
    select.innerHTML = '<option value="">— اختر براند —</option>';
    brands.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.name;
        select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;

    select.onchange = syncBrandNameFromSelect;

    // Arabic: مزامنة فورية بعد بناء الخيارات. كان هذا هو الباغ: BrandName حقل مخفي لا
    //         يُحدَّث إلا بحدث change، وتحديد الاختيار برمجياً لا يُطلق change - فيبقى
    //         BrandName فاضياً أو قديماً بينما القائمة تعرض البراند الصحيح، فيصل للمتجر
    //         اسم براند خاطئ أو فاضٍ رغم أن المستخدم "اختاره".
    // English: Sync immediately after the options are built. This was the bug: BrandName is a
    //          hidden field updated only on a change event, and setting the selection
    //          programmatically fires no change - so BrandName stayed empty or stale while the
    //          dropdown displayed the right brand, and the store received a wrong or empty
    //          brand name even though the operator had "picked" one.
    syncBrandNameFromSelect();
}

async function addBrandToServer() {
    const name = (byId('NewBrandName')?.value || '').trim();
    const id = parseInt(byId('NewBrandId')?.value || '0', 10);
    const resultBox = byId('addBrandResult');
    if (!name || !id) {
        if (resultBox) { resultBox.style.display = ''; resultBox.className = 'result-box error'; resultBox.textContent = 'أدخل اسم البراند والـ ID.'; }
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/brands/add`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, id }),
        });
        const data = await res.json();
        if (resultBox) {
            resultBox.style.display = '';
            resultBox.className = res.ok && data.success ? 'result-box success' : 'result-box error';
            resultBox.textContent = res.ok && data.success ? `تمت إضافة "${name}" (${id}) بنجاح.` : (data.error || 'تعذرت الإضافة.');
        }
        if (res.ok && data.success) await loadBrandsIntoSelect();
    } catch (err) {
        if (resultBox) { resultBox.style.display = ''; resultBox.className = 'result-box error'; resultBox.textContent = String(err); }
    }
}

    bindClick('dataRepairScanBtn', scanDataRepair);
    bindClick('dataRepairApplyBtn', applyDataRepairFix);
    bindClick('dataRepairReportBtn', downloadDataRepairReports);
    bindClick('addBrandBtn', addBrandToServer);

    try {
        // Arabic: لازم ننتظر تحميل خيارات البراند أول - لو استدعيناها بدون await، ممكن
        //         populateForm() يحاول يحدد BrandId المحفوظ بالـselect قبل ما خياراته
        //         توصل أصلاً، فيفشل التحديد بصمت ويرجع الفورم فاضياً رغم وجود قيمة محفوظة.
        // English: Brand options must be loaded first - calling this without await risked
        //          populateForm() trying to select the saved BrandId before the select's
        //          options even existed, silently failing and leaving the field blank
        //          despite a saved value.
        await loadBrandsIntoSelect();
        await loadSavedConfig();
        await checkLoginState();
        await Promise.all([
            checkServer(),
            refreshArchiveStats(),
            refreshFolderStatus(),
        ]);
    } catch (error) {
        showStatus(`تعذر تحميل الإعدادات: ${error.message}`, 'error', 7500);
    }
}

document.addEventListener('DOMContentLoaded', initializePopup);