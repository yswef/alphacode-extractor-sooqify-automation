// =========================================================
// AlphaCode Extractor v5.7.1 - Popup Controller
// Arabic: إدارة الإعدادات، المورد، طلب المنتجات، البيانات، والتشخيص.
// English: Manages settings, supplier workflows, product requests, data, and diagnostics.
// =========================================================

'use strict';

// Arabic: نفس منطق content.js - يُصحَّح للمنفذ الحي بعد الاكتشاف. شوف backend_discovery.js.
// English: Same as content.js - corrected to the live port after discovery. See backend_discovery.js.
let API_BASE = `http://127.0.0.1:${(globalThis.ALPHACODE_DEFAULT_CONFIG || {}).BackendPort || 5000}`;
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

    // Arabic: تبويب المزامنة: نحدّث كل شيء، ونشغّل تحديثاً دورياً كل 20 ثانية أثناء فتحه فقط
    //         حتى تظهر المنتجات القادمة من الطرف الآخر وحالة الإرسال دون تدخل المستخدم.
    // English: The sync tab: refresh everything, and poll every 20 seconds only while it is
    //          open so the other operator's arrivals and submission status appear by themselves.
    if (tabName === 'sync') {
        refreshFolderStatus();
        loadSyncSettings();
        refreshSyncStatus();
        refreshRecentProducts();
        // Arabic: منطقة الخطر: نجلب حالة القفل والنسخ الاحتياطية وتقدّم أي إعادة رفع جارية.
        // English: The danger zone: pull the lock state, the backups and any running re-upload.
        refreshEmergencyStatus();
        updateEmergencyShutdownState();
    }
    startSyncTabAutoRefresh(tabName === 'sync');

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

// Arabic: مؤقّت التحديث الدوري لتبويب المزامنة - يعمل فقط أثناء فتح التبويب ويُلغى عند مغادرته.
// English: The sync tab's polling timer - runs only while the tab is open and is cleared on leave.
let syncTabRefreshTimer = null;

function startSyncTabAutoRefresh(shouldRun) {
    if (syncTabRefreshTimer) {
        clearInterval(syncTabRefreshTimer);
        syncTabRefreshTimer = null;
    }
    if (!shouldRun) return;
    syncTabRefreshTimer = setInterval(() => {
        refreshSyncStatus();
        refreshRecentProducts();
    }, 20000);
}

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
        if (byId('SyncAutoMinutes')) byId('SyncAutoMinutes').value = data.AutoSyncMinutes || 30;
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
        // Arabic: تكرار المزامنة التلقائية بالدقائق - الباك اند يقصّها للحدود المسموحة (5 - 1440).
        // English: The auto-sync interval in minutes - the backend clamps it to 5-1440.
        AutoSyncMinutes: Number(byId('SyncAutoMinutes')?.value || 30),
    };

    if (payload.Enabled && (!payload.ServerUrl)) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = 'أدخل رابط مجلد المزامنة قبل التفعيل.';
        }
        return;
    }

    let response = await fetch(`${API_BASE}/api/sync/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    let data = await response.json();

    // Arabic: المزامنة مقفولة بعد الإيقاف الطارئ: الباك اند يرفض أي تفعيل صامت (409). المسار
    //         الوحيد هو تأكيد الأدمن الصريح + رمز الحماية المحلي إن كان مضبوطاً — وهذا ما يمنع
    //         أي عضو من إحياء المزامنة على جهازه، لأنه لا يعرف الرمز.
    // English: Sync is locked after the emergency shutdown, and the backend refuses any silent
    //          re-enable (409). The only path is the admin's explicit confirmation plus the local
    //          guard password when one is set - which is what stops a member from reviving sync on
    //          their own machine, since they do not know that password.
    if (response.status === 409 && data.locked) {
        const guard = prompt('المزامنة موقوفة نهائياً على هذا الجهاز.\nأدخل رمز الحماية المحلي لإعادة التفعيل (اتركه فارغاً إن لم تضبط رمزاً):');
        if (guard === null) {
            if (resultBox) {
                resultBox.className = 'result-box warning';
                resultBox.textContent = 'تم إلغاء إعادة التفعيل.';
            }
            return;
        }
        response = await fetch(`${API_BASE}/api/sync/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, ConfirmUnlock: true, LocalGuardPassword: guard }),
        });
        data = await response.json();
    }

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

// Arabic: عرض آخر سحب/رفع وعدد العناصر بالطابور، وحالة المزامنة التلقائية (تعمل؟ كل كم دقيقة؟
//         الدورة القادمة متى؟) ونتيجة آخر سحب (كم منتج جديد وصل وكم منها من الطرف الآخر).
// English: Render last pull/push, pending queue, the automatic worker state (running? interval?
//          next run?) and the last pull outcome (how many new products arrived and how many
//          came from the other operator).
async function refreshSyncStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/sync/status`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) return;

        if (byId('syncPendingCount')) byId('syncPendingCount').textContent = data.pending_queue;
        if (byId('syncLastPull')) byId('syncLastPull').textContent = formatSyncTimestamp(data.last_pull_at);
        if (byId('syncLastPush')) byId('syncLastPush').textContent = formatSyncTimestamp(data.last_push_at);
        if (byId('syncNextRun')) {
            byId('syncNextRun').textContent = data.auto_worker_running && data.next_auto_cycle_at
                ? formatSyncTimestamp(data.next_auto_cycle_at)
                : '—';
        }
        if (byId('syncAutoState')) {
            byId('syncAutoState').textContent = data.auto_worker_running
                ? `كل ${data.auto_interval_minutes} د`
                : 'متوقفة';
        }
        if (byId('syncNewCount')) {
            const arrived = Number(data.last_pull_new_count || 0);
            const samePull = data.last_pull_new_from_others_at && data.last_pull_new_from_others_at === data.last_pull_new_at;
            const fromOthers = samePull ? Number(data.last_pull_new_from_others || 0) : 0;
            byId('syncNewCount').textContent = arrived
                ? (fromOthers ? `${arrived} (${fromOthers} من الطرف الآخر)` : String(arrived))
                : '0';
        }

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
                let message = `متصلة بـ ${escapeHtmlForPopup(data.server_url)}`;
                const arrived = Number(data.last_pull_new_count || 0);
                if (arrived) {
                    // Arabic: نعرض "منها X من الطرف الآخر" فقط لو كانت من نفس السحب الذي وصل فيه
                    //         العدد، حتى لا ننسب منتجات سحب قديم لآخر سحب.
                    // English: Show "X from the other operator" only when it belongs to the same
                    //          pull as the count, so an older batch is never attributed to the last one.
                    const fromOthers = data.last_pull_new_from_others_at && data.last_pull_new_from_others_at === data.last_pull_new_at
                        ? Number(data.last_pull_new_from_others || 0)
                        : 0;
                    message += `<br>آخر سحب وصل <strong>${arrived}</strong> منتج جديد`
                        + (fromOthers ? ` (منها <strong>${fromOthers}</strong> أضافها الطرف الآخر)` : '')
                        + ` — ${formatSyncTimestamp(data.last_pull_new_at)}.`;
                }
                if (!data.auto_worker_running) {
                    message += '<br>تنبيه: المزامنة التلقائية متوقفة — تأكد أن الباك اند شغال، أو اضغط "مزامنة الآن".';
                } else {
                    message += `<br>المزامنة التلقائية تعمل كل ${data.auto_interval_minutes} دقيقة.`;
                }
                resultBox.innerHTML = message;
            }
        }
    } catch (_) {
        // Arabic: يُترك بصمت؛ checkServer يعرض بالفعل حالة اتصال Python العامة. English: Left silent; checkServer already surfaces general Python connectivity.
    }
}

// Arabic: تشغيل دورة مزامنة فورية عند الضغط على الزر، مع إظهار كم منتجاً جديداً وصل فعلاً.
// English: Run one immediate sync cycle on button press, reporting how many products actually arrived.
async function triggerSyncNow() {
    const response = await fetch(`${API_BASE}/api/sync/now`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok || !data.success) {
        // Arabic: القفل الطارئ ليس خطأ عابراً - نحدّث لوحة الخطر فوراً ونعرض سبب الإيقاف.
        // English: The emergency lock is not a transient error - refresh the danger panel at
        //          once and show why sync is stopped.
        if (data.locked) {
            await refreshEmergencyStatus();
            throw new Error(data.error || 'المزامنة موقوفة نهائياً على هذا الجهاز.');
        }
        throw new Error(data.error || 'تعذر تشغيل المزامنة.');
    }

    const arrived = Number(data.new_items || 0);
    const fromOthers = Number(data.new_from_others || 0);
    let message = 'تمت المزامنة.';
    if (arrived) {
        message = `تمت المزامنة — وصل ${arrived} منتج جديد`
            + (fromOthers ? ` (منها ${fromOthers} من الطرف الآخر)` : '') + '.';
    }
    showStatus(message, 'success');
    await refreshSyncStatus();
    await refreshRecentProducts();
}

// =========================================================
// Arabic: منطقة خطر الأدمن — نسخة احتياطية كاملة ← مسح بيانات السيرفر ← إيقاف المزامنة نهائياً،
//         ومعهما إعادة الرفع لاحقاً.
//
//         قواعد ثابتة في هذا القسم:
//           - لا يُفعّل زر المسح إلا بعد نجاح نسخة احتياطية فعلية في هذه الجلسة (والترتيب نفسه
//             مفروض في الباك اند: النسخة تُكتب على القرص قبل أي حذف).
//           - العبارتان DELETE-SERVER و RESTORE تُكتبان حرفياً، فلا مسح بضغطة عابرة.
//           - بعد المسح: رابط السيرفر والمفتاح السري يُمسحان من الجهاز، ويتوقف كل نداء شبكة،
//             والدخول المحلي يبقى للأدمن فقط (وربما برمز حماية محلي إن ضُبط).
// English: The admin danger zone - a full backup -> erase the server data -> stop sync for good,
//          with the later re-upload beside them.
//          Fixed rules here:
//            - The erase button only unlocks after a real backup succeeded in this session (the
//              same order is enforced in the backend: the backup hits the disk before any delete).
//            - The phrases DELETE-SERVER and RESTORE are typed verbatim, so no erase happens by a
//              stray click.
//          After the erase: the server URL and secret token leave this machine, every network
//          call stops, and the local login stays admin-only (optionally behind a local guard).
// =========================================================
let emergencyBackupReady = false;
let emergencyRestoreTimer = null;

// Arabic: تحديث بانر القفل وقائمة النسخ الاحتياطية وتقدّم إعادة الرفع. English: Refresh the lock banner, the backup list and the re-upload progress.
async function refreshEmergencyStatus() {
    const banner = byId('emergencyLockBanner');
    const listBox = byId('emergencyBackupList');
    try {
        const response = await fetch(`${API_BASE}/api/sync/emergency/status`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) return;

        if (banner) {
            if (data.locked) {
                const lock = data.lock || {};
                banner.style.display = 'block';
                banner.className = 'result-box error';
                banner.innerHTML =
                    '<strong>المزامنة موقوفة نهائياً على هذا الجهاز.</strong><br>'
                    + `تم المسح: ${escapeHtmlForPopup(formatSyncTimestamp(lock.ServerErasedAt) || '—')}<br>`
                    + `النسخة الاحتياطية: ${escapeHtmlForPopup(lock.BackupFile || '—')}<br>`
                    + (data.guard_set
                        ? 'الدخول المحلي محمي برمز حماية محلي.<br>'
                        : 'تنبيه: لا يوجد رمز حماية محلي — الدخول المحلي admin/admin مفتوح لأي أحد.<br>')
                    + 'لإعادة التشغيل لاحقاً استخدم القسم (٣) بالأسفل.';
            } else {
                banner.style.display = 'none';
            }
        }

        if (byId('emergencyRestoreUrl') && !byId('emergencyRestoreUrl').value) {
            byId('emergencyRestoreUrl').value = data.lock?.ServerUrl || '';
        }

        // Arabic: أثناء القفل نُعطّل مفتاح التفعيل وزر الحفظ: الباك اند يرفضهما أصلاً (409)،
        //         فالأفضل أن تظهر الحالة بوضوح بدل رسالة خطأ عند كل محاولة.
        // English: While locked the enable switch and the save button are disabled: the backend
        //          rejects both anyway (409), so the state should read clearly instead of an error
        //          on every attempt.
        if (byId('SyncEnabled')) byId('SyncEnabled').disabled = Boolean(data.locked);
        if (byId('saveSyncBtn')) byId('saveSyncBtn').disabled = Boolean(data.locked);

        if (listBox) {
            const backups = Array.isArray(data.backups) ? data.backups : [];
            listBox.innerHTML = backups.length
                ? '<div class="hint">آخر النسخ على هذا الجهاز:</div>' + backups.slice(0, 4).map(item => `
                    <div class="store-card">
                        <div>
                            <strong>${escapeHtmlForPopup(item.name)}</strong>
                            <span>جهازي: ${Number(item.local_products || 0)} · السيرفر: ${Number(item.server_products || 0)} منتج · براندات: ${Number(item.server_brands || 0)} · ${escapeHtmlForPopup(formatSyncTimestamp(item.created_at))}</span>
                        </div>
                        <div class="product-badges"><span class="badge">${Math.max(1, Math.round(Number(item.size_bytes || 0) / 1024))} KB</span></div>
                    </div>`).join('')
                : '<div class="hint">لا توجد نسخ احتياطية بعد.</div>';

            const select = byId('emergencyRestoreFile');
            if (select) {
                const previous = select.value;
                select.innerHTML = backups.map(item =>
                    `<option value="${escapeHtmlForPopup(item.name)}">${escapeHtmlForPopup(item.name)} — ${Number(item.server_products || 0)} منتج سيرفر</option>`
                ).join('');
                if (previous) select.value = previous;
            }
        }

        const restore = data.restore || {};
        if (restore.running) {
            startEmergencyRestorePolling();
            renderEmergencyRestoreProgress(restore);
        } else if (byId('emergencyRestoreStatus')) {
            renderEmergencyRestoreProgress(restore);
        }
    } catch (_) {
        // Arabic: الخادم المحلي غير متاح — بقية اللوحة تعرض الحالة العامة أصلاً.
        // English: The local backend is unavailable — the rest of the popup already reports that.
    }
}

// Arabic: عرض تقدّم إعادة الرفع (رفع/مكرر/فشل/متخطّى) مع سبب آخر خطأ. English: Render the re-upload progress (pushed/duplicate/failed/skipped) with the last error.
function renderEmergencyRestoreProgress(restore) {
    const box = byId('emergencyRestoreStatus');
    if (!box || !restore || (!restore.started_at && !restore.running)) return;
    const parts = [
        `رفع: <strong>${Number(restore.pushed || 0)}</strong>`,
        `مكرر: ${Number(restore.duplicates || 0)}`,
        `فشل: ${Number(restore.failed || 0)}`,
        `متخطّى: ${Number(restore.skipped || 0)}`,
        `من أصل: ${Number(restore.total || 0)}`,
        `براندات: ${Number(restore.brands_restored || 0)}`,
    ];
    const finished = !restore.running && restore.finished_at;
    box.className = `result-box ${restore.last_error && restore.failed ? 'warning' : (finished ? 'success' : '')}`;
    box.innerHTML =
        (restore.running ? 'إعادة الرفع جارية… ' : 'إعادة الرفع: ') + parts.join(' · ')
        + (restore.last_error ? `<br>ملاحظة: ${escapeHtmlForPopup(restore.last_error)}` : '');
}

// Arabic: متابعة تقدّم إعادة الرفع كل 3 ثوانٍ ما دامت تعمل. English: Poll the re-upload progress every 3 seconds while it runs.
function startEmergencyRestorePolling() {
    if (emergencyRestoreTimer) return;
    emergencyRestoreTimer = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/sync/emergency/restore/status`, { cache: 'no-store' });
            const data = await response.json();
            if (data && data.success) renderEmergencyRestoreProgress(data);
            if (data && !data.running) {
                clearInterval(emergencyRestoreTimer);
                emergencyRestoreTimer = null;
                await refreshSyncStatus();
                await refreshEmergencyStatus();
            }
        } catch (_) {
            clearInterval(emergencyRestoreTimer);
            emergencyRestoreTimer = null;
        }
    }, 3000);
}

// Arabic: الخطوة ١ - نسخة احتياطية كاملة الآن (أرشيف الجهاز + كل منتجات السيرفر + البراندات)،
//         ثم فتح رابط التنزيل ليحفظها المستخدم على جهازه. English: Step 1 - a full backup now (this machine's archive + every server product + brands), then open the download link so the operator keeps a copy on their machine.
async function createEmergencyBackup() {
    const button = byId('emergencyBackupBtn');
    const box = byId('emergencyBackupResult');
    if (button) { button.disabled = true; button.textContent = 'جارٍ جمع البيانات...'; }
    if (box) { box.className = 'result-box'; box.textContent = 'جارٍ سحب بيانات السيرفر وكتابة الملف...'; }
    try {
        const response = await fetch(`${API_BASE}/api/sync/emergency/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Actor: byId('AddedByName')?.value || '' }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر إنشاء النسخة الاحتياطية.');
        const backup = data.backup || {};
        emergencyBackupReady = true;
        updateEmergencyShutdownState();
        if (box) {
            box.className = backup.server_reachable ? 'result-box success' : 'result-box warning';
            box.innerHTML =
                `تم إنشاء النسخة الاحتياطية: <strong>${escapeHtmlForPopup(backup.name)}</strong><br>`
                + `أرشيف هذا الجهاز: ${Number(backup.local_products || 0)} منتج · `
                + `سيرفر: ${Number(backup.server_products || 0)} منتج و${Number(backup.server_brands || 0)} براند<br>`
                + `<a href="${API_BASE}${backup.download_url}" target="_blank">تنزيل الملف إلى جهازك</a>`
                + (backup.server_reachable ? '' :
                    `<br>تنبيه: لم تُقرأ بيانات السيرفر (${escapeHtmlForPopup(backup.server_error || '')}) — والمسح لن يُنفَّذ بهذه الحالة.`)
                + (backup.members_note ? `<br>ملاحظة: ${escapeHtmlForPopup(backup.members_note)}` : '');
        }
        // Arabic: نفتح رابط التنزيل في تبويب (الباك اند يرسله كمرفق) حتى يحفظ الأدمن الملف خارج الجهاز.
        // English: Open the download link in a tab (the backend sends it as an attachment) so the
        //          admin keeps a copy of the file outside this machine.
        const downloadUrl = `${API_BASE}${backup.download_url}`;
        try {
            chrome.tabs.create({ url: downloadUrl });
        } catch (_) {
            window.open(downloadUrl, '_blank');
        }
        await refreshEmergencyStatus();
    } catch (error) {
        if (box) { box.className = 'result-box error'; box.textContent = error.message; }
    } finally {
        if (button) { button.disabled = false; button.textContent = 'تنزيل نسخة احتياطية كاملة الآن'; }
    }
}

// Arabic: زر المسح لا يُفعَّل إلا بعد نسخة احتياطية ناجحة في هذه الجلسة. English: The erase button unlocks only after a successful backup in this session.
function updateEmergencyShutdownState() {
    const button = byId('emergencyShutdownBtn');
    if (!button) return;
    if (!emergencyBackupReady) {
        button.disabled = true;
        button.textContent = 'خذ نسخة احتياطية كاملة أولاً (الخطوة ١)';
        return;
    }
    button.disabled = false;
    button.textContent = 'تنفيذ: مسح السيرفر + إيقاف المزامنة';
}

// Arabic: الخطوة ٢ - التنفيذ النهائي بعد تأكيدين: كتابة العبارة، ثم نافذة تأكيد صريحة. English: Step 2 - the final run behind two confirmations: the typed phrase, then an explicit dialog.
async function runEmergencyShutdown() {
    const button = byId('emergencyShutdownBtn');
    const box = byId('emergencyShutdownResult');
    const confirmText = String(byId('emergencyConfirmInput')?.value || '').trim();
    const eraseServer = Boolean(byId('emergencyEraseServer')?.checked);
    const guardPassword = String(byId('emergencyGuardPassword')?.value || '');

    if (confirmText !== 'DELETE-SERVER') {
        if (box) { box.className = 'result-box error'; box.textContent = 'اكتب DELETE-SERVER حرفياً للتأكيد.'; }
        return;
    }
    const dialog = eraseServer
        ? 'سيتم الآن مسح بيانات السيرفر (منتجات وأعضاء وبراندات)، وإيقاف المزامنة نهائياً على هذا الجهاز.\nاكتب موافق للمتابعة.'
        : 'سيتم إيقاف المزامنة نهائياً على هذا الجهاز بدون مسح بيانات السيرفر.\nاكتب موافق للمتابعة.';
    if (String(prompt(dialog) || '').trim() !== 'موافق') {
        if (box) { box.className = 'result-box warning'; box.textContent = 'تم إلغاء العملية.'; }
        return;
    }

    if (button) { button.disabled = true; button.textContent = 'جارٍ التنفيذ...'; }
    if (box) { box.className = 'result-box'; box.textContent = 'جارٍ النسخة الاحتياطية ثم التنفيذ...'; }
    try {
        const response = await fetch(`${API_BASE}/api/sync/emergency/shutdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Confirm: confirmText,
                EraseServer: eraseServer,
                LocalGuardPassword: guardPassword,
                Actor: byId('AddedByName')?.value || '',
            }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تنفيذ العملية.');
        const deleted = data.server_erase?.deleted || {};
        const deletedText = Object.entries(deleted).map(([table, count]) => `${table}: ${count}`).join(' · ');
        if (box) {
            box.className = 'result-box success';
            box.innerHTML =
                '<strong>تم التنفيذ بالترتيب المطلوب.</strong><br>'
                + `١) نسخة احتياطية: ${escapeHtmlForPopup(data.backup?.name || '—')}<br>`
                + (data.server_erase
                    ? `٢) مسح السيرفر: ${Number(data.server_erase.total_deleted || 0)} صف — ${escapeHtmlForPopup(deletedText || 'لا جداول')}<br>`
                    : '٢) مسح السيرفر: لم يُطلب (تخطّي)<br>')
                + '٣) المزامنة موقوفة نهائياً على هذا الجهاز، وتم مسح رابط السيرفر والمفتاح السري.';
        }
        emergencyBackupReady = false;
        updateEmergencyShutdownState();
        if (byId('emergencyConfirmInput')) byId('emergencyConfirmInput').value = '';
        await refreshSyncStatus();
        await refreshEmergencyStatus();
    } catch (error) {
        if (box) { box.className = 'result-box error'; box.textContent = error.message; }
        emergencyBackupReady = true;
        updateEmergencyShutdownState();
    }
}

// Arabic: الخطوة ٣ - إعادة الرفع إلى سيرفر جديد (البراندات ثم المنتجات ثم عدّاد المعرّفات). English: Step 3 - the re-upload to a new server (brands, then products, then the ID counter).
async function startEmergencyRestore() {
    const button = byId('emergencyRestoreStartBtn');
    const box = byId('emergencyRestoreStatus');
    const payload = {
        BackupFile: byId('emergencyRestoreFile')?.value || '',
        ServerUrl: String(byId('emergencyRestoreUrl')?.value || '').trim(),
        Token: String(byId('emergencyRestoreToken')?.value || '').trim(),
        LocalGuardPassword: String(byId('emergencyRestoreGuard')?.value || ''),
        Confirm: String(byId('emergencyRestoreConfirm')?.value || '').trim(),
    };
    if (!payload.BackupFile) {
        if (box) { box.className = 'result-box error'; box.textContent = 'اختر ملف نسخة احتياطية أولاً.'; }
        return;
    }
    if (button) { button.disabled = true; button.textContent = 'جارٍ التحقق والبدء...'; }
    if (box) { box.className = 'result-box'; box.textContent = 'جارٍ فحص الاتصال بالسيرفر الجديد...'; }
    try {
        const response = await fetch(`${API_BASE}/api/sync/emergency/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر بدء إعادة الرفع.');
        if (byId('emergencyRestoreToken')) byId('emergencyRestoreToken').value = '';
        if (byId('emergencyRestoreConfirm')) byId('emergencyRestoreConfirm').value = '';
        renderEmergencyRestoreProgress(data.restore || {});
        startEmergencyRestorePolling();
        await refreshSyncStatus();
        await refreshEmergencyStatus();
    } catch (error) {
        if (box) { box.className = 'result-box error'; box.textContent = error.message; }
    } finally {
        if (button) { button.disabled = false; button.textContent = 'استعادة النسخة إلى السيرفر'; }
    }
}

// Arabic: ترجمة حالة المنتج المخزَّنة بالأرشيف إلى نص ولون مفهومين للمستخدم. هذه الحالة يكتبها
//         admin_autofill.js فعلياً عند الإرسال (submit_started ثم submitted أو submit_failed)،
//         وكانت تُرسل من الباك اند في /api/archive/recent لكن اللوحة ما كانت تعرضها — فالمستخدم
//         يسأل "المنتج انضاف ولا لا" ولا يجد جواباً على الشاشة.
// English: Translate the archive's stored workflow status into a clear label and colour. The
//          extension's admin_autofill.js writes this status for real (submit_started, then
//          submitted or submit_failed); the backend already returned it in /api/archive/recent
//          but the popup never rendered it - so "was this product added?" had no answer on screen.
const WORKFLOW_STATUS_LABELS = {
    submitted: { text: '✓ تمت الإضافة', className: 'status-submitted' },
    submit_started: { text: '⏳ جارٍ الإرسال', className: 'status-progress' },
    submit_failed: { text: '✗ فشل الإرسال', className: 'status-failed' },
    prepared: { text: 'مجهّز — لم يُضف', className: 'status-prepared' },
};

function describeWorkflowStatus(status) {
    const key = String(status || '').trim().toLowerCase();
    return WORKFLOW_STATUS_LABELS[key] || { text: 'مجهّز — لم يُضف', className: 'status-prepared' };
}

// Arabic: شاشة التشخيص الرئيسية: كل منتج مع نتيجته (انضاف للمتجر؟) ومن أضافه ومتى، مع ملخص
//         لكل الأرشيف وترتيب المتعاونين — تجيب مباشرة عن سؤال "تم إضافة المنتج أو لا".
// English: The main diagnostics view: each product with its outcome (added to the store?),
//          who added it and when, plus a whole-archive summary and the operator ranking -
//          answering "was the product added or not?" directly.
async function refreshRecentProducts() {
    const box = byId('recentProductsBox');
    const summaryBox = byId('recentProductsSummary');
    if (!box) return;
    box.textContent = 'جارِ التحميل...';

    try {
        const response = await fetch(`${API_BASE}/api/archive/recent?limit=40`, { cache: 'no-store' });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر تحميل القائمة.');
        }

        if (summaryBox) {
            const summary = data.summary || {};
            summaryBox.className = 'result-box';
            let summaryHtml = `<strong>${Number(summary.total || 0)}</strong> منتج بالأرشيف`
                + ` — ✓ تمت الإضافة: <strong>${Number(summary.submitted || 0)}</strong>`
                + ` — ⏳ جارٍ الإرسال: <strong>${Number(summary.in_progress || 0)}</strong>`
                + ` — ✗ فشل: <strong>${Number(summary.failed || 0)}</strong>`
                + ` — مجهّز فقط: <strong>${Number(summary.prepared || 0)}</strong>`;
            const operators = (data.operators || []).filter(operator => operator.name && operator.name !== 'غير محدد');
            if (operators.length) {
                summaryHtml += `<br>حسب المتعاون: ${operators.map(operator =>
                    `${escapeHtmlForPopup(operator.name)} <strong>${Number(operator.count || 0)}</strong>`
                ).join(' — ')}`;
            }
            summaryBox.innerHTML = summaryHtml;
        }

        if (!data.products.length) {
            box.textContent = 'لا توجد منتجات بعد.';
            return;
        }

        box.innerHTML = data.products.map(product => {
            const status = describeWorkflowStatus(product.workflow_status);
            const when = product.workflow_updated_at || product.created_at || product.date || '';
            const meta = [
                product.brand_name || '',
                `أضافه: ${product.added_by || 'غير محدد'}`,
                when ? formatSyncTimestamp(when) : '',
            ].filter(Boolean).join(' • ');
            const failure = product.workflow_status === 'submit_failed' && product.failure_reason
                ? `<span class="product-failure">${escapeHtmlForPopup(product.failure_reason)}</span>`
                : '';
            return `
            <div class="store-card">
                <div>
                    <strong>#${product.id} — ${escapeHtmlForPopup(product.name_en || '')}</strong>
                    <span>${escapeHtmlForPopup(meta)}</span>
                    ${failure}
                </div>
                <div class="product-badges">
                    <span class="badge ${status.className}">${status.text}</span>
                    <span class="badge">${product.id_source === 'local_fallback' ? 'محلي' : 'مركزي'}</span>
                </div>
            </div>
        `;
        }).join('');
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
    // Arabic: منطقة خطر الأدمن (نسخة احتياطية ← مسح السيرفر ← قفل المزامنة، ثم إعادة الرفع).
    // English: The admin danger zone (backup -> erase the server -> lock sync, then the re-upload).
    bindClick('emergencyBackupBtn', createEmergencyBackup);
    bindClick('emergencyShutdownBtn', runEmergencyShutdown);
    bindClick('emergencyRestoreStartBtn', startEmergencyRestore);
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

    // Arabic: اكتشاف منفذ الباك اند قبل أي نداء - لو كان 5000 مشغولاً فالباك اند على 5001
    //         وكل ما بعده سيفشل بلا هذا السطر.
    // English: Discover the backend port before any call - if 5000 was busy the backend is on
    //          5001 and everything below fails without this.
    try {
        const base = await globalThis.ALPHACODE_BACKEND?.getBackendBase();
        if (base) API_BASE = base;
    } catch (_) { /* keep the configured port */ }

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