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
]);

const BOOLEAN_FIELDS = new Set([
    'OptimizeImageAtSource',
    'RequireAllImages',
    'AIAutoGenerate',
    'AutoAddProduct',
    'DownloadSelectedImagesOnly',
    'AIJsonRepairEnabled',
    'OfficialResearchOnRegenerate',
    'OpenSupplierAtLastProduct',
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
    } catch (_) {
        if (dot) dot.className = 'status-dot bad';
        if (serverText) serverText.textContent = 'خادم Python غير متصل';
        if (aiText) aiText.textContent = 'مزود الذكاء الاصطناعي غير متاح';
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
            } catch (_) {}
        }
    }

    showStatus('تم حفظ إعدادات AlphaCode v4 وتطبيقها.', 'success');
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
        if (!model?.value || !/gpt-oss/i.test(model.value)) model.value = 'openai/gpt-oss-20b';
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

    byId('AIProvider')?.addEventListener('change', handleAiProviderChange);

    try {
        await loadSavedConfig();
        await Promise.all([
            checkServer(),
            refreshArchiveStats(),
        ]);
    } catch (error) {
        showStatus(`تعذر تحميل الإعدادات: ${error.message}`, 'error', 7500);
    }
}

document.addEventListener('DOMContentLoaded', initializePopup);
