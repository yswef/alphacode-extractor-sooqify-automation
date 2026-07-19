// =========================================================
// AlphaCode Extractor - Popup Controller 3.2
// Arabic: يدير الإعدادات والمتاجر والبحث وحذف البيانات والتشخيص.
// English: Controls settings, store profiles, search, data deletion, and diagnostics.
// =========================================================

'use strict';

const API_BASE = 'http://127.0.0.1:5000';
const DEFAULTS = globalThis.ALPHACODE_DEFAULT_CONFIG || {};
const NUMBER_FIELDS = new Set([
    'CategoryId', 'SubCategoryId', 'UnitId', 'Stock', 'ExchangeRate', 'AddedFeeYuan',
    'Discount', 'StoreId', 'ModuleId', 'BrandId', 'SizeAttributeId', 'SizeChoiceNo',
    'ImageMaxDimension', 'ImageQuality', 'MaxImages', 'AutoSubmitDelaySeconds'
]);
const BOOLEAN_FIELDS = new Set([
    'OptimizeImageAtSource', 'RequireAllImages', 'AIAutoGenerate', 'AutoAddProduct'
]);
const CONFIG_FIELDS = Object.keys(DEFAULTS);
let currentConfig = { ...DEFAULTS };

// Arabic: تفعيل تبويب وإخفاء بقية التبويبات.
// English: Activate one tab and hide the others.
function activateTab(tabName) {
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.toggle('active', button.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
    if (tabName === 'data') refreshArchiveStats();
    if (tabName === 'diagnostics') refreshLogs();
}

// Arabic: تعبئة عناصر النموذج من الإعدادات.
// English: Populate form controls from configuration.
function populateForm(config) {
    for (const key of CONFIG_FIELDS) {
        const element = document.getElementById(key);
        if (!element) continue;
        if (BOOLEAN_FIELDS.has(key)) element.checked = Boolean(config[key]);
        else element.value = config[key] ?? '';
    }
    document.getElementById('profileChip').textContent = config.StoreProfileName || 'Sooqify Online';
    document.getElementById('storeCardName').textContent = config.StoreProfileName || 'Sooqify Online';
    document.getElementById('supplierCardName').textContent = config.SupplierStoreName || 'BRANDKINGDOM';
}

// Arabic: قراءة الحقول مع المحافظة على القيم غير الظاهرة.
// English: Read visible controls while preserving non-rendered settings.
function readForm() {
    const config = { ...currentConfig };
    for (const key of CONFIG_FIELDS) {
        const element = document.getElementById(key);
        if (!element) continue;
        if (BOOLEAN_FIELDS.has(key)) config[key] = element.checked;
        else if (NUMBER_FIELDS.has(key)) config[key] = Number(element.value);
        else config[key] = element.value.trim();
    }
    try { JSON.parse(config.BrandMapJson || '{}'); }
    catch (_) { throw new Error('خريطة البراندات ليست JSON صالحاً.'); }
    return { ...DEFAULTS, ...config };
}

// Arabic: عرض رسالة حالة مؤقتة.
// English: Display a temporary status message.
function showStatus(message, type) {
    const status = document.getElementById('status');
    status.className = type;
    status.textContent = message;
    status.style.display = 'block';
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => { status.style.display = 'none'; }, 4200);
}

// Arabic: ترحيل الإعداد القديم الذي خلط اسم المورد باسم المتجر المستهدف.
// English: Migrate the old configuration that confused supplier and target-store names.
function migrateLegacyConfig(config) {
    const migrated = { ...config };
    if (migrated.StoreProfileName === 'BRANDKINGDOM') migrated.StoreProfileName = 'Sooqify Online';
    if (!migrated.SupplierStoreName) migrated.SupplierStoreName = 'BRANDKINGDOM';
    return migrated;
}

// Arabic: تحميل الإعدادات المحفوظة وتطبيق الترحيل.
// English: Load saved settings and apply configuration migration.
async function loadSavedConfig() {
    const stored = await chrome.storage.local.get(['extractorConfig']);
    currentConfig = migrateLegacyConfig({ ...DEFAULTS, ...(stored.extractorConfig || {}) });
    populateForm(currentConfig);
    await chrome.storage.local.set({ extractorConfig: currentConfig });
}

// Arabic: فحص Flask وحالة Groq.
// English: Check Flask connectivity and Groq readiness.
async function checkServer() {
    const dot = document.getElementById('serverDot');
    const serverText = document.getElementById('serverText');
    const aiText = document.getElementById('aiText');
    try {
        const response = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error('Server error');
        dot.className = 'status-dot ok';
        serverText.textContent = `Python ${data.version || ''} متصل`;
        aiText.textContent = data.ai_configured ? `Groq جاهز — ${data.default_ai_model}` : 'Groq يحتاج API Key';
    } catch (_) {
        dot.className = 'status-dot bad';
        serverText.textContent = 'خادم Python غير متصل';
        aiText.textContent = 'Groq غير متاح';
    }
}

// Arabic: حفظ الإعدادات وإرسالها للصفحات المفتوحة.
// English: Save settings and broadcast them to open pages.
async function saveConfiguration() {
    currentConfig = migrateLegacyConfig(readForm());
    await chrome.storage.local.set({ extractorConfig: currentConfig });
    populateForm(currentConfig);

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id) continue;
        if (tab.url?.includes('szwego.com') || tab.url?.includes(currentConfig.StoreDomain)) {
            try { await chrome.tabs.sendMessage(tab.id, { action: 'UPDATE_CONFIG', config: currentConfig }); }
            catch (_) {}
        }
    }
    showStatus('تم حفظ الإعدادات بنجاح.', 'success');
    await checkServer();
}

// Arabic: البحث عن منتج بواسطة ID المحلي.
// English: Search an archived product by local ID.
async function searchArchive() {
    const id = Number(document.getElementById('ArchiveProductId').value);
    const resultBox = document.getElementById('searchResult');
    if (!id) {
        resultBox.className = 'result-box error';
        resultBox.textContent = 'أدخل ID صحيحاً.';
        return null;
    }
    try {
        const response = await fetch(`${API_BASE}/api/archive/product/${id}`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Not found');
        const product = data.product;
        resultBox.className = 'result-box success';
        resultBox.textContent = [
            `المنتج: ${product.name_en || product.name || '-'}`,
            `البراند: ${product.brand_name || '-'}`,
            `متجر المورد: ${product.supplier_store_name || '-'}`,
            `Supplier Store ID: ${product.supplier_store_id || '-'}`,
            `Search Code: ${product.search_code || '-'}`,
            `Style Code: ${product.style_code || '-'}`,
            `الحالة: ${product.workflow_status || 'prepared'}`,
            `الصور: ${(product.images || []).length}`,
            `المقاسات: ${(product.sizes || []).join(', ') || '-'}`
        ].join('\n');
        return product;
    } catch (error) {
        resultBox.className = 'result-box error';
        resultBox.textContent = error.message;
        return null;
    }
}

// Arabic: إعادة تجهيز منتج محفوظ وفتح صفحة المتجر.
// English: Re-prepare an archived product and open the target store page.
async function prepareArchivedProduct() {
    const id = Number(document.getElementById('ArchiveProductId').value);
    if (!id) return showStatus('أدخل ID المنتج أولاً.', 'error');
    try {
        const response = await fetch(`${API_BASE}/api/pending/${id}`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تجهيز المنتج.');
        await chrome.storage.local.set({ pendingSooqifyProduct: data.pending_product, lastAlphaCodeProductId: id });
        await chrome.tabs.create({ url: currentConfig.SooqifyAddUrl });
        showStatus(`تم تجهيز المنتج ${id} وفتح المتجر.`, 'success');
    } catch (error) {
        showStatus(error.message, 'error');
    }
}

// Arabic: فتح صفحة إضافة المنتج للمتجر المستهدف.
// English: Open the target store's product-add page.
async function openStorePage() {
    currentConfig = migrateLegacyConfig(readForm());
    await chrome.tabs.create({ url: currentConfig.SooqifyAddUrl });
}

// Arabic: قراءة إحصاءات الأرشيف.
// English: Load archive statistics.
async function refreshArchiveStats() {
    try {
        const response = await fetch(`${API_BASE}/api/archive/stats`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر قراءة الإحصائيات.');
        document.getElementById('statsProducts').textContent = data.products;
        document.getElementById('statsImages').textContent = data.images;
        document.getElementById('statsLastId').textContent = data.last_id;
    } catch (error) {
        document.getElementById('statsProducts').textContent = '!';
        document.getElementById('statsImages').textContent = '!';
        document.getElementById('statsLastId').textContent = '!';
        showStatus(error.message, 'error');
    }
}

// Arabic: حذف منتج من JSON وExcel مع خيار الصور.
// English: Delete one product from JSON and Excel with optional image removal.
async function deleteProductData() {
    const id = Number(document.getElementById('DeleteProductId').value);
    const deleteImages = document.getElementById('DeleteProductImages').checked;
    const resultBox = document.getElementById('deleteResult');
    if (!id) {
        resultBox.className = 'result-box error';
        resultBox.textContent = 'أدخل ID صحيحاً.';
        return;
    }
    if (!confirm(`سيتم حذف المنتج ${id} من JSON وExcel${deleteImages ? ' مع مجلد الصور' : ''}. هل أنت متأكد؟`)) return;

    try {
        const response = await fetch(`${API_BASE}/api/archive/product/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete_images: deleteImages })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر حذف المنتج.');
        const stored = await chrome.storage.local.get(['pendingSooqifyProduct']);
        if (stored.pendingSooqifyProduct?.local_id === id) {
            await chrome.storage.local.remove(['pendingSooqifyProduct', 'lastAlphaCodeProductId', 'lastAutoSubmitProductId']);
        }
        resultBox.className = 'result-box success';
        resultBox.textContent = `تم حذف المنتج ${id}.${data.images_deleted ? ' تم حذف مجلد الصور.' : ''}`;
        await refreshArchiveStats();
    } catch (error) {
        resultBox.className = 'result-box error';
        resultBox.textContent = error.message;
    }
}

// Arabic: مسح جميع المنتجات مع خيارات الصور وCache.
// English: Clear every product with optional image and AI-cache removal.
async function clearAllData() {
    const deleteImages = document.getElementById('ClearDeleteImages').checked;
    const clearAiCache = document.getElementById('ClearAiCache').checked;
    const resultBox = document.getElementById('clearResult');
    const confirmation = prompt('اكتب DELETE لتأكيد مسح جميع سجلات JSON وExcel:');
    if (confirmation !== 'DELETE') {
        resultBox.className = 'result-box warning';
        resultBox.textContent = 'تم إلغاء العملية.';
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/archive/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete_images: deleteImages, clear_ai_cache: clearAiCache })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'تعذر مسح البيانات.');
        await chrome.storage.local.remove([
            'pendingSooqifyProduct', 'lastAlphaCodeProductId', 'lastAutoSubmitProductId',
            'lastAutoFilledProductId', 'lastAutoFillAt', 'lastAutoSubmitAttemptAt'
        ]);
        resultBox.className = 'result-box success';
        resultBox.textContent = `تم حذف ${data.products_deleted} منتج و${data.folders_deleted} مجلد صور.`;
        await refreshArchiveStats();
    } catch (error) {
        resultBox.className = 'result-box error';
        resultBox.textContent = error.message;
    }
}

// Arabic: عرض آخر أسطر السجل الخارجي.
// English: Display recent external-log lines.
async function refreshLogs() {
    const logBox = document.getElementById('logBox');
    logBox.textContent = 'جاري تحميل السجل...';
    try {
        const response = await fetch(`${API_BASE}/api/logs/recent?lines=300`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not read logs');
        document.getElementById('logPath').textContent = data.log_path || '';
        logBox.textContent = (data.lines || []).join('\n') || 'لا توجد أحداث مسجلة حتى الآن.';
        logBox.scrollTop = logBox.scrollHeight;
    } catch (error) {
        logBox.textContent = `تعذر قراءة السجل: ${error.message}`;
    }
}

// Arabic: تنزيل ملف السجل الخارجي.
// English: Download the external log file.
async function downloadLogs() {
    await chrome.tabs.create({ url: `${API_BASE}/api/logs/download` });
}

// Arabic: مسح إحداثيات اللوحة المسحوبة.
// English: Clear dragged panel coordinates.
async function resetPanelPosition() {
    await chrome.storage.local.remove('adminPanelCoordinates');
    showStatus('تم مسح الموضع اليدوي. حدّث صفحة المتجر.', 'success');
}

// Arabic: تهيئة أحداث اللوحة.
// English: Initialize popup events.
async function initializePopup() {
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => activateTab(button.dataset.tab));
    });
    document.getElementById('saveBtn').addEventListener('click', () => saveConfiguration().catch(error => showStatus(error.message, 'error')));
    document.getElementById('searchArchiveBtn').addEventListener('click', searchArchive);
    document.getElementById('prepareArchiveBtn').addEventListener('click', prepareArchivedProduct);
    document.getElementById('openStoreBtn').addEventListener('click', openStorePage);
    document.getElementById('openStoreBtnInline').addEventListener('click', openStorePage);
    document.getElementById('refreshStatsBtn').addEventListener('click', refreshArchiveStats);
    document.getElementById('deleteProductBtn').addEventListener('click', deleteProductData);
    document.getElementById('clearAllBtn').addEventListener('click', clearAllData);
    document.getElementById('refreshLogsBtn').addEventListener('click', refreshLogs);
    document.getElementById('downloadLogsBtn').addEventListener('click', downloadLogs);
    document.getElementById('resetPanelPositionBtn').addEventListener('click', resetPanelPosition);

    try {
        await loadSavedConfig();
        await checkServer();
        await refreshArchiveStats();
    } catch (error) {
        showStatus(`تعذر تحميل الإعدادات: ${error.message}`, 'error');
    }
}

document.addEventListener('DOMContentLoaded', initializePopup);
