// =========================================================
// AlphaCode Extractor v4 - Popup Controller
// Arabic: إدارة الإعدادات، المورد، طلب المنتجات، البيانات، والتشخيص.
// English: Manages settings, supplier workflows, product requests, data, and diagnostics.
// =========================================================

'use strict';

const API_BASE = 'http://127.0.0.1:5000';
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
    'AIAutoGenerate',
    'AutoAddProduct',
    'DownloadSelectedImagesOnly',
    'UploadMainImageOnly',
    'AIJsonRepairEnabled',
    'OfficialResearchOnRegenerate',
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

    try {
        JSON.parse(config.BrandMapJson || '{}');
    } catch (_) {
        throw new Error('خريطة البراندات ليست JSON صالحاً.');
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

// Arabic: تحديد مزود الذكاء الاصطناعي الظاهر في شريط الحالة.
// English: Render the configured AI provider in the status bar.
function formatAiProvider(data) {
    const provider = String(data.ai_provider || currentConfig.AIProvider || 'groq').toUpperCase();
    const model = data.default_ai_model || currentConfig.AIModel || '';
    return data.ai_configured
        ? `${provider} جاهز — ${model}`
        : `${provider} يحتاج مفتاح API`;
}

// Arabic: إظهار/إخفاء بانر إعداد المجلد أعلى اللوحة.
// English: Show/hide the folder-setup banner at the top of the popup.
function setFolderBannerVisible(visible) {
    const banner = byId('folderSetupBanner');
    if (banner) banner.style.display = visible ? 'block' : 'none';
}

// Arabic: فحص Flask ومزود الذكاء الاصطناعي.
// English: Check Flask and AI-provider readiness.
async function checkServer() {
    const dot = byId('serverDot');
    const serverText = byId('serverText');
    const aiText = byId('aiText');

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
        if (aiText) aiText.textContent = formatAiProvider(data);
        setFolderBannerVisible(Boolean(data.needs_folder_setup));
    } catch (_) {
        if (dot) dot.className = 'status-dot bad';
        if (serverText) serverText.textContent = 'خادم Python غير متصل';
        if (aiText) aiText.textContent = 'مزود الذكاء الاصطناعي غير متاح';
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

    showStatus('تم حفظ إعدادات AlphaCode v5.0.0 وتطبيقها.', 'success');
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
    const clearAiCache = Boolean(byId('ClearAiCache')?.checked);
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
                clear_ai_cache: clearAiCache,
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

// =========================================================
// Arabic: مجلد الحفظ - عرض الحالة واختيار مجلد جديد.
// English: Save folder - status display and choosing a new folder.
// =========================================================
async function refreshFolderStatus() {
    const box = byId('folderStatusBox');
    if (box) {
        box.className = 'result-box';
        box.textContent = 'جارِ التحقق...';
    }

    try {
        const response = await fetch(`${API_BASE}/api/paths/status`, { cache: 'no-store' });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'تعذر قراءة حالة المجلد.');
        }

        if (box) {
            if (data.configured) {
                box.className = 'result-box success';
                box.textContent = `المجلد الحالي: ${data.root_dir}`;
            } else {
                box.className = 'result-box warning';
                box.textContent = 'لم يتم اختيار مجلد حفظ بعد. اضغط الزر أدناه لاختيار مجلد.';
            }
        }

        setFolderBannerVisible(!data.configured);
    } catch (error) {
        if (box) {
            box.className = 'result-box error';
            box.textContent = error.message;
        }
    }
}

// Arabic: يفتح نافذة اختيار مجلد أصلية على جهاز المستخدم عبر خادم Python.
// English: Opens a native folder picker on the user's machine via the Python server.
async function chooseFolder() {
    const box = byId('folderStatusBox');
    if (box) {
        box.className = 'result-box';
        box.textContent = 'افتح نافذة اختيار المجلد على سطح المكتب (قد تكون خلف نافذة المتصفح)...';
    }

    const response = await fetch(`${API_BASE}/api/paths/choose-folder`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok || !data.success) {
        if (data.cancelled) {
            if (box) {
                box.className = 'result-box warning';
                box.textContent = 'تم إلغاء اختيار المجلد.';
            }
            return;
        }
        throw new Error(data.error || 'تعذر اختيار المجلد.');
    }

    if (box) {
        box.className = 'result-box success';
        box.textContent = `تم ضبط مجلد الحفظ: ${data.root_dir}`;
    }
    setFolderBannerVisible(false);
    showStatus('تم ضبط مجلد الحفظ بنجاح.', 'success');
    await refreshArchiveStats();
}

// =========================================================
// Arabic: المزامنة بين مستخدمين.
// English: Two-user sync.
// =========================================================
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
                ? `مفتاح محفوظ (${data.TokenPreview}) — اتركه فارغاً للإبقاء عليه`
                : 'أدخل المفتاح السري من sync.php';
        }
    } catch (_) {
        // Arabic: عدم توفر الخادم عند فتح اللوحة لا يجب أن يمنع بقية الوظائف.
        // English: The server being unavailable when the popup opens should not block the rest of the UI.
    }
}

async function saveSyncSettings() {
    const resultBox = byId('syncSettingsResult');
    const payload = {
        Enabled: Boolean(byId('SyncEnabled')?.checked),
        ServerUrl: (byId('SyncServerUrl')?.value || '').trim(),
        Token: (byId('SyncToken')?.value || '').trim(),
        AddedByName: (byId('AddedByName')?.value || '').trim(),
    };

    try {
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
    } catch (error) {
        if (resultBox) {
            resultBox.className = 'result-box error';
            resultBox.textContent = error.message;
        }
    }
}

function formatSyncTimestamp(value) {
    if (!value) return '—';
    try {
        return new Date(value).toLocaleString('ar-SA', { hour12: false });
    } catch (_) {
        return value;
    }
}

async function refreshSyncStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/sync/status`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر قراءة حالة المزامنة.');

        if (byId('syncPendingCount')) byId('syncPendingCount').textContent = data.pending_queue;
        if (byId('syncLastPull')) byId('syncLastPull').textContent = formatSyncTimestamp(data.last_pull_at);
        if (byId('syncLastPush')) byId('syncLastPush').textContent = formatSyncTimestamp(data.last_push_at);

        const statusBox = byId('syncStatusResult');
        if (statusBox) {
            if (!data.enabled) {
                statusBox.className = 'result-box warning';
                statusBox.textContent = 'المزامنة معطّلة حالياً.';
            } else if (data.last_error) {
                statusBox.className = 'result-box error';
                statusBox.textContent = `آخر خطأ: ${data.last_error}`;
            } else {
                statusBox.className = 'result-box success';
                statusBox.textContent = 'المزامنة تعمل بشكل طبيعي.';
            }
        }
    } catch (error) {
        const statusBox = byId('syncStatusResult');
        if (statusBox) {
            statusBox.className = 'result-box error';
            statusBox.textContent = error.message;
        }
    }
}

async function triggerSyncNow() {
    const statusBox = byId('syncStatusResult');
    const response = await fetch(`${API_BASE}/api/sync/now`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر تشغيل المزامنة الآن.');
    }

    if (statusBox) {
        statusBox.className = 'result-box success';
        statusBox.textContent = 'تمت المزامنة الآن.';
    }
    await refreshSyncStatus();
    await refreshRecentProducts();
}

// Arabic: شاشة تشخيص صغيرة - آخر المنتجات المضافة من الطرفين مع اسم من أضافها.
// English: A small diagnostics view - the latest products added by either side, with who added them.
async function refreshRecentProducts() {
    const box = byId('recentProductsBox');
    if (box) box.textContent = 'جارِ التحميل...';

    try {
        const response = await fetch(`${API_BASE}/api/archive/recent?limit=15`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحميل القائمة.');

        if (!box) return;
        if (!data.products.length) {
            box.textContent = 'لا توجد منتجات مضافة بعد.';
            return;
        }

        box.innerHTML = '';
        for (const product of data.products) {
            const row = document.createElement('div');
            row.className = 'store-card';
            row.innerHTML = `
                <div>
                    <strong>#${product.id} — ${product.name_en || 'بدون اسم'}</strong>
                    <span>${product.brand_name || ''} · بواسطة ${product.added_by || 'غير محدد'}${product.id_source === 'local_fallback' ? ' · ID محلي (بدون اتصال)' : ''}</span>
                </div>
                <span class="badge">${product.workflow_status || ''}</span>
            `;
            box.appendChild(row);
        }
    } catch (error) {
        if (box) box.textContent = error.message;
    }
}

// Arabic: عرض آخر أسطر السجل الخارجي.
// English: Display recent external-log lines.
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
            logBox.textContent = (data.lines || []).join('\n') || 'لا توجد أحداث مسجلة حتى الآن.';
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
async function generateReport() {
    const resultBox = byId('reportResult');
    const scope = byId('reportScope')?.value || 'daily';
    const date = byId('reportDate')?.value || '';

    const response = await fetch(`${API_BASE}/api/reports/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, date }),
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(data.error || 'تعذر توليد التقرير.');
    }

    if (resultBox) {
        resultBox.className = 'result-box success';
        resultBox.innerHTML = `تم التوليد: <a href="${data.download_url}" target="_blank">${data.filename}</a>`;
    }
    chrome.tabs.create({ url: data.download_url });
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

// Arabic: تحديث القيم المقترحة عند تبديل مزود الذكاء الاصطناعي دون حفظ المفتاح داخل Chrome.
// English: Suggest provider-specific model and key environment values without storing secrets in Chrome.
function handleAiProviderChange() {
    const provider = String(byId('AIProvider')?.value || 'groq').toLowerCase();
    const model = byId('AIModel');
    const baseUrl = byId('AIBaseUrl');
    const keyEnv = byId('AIKeyEnv');

    if (provider === 'openai') {
        if (!model?.value || /gpt-oss/i.test(model.value)) model.value = 'gpt-5.2';
        if (baseUrl) baseUrl.value = '';
        if (keyEnv && (!keyEnv.value || keyEnv.value === 'GROQ_API_KEY')) {
            keyEnv.value = 'OPENAI_API_KEY';
        }
        showStatus('مزود OpenAI يستخدم OPENAI_API_KEY عبر خادم Python، وليس جلسة ChatGPT في المتصفح.', 'success', 5500);
        return;
    }

    if (provider === 'groq') {
        if (!model?.value || !/gpt-oss/i.test(model.value)) model.value = 'openai/gpt-oss-120b';
        if (baseUrl) baseUrl.value = '';
        if (keyEnv && (!keyEnv.value || keyEnv.value === 'OPENAI_API_KEY')) {
            keyEnv.value = 'GROQ_API_KEY';
        }
        return;
    }

    if (provider === 'custom') {
        showStatus('أدخل رابط OpenAI-compatible واسم النموذج ومتغير البيئة الذي يحمل المفتاح.', 'warning', 5500);
    }
}

// Arabic: تهيئة جميع أحداث لوحة v4.
// English: Initialize all v4 popup events.
async function initializePopup() {
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => activateTab(button.dataset.tab));
    });

    bindClick('saveBtn', saveConfiguration);
    bindClick('searchArchiveBtn', searchArchive);
    bindClick('prepareArchiveBtn', prepareArchivedProduct);
    bindClick('requestSupplierProductBtn', requestProductFromSupplier);
    bindClick('openStoreBtn', openSupplierAtLastProduct);
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
    bindClick('loginBtnCheck', handleLoginOverlay);
    bindClick('logoutBtn', handleLogout);
    bindClick('copyBatchNamesBtn', copyAdminBatchNames);

    byId('AIProvider')?.addEventListener('change', handleAiProviderChange);

    try {
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