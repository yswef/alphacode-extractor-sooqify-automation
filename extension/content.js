// =========================================================
// AlphaCode Extractor Pro - Full Gallery, AI Copy, and Shared Settings
// =========================================================

'use strict';

const API_BASE_URL = `http://127.0.0.1:${(globalThis.ALPHACODE_DEFAULT_CONFIG || {}).BackendPort || 5000}`;
const PRODUCT_CARD_SELECTOR = [
    '[class*="normal_item_timeline_common_item"]',
    '[class*="goods-item"]',
    '[class*="goods_item"]',
    '[class*="weshop-item"]',
    '[class*="goods-card"]',
    '.feed-item'
].join(', ');

const DEFAULT_CONFIG = globalThis.ALPHACODE_DEFAULT_CONFIG || {
    CategoryId: 41, SubCategoryId: 42, UnitId: 1, Stock: 100,
    ExchangeRate: 0.5, AddedFeeYuan: 250, Discount: 0, DiscountType: 'percent',
    AvailableTimeStarts: '00:00:00', AvailableTimeEnds: '23:59:59', MaximumCartQuantity: '',
    StoreId: 3, ModuleId: 2, Status: 'active', Veg: 'no', Recommended: 'yes',
    BrandName: 'Air Jordan', BrandId: 6,
    SizeAttributeId: 1, SizeChoiceNo: 1, SizeactualChoiceNo: 1, SizeTitle: 'الحجم', DefaultLanguage: 'en',
    SooqifyAddUrl: 'https://admin.sooqifyonline.com/admin/item/add-new',
    StoreProfileName: 'Sooqify Online', StoreDomain: 'admin.sooqifyonline.com',
    SupplierStoreName: 'BRANDKINGDOM', SupplierStoreId: '',
    ImageMaxDimension: 1200, ImageQuality: 60, ImageFormat: 'jpeg',
    OptimizeImageAtSource: true, RequireAllImages: true, MaxImages: 30, StoreImageLimit: 6,
    UploadMainImageOnly: true,
    AutoAddProduct: false, AutoSubmitDelaySeconds: 0, FastAutofillMode: true,
    BatchModeEnabled: true, BatchPreparationConcurrency: 1, BatchMaximumProducts: 25,
    BatchContinueOnFailure: true, BatchNotifyEachProduct: true, BatchMaxRetries: 1,
    BatchDownloadSelectedImagesOnly: true, BatchReuseStoreTab: true,
    BatchSelectionPersistence: true, AdminPanelPosition: 'middle-left'
};

// Arabic: ملفات تعريف نوع المنتج - المصدر الوحيد لكل فروقات الأحذية/الساعات.
// English: Product type profiles - the single source for every shoes/watches difference.
const PRODUCT_TYPES = globalThis.ALPHACODE_PRODUCT_TYPES;
// Arabic: حل عملة المورد — szwego يعرض السعر بعملة مشتقة من الـIP (VPN)، فنستعيد اليوان
//         الحقيقي من سعر الصرف الذي ينشره الموقع نفسه. شوف supplier_currency.js.
// English: Supplier currency resolution — szwego displays the price in an IP-derived (VPN)
//          currency, so we recover the true CNY from the rate the site itself publishes.
//          See supplier_currency.js.
const SUPPLIER_CURRENCY = globalThis.ALPHACODE_SUPPLIER_CURRENCY;
// Arabic: المنظّم التكيفي لطلبات المورد - نعرض رسائله للمستخدم بدل فشل صامت أو خطأ مبهم.
// English: The adaptive supplier throttle - its messages are surfaced to the operator instead
//          of a silent failure or an opaque error.
const SUPPLIER_THROTTLE = globalThis.ALPHACODE_SUPPLIER_THROTTLE;

// Arabic: شريط تنبيه عائم يظهر عند رصد تقييد من خادم المورد ويختفي تلقائياً بعد التعافي.
// English: A floating notice shown when supplier-side limiting is detected; it clears itself
//          automatically once things recover.
let _throttleNoticeTimer = null;
function showThrottleNotice(message, tone = 'warn') {
    let notice = document.getElementById('alphacode-throttle-notice');
    if (!notice) {
        notice = document.createElement('div');
        notice.id = 'alphacode-throttle-notice';
        notice.className = 'alphacode-throttle-notice';
        document.body.appendChild(notice);
    }
    notice.dataset.tone = tone;
    notice.textContent = message;
    notice.style.display = 'block';
    clearTimeout(_throttleNoticeTimer);
    _throttleNoticeTimer = setTimeout(() => { notice.style.display = 'none'; }, 12000);
}

SUPPLIER_THROTTLE?.onEvent(event => {
    if (event.type === 'throttled' || event.type === 'waiting') {
        showThrottleNotice(event.message, 'warn');
        acLog('warn', `Supplier throttle: ${event.type} host=${event.host} delay=${event.delayMs}ms reason=${event.reason || '-'}`);
    }
});

let extractorConfig = { ...DEFAULT_CONFIG };
// Arabic: خريطة اسم→id مبنية مسبقاً (sync) من كاش chrome.storage المشترك مع popup.js
//         (alphacode_brands_cache)، أو من fetch احتياطي مباشر لـ/api/brands لو الكاش
//         فاضي. تُملأ مرة وحدة أثناء loadConfiguration() قبل ما أي زر استخراج يظهر،
//         عشان resolveBrandId() تبقى دالة sync بحتة (كل نداءاتها التسعة بالملف sync
//         فعلياً، وchrome.storage لا يوجد له قراءة sync إطلاقاً - القرار كان الإبقاء
//         على resolveBrandId sync واستخدام ذاكرة محلية متزامنة بدل تحويلها لasync).
// English: Pre-built (sync) name->id map from the chrome.storage cache shared with
//          popup.js (alphacode_brands_cache), or a direct fallback fetch to /api/brands
//          when the cache is empty. Filled once during loadConfiguration() before any
//          extraction button appears, so resolveBrandId() stays a pure sync function
//          (all nine of its call sites in this file are sync, and chrome.storage has no
//          sync read at all - the decision was to keep resolveBrandId sync and use an
//          in-memory cache instead of converting it to async).
let brandNameToIdMap = {};
const BRANDS_CACHE_STORAGE_KEY = 'alphacode_brands_cache';
let lastAddedSearchCodeGlobal = null;
let observerTimer = null;
let activeAutomaticResultOverlay = null;
const automaticSubmissionContexts = new Map();
const selectedBatchProducts = new Map();
let activeBatchReviewOverlay = null;
// Arabic: مسودات الدفعة المعروضة حالياً - يحتاجها حارس السعر ليعرف أي منتج لسا غير مؤكَّد.
// English: The batch drafts currently on screen - the price gate needs them to know which
//          product is still unconfirmed.
let activeBatchDrafts = [];
let latestBatchQueueState = null;

// Arabic: حفظ اختيارات الدفعة كبيانات مستقلة عن عناصر DOM التي يعيد SZWEGO تدويرها أثناء التمرير.
// English: Persist batch selections independently from DOM nodes recycled by SZWEGO virtualization.
const BATCH_SELECTION_SESSION_KEY = 'alphacodeBatchSelectionsV2';
const EMPTY_EXTERNAL_COPY_TEMPLATE = Object.freeze({
    name_en: '',
    description_en: '',
    name_ar: '',
    description_ar: '',
});

// Arabic: انتظار خفيف واختبار شرط لواجهات التحميل الديناميكي.
// English: Lightweight delay and condition polling for dynamic interfaces.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForCondition(check, timeoutMs = 10000, intervalMs = 200) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const result = check();
        if (result) return result;
        await sleep(intervalMs);
    }
    return null;
}

// Arabic: منع إدخال نص المورد كـ HTML داخل النافذة.
// English: Prevent supplier text from being interpreted as HTML in the modal.
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Arabic: التحقق من صلاحية سياق الإضافة بعد تحديثها من chrome://extensions.
// English: Check whether the extension context is valid after an extension reload.
function isExtensionContextAvailable() {
    try {
        return Boolean(globalThis.chrome?.runtime?.id);
    } catch (_) {
        return false;
    }
}

// Arabic: إرسال رسالة آمنة إلى service worker دون إظهار Extension context invalidated للمستخدم.
// English: Safely message the service worker without exposing context-invalidated errors to the user.
async function safeRuntimeMessage(message) {
    if (!isExtensionContextAvailable()) return { success: false, contextInvalidated: true };
    try {
        return await chrome.runtime.sendMessage(message);
    } catch (error) {
        if (/Extension context invalidated/i.test(String(error?.message || error))) {
            return { success: false, contextInvalidated: true };
        }
        throw error;
    }
}

// Arabic: قراءة إعدادات Chrome بأمان أو استخدام القيم الافتراضية.
// English: Safely read Chrome settings or fall back to defaults.
async function safeStorageGet(keys) {
    if (!isExtensionContextAvailable()) return {};
    try {
        return await chrome.storage.local.get(keys);
    } catch (_) {
        return {};
    }
}

// Arabic: حفظ بيانات مؤقتة بأمان، مع الاعتماد على Flask عند انتهاء السياق.
// English: Safely persist pending data, relying on Flask when the context has expired.
async function safeStorageSet(values) {
    if (!isExtensionContextAvailable()) return false;
    try {
        await chrome.storage.local.set(values);
        return true;
    } catch (_) {
        return false;
    }
}

// Arabic: حذف مفاتيح مؤقتة من تخزين الإضافة بأمان.
// English: Safely remove temporary keys from extension storage.
async function safeStorageRemove(keys) {
    if (!isExtensionContextAvailable()) return false;
    try {
        await chrome.storage.local.remove(keys);
        return true;
    } catch (_) {
        return false;
    }
}

// Arabic: فتح صفحة المتجر عبر service worker أو window.open كحل احتياطي.
// English: Open the store through the service worker or window.open as a fallback.
async function openStorePageSafely(url) {
    const response = await safeRuntimeMessage({ action: 'OPEN_TAB', url });
    if (response?.success) return true;
    const opened = window.open(url, '_blank', 'noopener');
    return Boolean(opened);
}

// Arabic: إرسال أحداث الاستخراج إلى ملف السجل الخارجي في Python.
// English: Forward extraction events to the external Python log file.
async function logExtractorEvent(level, event, message, details = {}) {
    const payload = { level, event, message, details, page: window.location.href };
    try {
        const response = await safeRuntimeMessage({ action: 'LOG_CLIENT_EVENT', payload });
        if (response?.success) return;
    } catch (_) { }
    try {
        await fetch(`${API_BASE_URL}/api/log/client`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        acLog('warn', 'AlphaCode log forwarding failed:', error);
    }
}

// Arabic: تحميل الإعدادات أو القيم الافتراضية عند إعادة تحميل الإضافة.
// English: Load saved configuration or defaults after an extension reload.
// Arabic: ألوان Console للتمييز البصري السريع بين مستويات السجل.
// English: Console colour helpers for quick visual distinction between log levels.
const CONSOLE_STYLES = {
    info:  'background:#1e3a8a;color:#93c5fd;font-weight:bold;padding:2px 6px;border-radius:3px',
    ok:    'background:#14532d;color:#86efac;font-weight:bold;padding:2px 6px;border-radius:3px',
    warn:  'background:#78350f;color:#fcd34d;font-weight:bold;padding:2px 6px;border-radius:3px',
    error: 'background:#7f1d1d;color:#fca5a5;font-weight:bold;padding:2px 6px;border-radius:3px',
    debug: 'background:#4c1d95;color:#d8b4fe;font-weight:bold;padding:2px 6px;border-radius:3px',
    price: 'background:#7c2d12;color:#fdba74;font-weight:bold;padding:2px 6px;border-radius:3px',
    batch: 'background:#0f766e;color:#5eead4;font-weight:bold;padding:2px 6px;border-radius:3px',
};
const CONSOLE_ICONS = { info: 'ℹ️', ok: '✅', warn: '⚠️', error: '❌', debug: '🔎', price: '💰', batch: '📦' };
const acLog = (level, ...args) => {
    const style = CONSOLE_STYLES[level] || CONSOLE_STYLES.info;
    const icon = CONSOLE_ICONS[level] || '';
    console.log(`%c${icon} AlphaCode · ${level.toUpperCase()}`, style, ...args);
};
// Arabic: عنوان قسم كبير في الـConsole لتمييز مراحل العمل الكبرى (بدء الدفعة، الرفع، ...).
// English: A large section banner in the console to mark major workflow stages (batch start, upload, ...).
const acBanner = (title, level = 'batch') => {
    const style = CONSOLE_STYLES[level] || CONSOLE_STYLES.batch;
    console.log(`%c${CONSOLE_ICONS[level] || '🧩'} ${title}`, `${style};font-size:13px`);
};

// Arabic: كاش للبراندات المُحمَّلة من السيرفر — يُحدَّث مرة واحدة عند فتح الإضافة وعند طلب
//         تحديث يدوي. يُستخدم لتعبئة قائمة الاختيار في واجهة المراجعة بدل الخريطة الثابتة.
// English: Cache of brands loaded from the server - refreshed once on extension open and
//          on manual refresh requests. Used to populate the review UI dropdown instead of
//          a static hard-coded map.
let _brandsCache = null;

async function fetchBrandsFromServer(force = false) {
    if (_brandsCache && !force) return _brandsCache;
    try {
        const res = await fetch(`${API_BASE_URL}/api/brands`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok && data.success && Array.isArray(data.brands)) {
            _brandsCache = data.brands;
            acLog('ok', `Brands loaded from ${data.source}: ${data.brands.length} brands`);
            return _brandsCache;
        }
    } catch (err) {
        acLog('warn', 'Could not load brands from server, using config fallback.', err);
    }
    _brandsCache = null;
    return null;
}

// Arabic: يسجّل نمط سعر جديد صادفه المستخرج في ملف price_patterns.jsonl عبر الباك اند.
// English: Records a newly-encountered price pattern to price_patterns.jsonl via the backend.
function logPricePattern(rawToken, parsedPrice, productType, styleCode, searchCode, sourceSample) {
    logExtractorEvent('info', 'price_pattern_new', `New price pattern: ${rawToken} → ${parsedPrice}`, {
        raw_token: String(rawToken || '').slice(0, 200),
        parsed_price: parsedPrice,
        product_type: productType,
        style_code: styleCode || '',
        search_code: searchCode || '',
        source_sample: String(sourceSample || '').slice(0, 300),
    }).catch(() => {});
    acLog('price', `Price pattern: "${rawToken}" → ${parsedPrice} (${productType})`);
}

async function loadConfiguration() {
    const result = await safeStorageGet(['extractorConfig']);
    extractorConfig = { ...DEFAULT_CONFIG, ...(result.extractorConfig || {}) };
    if (extractorConfig.StoreProfileName === 'BRANDKINGDOM') {
        extractorConfig.StoreProfileName = 'Sooqify Online';
    }
    if (!extractorConfig.SupplierStoreName) {
        extractorConfig.SupplierStoreName = 'BRANDKINGDOM';
    }
    await loadBrandsCache();
    return extractorConfig;
}

if (isExtensionContextAvailable()) {
    try {
        chrome.runtime.onMessage.addListener(message => {
            if (message && message.action === 'UPDATE_CONFIG' && message.config) {
                extractorConfig = { ...DEFAULT_CONFIG, ...message.config };
            }
        });
    } catch (_) { }
}

// Arabic: دالة normalizeText جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: normalizeText is part of the extraction flow and can be adapted for another store.
function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

// Arabic: دالة isValidCode جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: isValidCode is part of the extraction flow and can be adapted for another store.
function isValidCode(value) {
    const normalized = normalizeText(value).toUpperCase();
    return !['', 'NONE', 'NULL', 'UNDEFINED', 'غير محدد', 'NO_CODE', 'NO_STYLE'].includes(normalized);
}

// Arabic: دالة getProductCard جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: getProductCard is part of the extraction flow and can be adapted for another store.
function getProductCard(element) {
    return element && element.closest ? element.closest(PRODUCT_CARD_SELECTOR) : null;
}

// Arabic: قراءة Search Code من كتلة الخصائص المستقلة بدلاً من وصف المنتج.
// English: Read Search Code from its dedicated attribute block, not from the description.
function extractSearchCode(productBox) {
    const attributeBlocks = productBox.querySelectorAll(
        '[class*="GoodsAttribute_GoodsAttribute"], [class*="goods-attribute"], [class*="attribute"]'
    );

    const acceptedLabels = ['search code', 'searchcode', '搜索码', '搜索代码', '检索码'];

    for (const block of attributeBlocks) {
        const labelElement = block.querySelector('[class*="GoodsAttribute_label"], [class*="label"]');
        const label = normalizeText(labelElement ? labelElement.textContent : '').toLowerCase();
        if (!acceptedLabels.some(candidate => label === candidate || label.includes(candidate))) continue;

        const valueElement = block.querySelector(
            '[data-clipboard-text], [class*="GoodsAttribute_value"], [class*="value"]'
        );
        const value = normalizeText(
            valueElement && (valueElement.getAttribute('data-clipboard-text') || valueElement.textContent)
        );
        const match = value.match(/[A-Za-z0-9_-]{3,}/);
        if (match) return match[0];
        // Arabic: تشخيص مؤقت - لقينا كتلة بعنوان مطابق لكن ما قدرنا نطلع منها كود صالح.
        // English: Temporary diagnostic - found a matching-labeled block but couldn't extract a valid code from it.
        acLog('debug', '[SearchCode] Stage 1: label matched but value extraction failed.', { label, rawValue: value, block });
    }
    if (attributeBlocks.length === 0) {
        acLog('debug', '[SearchCode] Stage 1: no attribute blocks found at all with current selectors.', { productBox });
    }

    const clipboardCandidates = productBox.querySelectorAll('[data-clipboard-text]');
    for (const candidate of clipboardCandidates) {
        const parentText = normalizeText(candidate.parentElement && candidate.parentElement.textContent).toLowerCase();
        if (!acceptedLabels.some(label => parentText.includes(label))) continue;
        const value = normalizeText(candidate.getAttribute('data-clipboard-text'));
        const match = value.match(/[A-Za-z0-9_-]{3,}/);
        if (match) return match[0];
        acLog('debug', '[SearchCode] Stage 2: clipboard candidate matched but value extraction failed.', { parentText, rawValue: value });
    }

    const fallbackMatch = normalizeText(productBox.innerText).match(
        /(?:Search\s*Code|搜索码|搜索代码|检索码)\s*[:：#]?\s*([A-Za-z0-9_-]{3,})/i
    );
    if (!fallbackMatch) {
        // Arabic: تشخيص مؤقت - فشلت كل المراحل الثلاث. لتشخيص السبب افتح Console بمتصفحك على
        //         صفحة SZWEGO، وابحث عن سطور تبدأ بـ[AlphaCode][SearchCode] وأرسلها لنا.
        // English: Temporary diagnostic - all three stages failed. To diagnose, open your
        //          browser Console on the SZWEGO page, find lines starting with
        //          [AlphaCode][SearchCode], and send them to us.
        acLog('debug', '[SearchCode] Stage 3: fallback regex on innerText also failed.', {
            innerTextSample: normalizeText(productBox.innerText).slice(0, 400),
        });
    }
    return fallbackMatch ? fallbackMatch[1] : null;
}

// Arabic: دالة extractSourceDescription جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: extractSourceDescription is part of the extraction flow and can be adapted for another store.
function extractSourceDescription(productBox) {
    const titleContainer = Array.from(productBox.children || []).find(
        child => child.hasAttribute && child.hasAttribute('title') && normalizeText(child.getAttribute('title'))
    );
    if (titleContainer) return normalizeText(titleContainer.getAttribute('title'));

    const preferredElement = productBox.querySelector(
        '[class*="word-break"][class*="ellipsis"], .detail-text, .goods-title, [class*="description"], [class*="desc"]'
    );
    if (preferredElement) return normalizeText(preferredElement.innerText || preferredElement.textContent);

    const clone = productBox.cloneNode(true);
    clone.querySelectorAll(
        'details, .alphacode-extract-btn, .alphacode-batch-select, .alphacode-generated-action-bar, [class*="handle_bar"]',
    ).forEach(node => node.remove());
    return normalizeText(clone.innerText || clone.textContent);
}

// Arabic: استخراج الاسم الأصلي الظاهر في بطاقة المورد دون إعادة صياغته.
// English: Extract the supplier's original visible product name without rewriting it.
function extractOriginalProductName(productBox) {
    const selectors = [
        '[class*="word-break"][class*="ellipsis"]',
        '.goods-title',
        '[class*="goods-title"]',
        '.detail-text',
        '[class*="title"]',
        '[title]'
    ];

    for (const selector of selectors) {
        const elements = Array.from(productBox.querySelectorAll(selector));
        for (const element of elements) {
            const value = normalizeText(
                element.getAttribute?.('title')
                || element.innerText
                || element.textContent
            );
            if (!value || value.length < 3) continue;
            const firstLine = normalizeText(value.split(/\r?\n/)[0]);
            if (firstLine) return firstLine;
        }
    }

    return extractSourceDescription(productBox);
}

// Arabic: نسخ النص مع حل احتياطي للصفحات التي تمنع Clipboard API.
// English: Copy text with a fallback for pages that block the Clipboard API.
async function copyTextToClipboard(value) {
    const text = String(value || '').trim();
    if (!text) return false;

    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
    }
}


// Arabic: بناء نص يحوي كل الأسماء الأصلية لمنتجات الدفعة، كل اسم بسطر لحاله وبينهم سطر "+" فاصل،
// جاهز للصق مباشرة في أي نموذج ذكاء اصطناعي خارجي لصياغتها باحترافية دفعة واحدة.
// English: Build a single text block with every batch product's original name, one per line,
// separated by a standalone "+" line, ready to paste into an external AI model for bulk rewriting.
function buildBatchOriginalNamesText(drafts) {
    return drafts
        .map(draft => normalizeText(draft.originalProductName || draft.sourceText || ''))
        .filter(Boolean)
        .join('\n+\n');
}

// Arabic: إنشاء قالب JSON فارغ يمكن إرساله إلى أي نموذج ذكاء اصطناعي خارجي.
// English: Build an empty JSON template that can be sent to any external AI model.
function buildEmptyExternalCopyTemplate() {
    return JSON.stringify(EMPTY_EXTERNAL_COPY_TEMPLATE, null, 2);
}

// Arabic: قراءة قالب JSON مع دعم أسماء المفاتيح القديمة أو المختلفة الشائعة.
// English: Parse a JSON copy template while accepting common legacy key aliases.
function parseExternalCopyTemplate(rawValue) {
    let text = String(rawValue || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!text) throw new Error('ألصق قالب JSON أولاً.');

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`قالب JSON غير صالح: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('يجب أن يكون القالب كائن JSON واحداً.');
    }

    const read = (...keys) => {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(parsed, key)) {
                return String(parsed[key] ?? '').trim();
            }
        }
        return '';
    };

    const normalized = {
        name_en: read('name_en', 'NameEN', 'nameEN', 'english_name', 'title_en'),
        description_en: read('description_en', 'DescriptionEN', 'descriptionEN', 'english_description', 'desc_en'),
        name_ar: read('name_ar', 'NameAR', 'nameAR', 'arabic_name', 'title_ar'),
        description_ar: read('description_ar', 'DescriptionAR', 'descriptionAR', 'arabic_description', 'desc_ar'),
    };

    if (!Object.values(normalized).some(Boolean)) {
        throw new Error('القالب لا يحتوي على أي من حقول الاسم والوصف المطلوبة.');
    }

    return normalized;
}

// Arabic: تطبيق قيم القالب على حقول الاسم والوصف دون مسح الحقول التي لم يرسلها القالب.
// English: Apply template values without clearing fields omitted by the supplied JSON.
function applyExternalCopyTemplate(template, fields) {
    const assignments = [
        ['name_en', fields.nameEN],
        ['description_en', fields.descEN],
        ['name_ar', fields.nameAR],
        ['description_ar', fields.descAR],
    ];

    for (const [key, element] of assignments) {
        if (!element || !template[key]) continue;
        element.value = template[key];
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// Arabic: ربط أزرار قبول القالب ونسخ القالب الفارغ ونسخ الاسم الأصلي داخل أي نافذة مراجعة.
// English: Bind apply, copy-empty-template, and copy-original-name controls in any review surface.
function bindExternalCopyTemplateControls({
    root,
    textarea,
    applyButton,
    copyEmptyButton,
    copyOriginalButton,
    statusElement,
    fields,
    originalProductName,
}) {
    const setStatus = (message, isError = false) => {
        if (!statusElement) return;
        statusElement.textContent = message;
        statusElement.classList.toggle('error', Boolean(isError));
        statusElement.classList.toggle('success', !isError && Boolean(message));
    };

    applyButton?.addEventListener('click', () => {
        try {
            const template = parseExternalCopyTemplate(textarea?.value || '');
            applyExternalCopyTemplate(template, fields);
            setStatus('تم قبول القالب وتعبئة الحقول.');
        } catch (error) {
            setStatus(error.message, true);
        }
    });

    copyEmptyButton?.addEventListener('click', async () => {
        const copied = await copyTextToClipboard(buildEmptyExternalCopyTemplate());
        setStatus(copied ? 'تم نسخ القالب الفارغ.' : 'تعذر نسخ القالب.', !copied);
    });

    copyOriginalButton?.addEventListener('click', async () => {
        const copied = await copyTextToClipboard(originalProductName || '');
        setStatus(copied ? 'تم نسخ الاسم الأصلي.' : 'لا يوجد اسم أصلي قابل للنسخ.', !copied);
    });

    return root;
}


// Arabic: الأولوية لصيغ Item No وStyle Code والحقول الصينية فقط، دون كلمة Code العامة.
// English: Prioritize explicit Item No/Style Code labels and never use a generic Code token.
function extractStyleCode(sourceText) {
    if (!sourceText || !String(sourceText)) return '';
    const text = String(sourceText);

    // Common labelled patterns (English, Chinese, MPN/Part/Art/Model)
    const patterns = [
        /(?:Product\s*(?:No\.?|Number)|Product\s*#)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i,
        /(?:Item\s*(?:No\.?|Number)|Item\s*#)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i,
        /Style\s*Code\s*[:：#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i,
        /(?:SKU|Ref(?:erence)?|MPN|Part\s*No\.|Art\s*No\.|MPN:)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i,
        /(?:货号|款号|型号|商品编号|参考编号)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i,
        /(?:Model\s*(?:No\.?|Number)?)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i,
        /(?:MPN|Part\s+No\.|Art\s+No\.)\s*[:：#]?\s*([A-Z0-9\-_.]{3,})/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            const cleaned = match[1].replace(/[.,;:\s]+$/g, '').trim();
            if (isReasonableCode(cleaned)) return cleaned;
        }
    }

    // Codes inside parentheses e.g. (ABC-1234) or [ABC123]
    const paren = text.match(/[\(\[\{]\s*([A-Z0-9][A-Z0-9._\/-]{2,})\s*[\)\]\}]/i);
    if (paren && paren[1] && isReasonableCode(paren[1].trim())) return paren[1].trim();

    // Fallback: take token after a '#' if it looks like a code
    const afterHash = text.match(/#\s*([A-Z0-9][A-Z0-9._\/-]{2,})/i);
    if (afterHash && afterHash[1] && isReasonableCode(afterHash[1].trim())) return afterHash[1].trim();

    // Strict fallback for e.g. ABC-1234 or AB123456 patterns
    const strictFallback = text.match(/\b([A-Z]{1,4}[-–_]?[0-9]{3,8}[-–_]?[A-Z0-9]{0,4})\b/i);
    if (strictFallback && strictFallback[1] && isReasonableCode(strictFallback[1].trim())) return strictFallback[1].trim();

    return '';
}


function isReasonableCode(value) {
    if (!value) return false;
    // Reject obviously fake tokens
    const lower = String(value).toLowerCase();
    if (/^(?:详情|购买|查看|图片|img|http|https)$/.test(lower)) return false;
    if (/^[0-9]{6,}$/.test(value)) return false; // long numeric sequences are unlikely real style codes
    if (value.length < 3 || value.length > 40) return false;
    return true;
}

// Arabic: تحديد نوع المنتج (حذاء/ساعة) من نص الصفحة أو مسار التصنيف (Breadcrumb)؛ يبقى قابلاً للتجاوز يدوياً من واجهة الاستخراج.
// English: Detect the product type (shoe/watch) from the page text or the category breadcrumb; still meant to be manually overridable from the extraction UI.
function detectProductType(sourceText, breadcrumbText = '') {
    const haystack = `${breadcrumbText} ${sourceText}`;
    if (/\b(watch|watches|timepiece)\b/i.test(haystack) || /手表|腕表|钟表/.test(haystack)) {
        return 'watches';
    }
    return 'shoes';
}

// Arabic: اقتراح مبدئي (غير نهائي) لفروقات سعر الألوان من نص وصف الساعة، لعرضه قابلاً للتعديل في شاشة المراجعة
// قبل الإرسال - لا يُستخدم كسعر نهائي تلقائياً لأن صياغة البائعين تختلف كثيراً بلا نمط ثابت واحد.
// English: A best-effort (non-final) suggestion for watch color price deltas parsed from the description,
// meant to be shown editable in the review screen before submission - never applied silently as a final
// price, since seller phrasing varies too much to trust blindly.
function extractWatchColorDeltas(sourceText) {
    const text = normalizeText(sourceText);
    const colorWords = {
        '白壳': 'White', '白': 'White', '银': 'Silver',
        '金壳': 'Gold', '金玫': 'Rose Gold', '玫瑰金': 'Rose Gold', '金': 'Gold',
        '黑壳': 'Black', '黑': 'Black',
    };
    const results = [];
    const seenLabels = new Set();

    // نمط: <لون>💰<رقم> يُعتبر السعر الأساسي (فرق = 0).
    const baseMatch = text.match(/([\u4e00-\u9fa5]{1,3})\s*(?:壳)?\s*💰\s*(\d+)/);
    if (baseMatch) {
        const label = colorWords[baseMatch[1] + (text[baseMatch.index + baseMatch[1].length] === '壳' ? '壳' : '')] || colorWords[baseMatch[1]] || baseMatch[1];
        if (!seenLabels.has(label)) {
            seenLabels.add(label);
            results.push({ label, delta_yuan: 0, base_price_yuan: parseInt(baseMatch[2], 10) });
        }
    }

    // نمط: <لون>+<رقم> يُعتبر فرقاً عن السعر الأساسي.
    const deltaPattern = /([\u4e00-\u9fa5]{1,3})\s*(?:壳)?\s*\+\s*(\d+)/g;
    let deltaMatch;
    while ((deltaMatch = deltaPattern.exec(text)) !== null) {
        const raw = deltaMatch[1] + (text[deltaMatch.index + deltaMatch[1].length] === '壳' ? '壳' : '');
        const label = colorWords[raw] || colorWords[deltaMatch[1]] || deltaMatch[1];
        if (!seenLabels.has(label)) {
            seenLabels.add(label);
            results.push({ label, delta_yuan: parseInt(deltaMatch[2], 10) });
        }
    }

    // Arabic: لو ما انلقى أي نمط واضح، نرجّع مصفوفة فاضية بدل تخمين غير موثوق - المستخدم يعبيها يدوياً بالمراجعة.
    // English: If nothing clear was found, return an empty array instead of an unreliable guess - the operator fills it in manually during review.
    return results;
}

// Arabic: أنماط الأسعار المحمّلة من price_patterns.json — تُحمَّل مرة واحدة عند بدء التشغيل.
// English: Price patterns loaded from price_patterns.json — loaded once at startup.
let _pricePatterns = null;

async function loadPricePatterns() {
    if (_pricePatterns) return _pricePatterns;
    try {
        const url = chrome.runtime.getURL('price_patterns.json');
        const res = await fetch(url);
        const data = await res.json();
        _pricePatterns = data.patterns || [];
        acLog('ok', `Loaded ${_pricePatterns.length} price patterns from price_patterns.json`);
    } catch (_) {
        _pricePatterns = [];
    }
    return _pricePatterns;
}

// Arabic: استخراج السعر باليوان من نص المنتج الخام. يُجرِّب الأنماط المحمّلة من price_patterns.json
//         بالترتيب (أول تطابق يفوز)، ثم يسقط للمنطق الاحتياطي لو ما لقى شيء. لو اكتشف نمطاً
//         غير مُعرَّف (رقم بدون رمز عملة صريح)، يُسجّله في price_patterns.jsonl للمراجعة.
// English: Extracts the CNY price from the raw product text. Tries loaded patterns in order
//          (first match wins), then falls back if nothing found. If it falls back to a bare
//          number (no explicit currency symbol), it logs it to price_patterns.jsonl for review.
function extractOriginalPrice(sourceText, styleCode, searchCode, productType) {
    if (!sourceText) return 0;

    const patterns = _pricePatterns || [];
    for (const p of patterns) {
        try {
            const flags = p.flags || '';
            const regex = new RegExp(p.regex, flags);
            const match = sourceText.match(regex);
            if (match && match[p.group]) {
                const value = parseFloat(match[p.group]);
                if (value > 0) return value;
            }
        } catch (_) {}
    }

    // Arabic: Fallback قديم — اليوان بالنص العربي أو رقم عريان (غير موثوق تماماً).
    // English: Legacy fallback — Arabic "yuan" text or a bare number (less reliable).
    const yuanMatch = sourceText.match(/(?:يوان)\s*(\d+)/i);
    if (yuanMatch) return parseInt(yuanMatch[1], 10);

    const bareMatch = sourceText.match(/\b(\d{2,4})\b/);
    if (bareMatch) {
        const value = parseInt(bareMatch[1], 10);
        // Arabic: رقم عريان بدون رمز عملة — سجّل كنمط مجهول للمراجعة.
        // English: Bare number with no currency symbol — log as unknown pattern for review.
        if (typeof logPricePattern === 'function') {
            logPricePattern(bareMatch[0], value, productType || 'unknown', styleCode, searchCode, sourceText.slice(0, 300));
        }
        return value;
    }

    return 0;
}

// Arabic: استخراج السعر من حقل "Selling price" الصريح — يُستخدم كـfallback فقط لو النص
//         ما فيه سعر باليوان صريح (💰/¥/Y)، لأن حقل السعر قد يكون بالدولار حسب إعدادات VPN/لغة المتصفح.
// English: Extract price from the explicit "Selling price" field — used as a fallback only
//          when the text has no explicit CNY price, because the field currency depends on
//          the browser's VPN/language settings and may show USD instead of CNY.
function extractStructuredPrice(productBox) {
    if (!productBox) return 0;
    const priceElements = productBox.querySelectorAll('[class*="AttributePrice_value"]');
    for (const element of priceElements) {
        const raw = normalizeText(element.getAttribute('data-clipboard-text') || element.textContent).replace(/,/g, '');
        const match = raw.match(/(\d+(?:\.\d+)?)/);
        if (match) return parseFloat(match[1]);
    }
    return 0;
}

// Arabic: كل الأسعار الصريحة الموجودة على المصدر (مو أول سعر بس) - لو أكثر من واحد، غالباً
//         معناه إن المنشور فيه أكثر من نسخة/سعر (مثلاً ألوان مختلفة بأسعار مختلفة)، فتظهر
//         كلها في لوحة المراجعة عشان المشغّل يراجعها يدوياً بدل ما نخمّن أيها الصحيح.
// English: Every explicit price found on the source (not just the first) - more than one
//          usually means the post has more than one version/price (e.g. different colors
//          at different prices), so they all surface in the review panel for the operator
//          to reconcile manually instead of us guessing which one is right.
function extractAllStructuredPrices(productBox) {
    if (!productBox) return [];
    const priceElements = productBox.querySelectorAll('[class*="AttributePrice_value"]');
    const values = [];
    priceElements.forEach(element => {
        const raw = normalizeText(element.getAttribute('data-clipboard-text') || element.textContent).replace(/,/g, '');
        const match = raw.match(/(\d+(?:\.\d+)?)/);
        if (match) values.push(parseFloat(match[1]));
    });
    return [...new Set(values)];
}

// Arabic: قائمة "Specs" الصريحة إن وجدت (مثل مقاس أو نسخة مختصرة) - حقل موجود أحياناً على
//         SZWEGO تحت خصائص المنتج، منفصل عن Search Code والسعر.
// English: The explicit "Specs" tag list when present (e.g. a size or short format code) -
//          a field SZWEGO sometimes shows under a product's attributes, separate from the
//          Search Code and price.
function extractSpecs(productBox) {
    if (!productBox) return [];
    const specElements = productBox.querySelectorAll('[class*="AttributeFormats_item"]');
    const values = [];
    specElements.forEach(element => {
        const value = normalizeText(element.getAttribute('data-clipboard-text') || element.textContent);
        if (value) values.push(value);
    });
    return [...new Set(values)];
}


// Arabic: إزالة تكرار المقاسات مع ترتيب رقمي مناسب.
// English: Deduplicate sizes and keep a natural numeric order.
function uniqueSizes(values) {
    const unique = [];
    const seen = new Set();
    for (const value of values || []) {
        const normalized = normalizeText(value).toUpperCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
    }
    return unique.sort((a, b) => {
        const aNumber = Number(a);
        const bNumber = Number(b);
        if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
        return a.localeCompare(b, undefined, { numeric: true });
    });
}

// Arabic: استخراج القائمة الصريحة للمقاسات من الإنجليزية والصينية والأقواس الصينية.
// English: Extract explicit size lists from English/Chinese labels and Chinese parentheses.
function extractSizes(sourceText) {
    const text = normalizeText(sourceText).replace(/（/g, '(').replace(/）/g, ')');
    const labels = /(?:Available\s+)?(?:Sizes?|Size\s*Range|尺码|碼數|码数|鞋码|鞋碼)\s*[:：]?\s*/ig;
    let labelMatch;
    let best = [];
    while ((labelMatch = labels.exec(text)) !== null) {
        let segment = text.slice(labelMatch.index + labelMatch[0].length, labelMatch.index + labelMatch[0].length + 500);
        const parenthesized = segment.match(/\(([^)]{2,360})\)/);
        const target = parenthesized ? parenthesized[1] : segment.split(/(?:\||;|\n|\b(?:Upper|Material|Color|Style\s*Code|Item\s*No\.?|Description)\b|(?:货号|款号|型号|商品编号)\s*[:：#]?)/i)[0];
        const explicit = uniqueSizes(target.match(/\b(?:\d{1,2}(?:\.\d{1,2})?|XXXL|XXL|XL|L|M|S|XS|XXS|ONE\s*SIZE)\b/gi) || []);
        if (explicit.length > best.length) best = explicit;
    }
    return best;
}

// Arabic: إرجاع خريطة البراندات المبنية مسبقاً (sync) - راجع تعليق brandNameToIdMap
//         أعلى الملف لسبب استخدام كاش بالذاكرة بدل قراءة chrome.storage هنا مباشرة.
// English: Return the pre-built (sync) brand map - see the brandNameToIdMap comment
//          near the top of the file for why this uses an in-memory cache instead of
//          reading chrome.storage directly here.
function parseBrandMap() {
    return brandNameToIdMap;
}

// Arabic: يحوّل قائمة براندات [{id,name}] (من /api/brands أو الكاش) لخريطة اسم→id
//         نظيفة، بنفس منطق التنظيف المستخدَم سابقاً مع BrandMapJson (canonicalBrandAlias
//         + رفض أي id غير صالح) - عشان خوارزمية المطابقة بـresolveBrandId/canonicalBrandName
//         ما تتغيّر إطلاقاً، فقط مصدر البيانات.
// English: Converts a brand list [{id,name}] (from /api/brands or the cache) into a
//          clean name->id map, using the exact same cleaning logic previously applied to
//          BrandMapJson (canonicalBrandAlias + rejecting any invalid id) - so the matching
//          algorithm in resolveBrandId/canonicalBrandName never changes, only the source.
function brandListToNameMap(brands) {
    const cleaned = {};
    for (const b of brands || []) {
        const name = canonicalBrandAlias(b?.name);
        const id = Number(b?.id || 0);
        if (name && Number.isFinite(id) && id > 0) cleaned[name] = id;
    }
    return cleaned;
}

// Arabic: يملأ brandNameToIdMap مرة وحدة عند بدء تشغيل content script - من كاش
//         chrome.storage المشترك مع popup.js أولاً، ولو فاضي (أول استخدام قبل ما حد
//         يفتح popup أبداً) يسوي fetch احتياطي مباشر لـ/api/brands بنفسه (content.js
//         عنده وصول شبكة مباشر للباك اند أصلاً عبر API_BASE_URL). فشل الاثنين يترك
//         brandNameToIdMap فاضية (نفس سلوك BrandMapJson فاضي/غير صالح سابقاً - fallback
//         النهائي بـresolveBrandId على extractorConfig.BrandId يبقى شغّال كما هو).
// English: Fills brandNameToIdMap once at content-script startup - first from the
//          chrome.storage cache shared with popup.js, and if that's empty (first-ever
//          use before popup was ever opened) falls back to a direct fetch to /api/brands
//          itself (content.js already has direct network access to the backend via
//          API_BASE_URL). If both fail, brandNameToIdMap stays empty (same behavior as
//          an empty/invalid BrandMapJson before - the final fallback in resolveBrandId
//          to extractorConfig.BrandId still works as-is).
async function loadBrandsCache() {
    try {
        const stored = await safeStorageGet([BRANDS_CACHE_STORAGE_KEY]);
        const cached = stored[BRANDS_CACHE_STORAGE_KEY];
        if (Array.isArray(cached) && cached.length) {
            brandNameToIdMap = brandListToNameMap(cached);
            return;
        }
    } catch (_) { /* fall through to the direct fetch below */ }

    try {
        const response = await fetch(`${API_BASE_URL}/api/brands`, { cache: 'no-store' });
        const data = await response.json();
        if (response.ok && data.success && Array.isArray(data.brands) && data.brands.length) {
            brandNameToIdMap = brandListToNameMap(data.brands);
            await safeStorageSet({ [BRANDS_CACHE_STORAGE_KEY]: data.brands });
        }
    } catch (_) {
        // Arabic: تُترك brandNameToIdMap فاضية - resolveBrandId يرجع لـBrandId العام.
        // English: brandNameToIdMap stays empty - resolveBrandId falls back to the global BrandId.
    }
}

// Arabic: توحيد الاسم فقط دون استخدام نص المنتج الكامل كبراند.
// English: Canonicalize a brand token without treating full product text as a brand.
function canonicalBrandAlias(value) {
    const text = normalizeText(value).slice(0, 120);
    if (/\b(?:air\s+jordan|jordan\s+brand|jordan\s*\d+|aj\s*\d+)\b/i.test(text) || text.toLowerCase() === 'jordan') return 'Air Jordan';
    if (/\bnike\b/i.test(text)) return 'Nike';
    if (/\badidas\b/i.test(text)) return 'Adidas';
    if (/\bnew\s+balance\b/i.test(text)) return 'New Balance';
    if (/\bpuma\b/i.test(text)) return 'Puma';
    if (/\bconverse\b/i.test(text)) return 'Converse';
    if (/\bvans\b/i.test(text)) return 'Vans';
    if (/\basics\b/i.test(text)) return 'ASICS';
    if (/\breebok\b/i.test(text)) return 'Reebok';
    if (/\bunder\s+armour\b/i.test(text)) return 'Under Armour';
    return text.length <= 60 ? text : '';
}

// Arabic: إرجاع أسماء البراندات الموجودة فعلياً في خريطة المتجر.
// English: Return only brands that actually exist in the configured store map.
function getAllowedBrandNames() {
    const map = parseBrandMap();
    const names = Object.keys(map);
    const configured = canonicalBrandAlias(extractorConfig.BrandName);

    if (configured && !names.some(name => name.toLowerCase() === configured.toLowerCase())) {
        names.push(configured);
    }

    return names.length ? names : ['Air Jordan'];
}

// Arabic: رفض أي براند غير موجود في خريطة المتجر والعودة للبراند الافتراضي.
// English: Reject any brand absent from the store map and fall back to the configured brand.
function canonicalBrandName(value) {
    const allowed = getAllowedBrandNames();
    const candidate = canonicalBrandAlias(value);

    for (const brand of allowed) {
        if (candidate && canonicalBrandAlias(brand).toLowerCase() === candidate.toLowerCase()) {
            return brand;
        }
    }

    const evidence = normalizeText(value);
    for (const brand of allowed) {
        const canonical = canonicalBrandAlias(brand);
        const pattern = canonical === 'Air Jordan'
            ? /\b(?:air\s+jordan|jordan\s*\d+|aj\s*\d+)\b/i
            : new RegExp(`\\b${canonical.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
        if (pattern.test(evidence)) return brand;
    }

    const configured = canonicalBrandAlias(extractorConfig.BrandName);
    return allowed.find(brand => canonicalBrandAlias(brand).toLowerCase() === configured.toLowerCase())
        || allowed[0];
}

// Arabic: تحديد ID البراند من الخريطة فقط، لمنع إرسال ID لبراند غير موجود.
// English: Resolve the brand ID strictly from the configured map.
function resolveBrandId(brandName) {
    const map = parseBrandMap();
    const wanted = canonicalBrandName(brandName).toLowerCase();
    for (const [name, id] of Object.entries(map)) {
        if (canonicalBrandAlias(name).toLowerCase() === wanted && Number(id) > 0) return Number(id);
    }
    return Number(extractorConfig.BrandId || 0);
}


// Arabic: استخراج معرف متجر SZWEGO من الإعدادات أو رابط الصفحة.
// English: Resolve the SZWEGO supplier-store ID from settings or the current URL.
function resolveSupplierStoreId() {
    if (normalizeText(extractorConfig.SupplierStoreId)) return normalizeText(extractorConfig.SupplierStoreId);
    const query = new URLSearchParams(window.location.search);
    for (const key of ['shop_id', 'shopId', 'seller_id', 'sellerId', 'store_id']) {
        if (query.get(key)) return query.get(key);
    }
    const match = window.location.href.match(/\b(A\d{12,})\b/i);
    return match ? match[1] : '';
}

// Arabic: دالة containsCjk جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: containsCjk is part of the extraction flow and can be adapted for another store.
function containsCjk(value) {
    return /[\u3400-\u9fff]/.test(value || '');
}

// Arabic: دالة isLikelyProductImage جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: isLikelyProductImage is part of the extraction flow and can be adapted for another store.
function isLikelyProductImage(url) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (!/\.(?:jpe?g|png|webp|gif|avif)(?:\?|$)/i.test(url)) return false;
    return !/(?:avatar|icon|logo|emoji|sprite|add_cart_default_cover)/i.test(url);
}

// Arabic: دالة normalizeImageUrl جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: normalizeImageUrl is part of the extraction flow and can be adapted for another store.
function normalizeImageUrl(value) {
    let url = String(value || '')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .trim()
        .replace(/[),;]+$/g, '');
    return isLikelyProductImage(url) ? url : '';
}

// Arabic: دالة canonicalImageKey جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: canonicalImageKey is part of the extraction flow and can be adapted for another store.
function canonicalImageKey(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.toLowerCase();
    } catch (_) {
        return url.split('?')[0].toLowerCase();
    }
}

// Arabic: دالة addUniqueImage جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: addUniqueImage is part of the extraction flow and can be adapted for another store.
function addUniqueImage(map, value) {
    const url = normalizeImageUrl(value);
    if (!url) return;
    const key = canonicalImageKey(url);
    if (!map.has(key)) map.set(key, url);
}

// Arabic: دالة extractUrlsFromText جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: extractUrlsFromText is part of the extraction flow and can be adapted for another store.
function extractUrlsFromText(value, map) {
    const normalized = String(value || '')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
    const matches = normalized.match(
        /https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>]*)?/gi
    ) || [];
    matches.forEach(url => addUniqueImage(map, url));
}

// Arabic: دالة extractDomImages جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: extractDomImages is part of the extraction flow and can be adapted for another store.
function extractDomImages(productBox) {
    const images = new Map();
    productBox.querySelectorAll('img, a, source, video, [style]').forEach(element => {
        addUniqueImage(images, element.currentSrc || '');
        addUniqueImage(images, element.src || '');
        addUniqueImage(images, element.href || '');
        for (const attribute of ['src', 'href', 'data-src', 'data-original', 'data-lazy-src', 'srcset']) {
            const value = element.getAttribute && element.getAttribute(attribute);
            if (!value) continue;
            if (attribute === 'srcset') {
                value.split(',').forEach(part => addUniqueImage(images, part.trim().split(/\s+/)[0]));
            } else {
                addUniqueImage(images, value);
            }
        }
        extractUrlsFromText(element.getAttribute && element.getAttribute('style'), images);
    });
    extractUrlsFromText(productBox.innerHTML || '', images);
    return Array.from(images.values());
}

// Arabic: دالة getBasenameFromUrl جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: getBasenameFromUrl is part of the extraction flow and can be adapted for another store.
function getBasenameFromUrl(url) {
    try {
        return new URL(url).pathname.split('/').pop() || '';
    } catch (_) {
        return url.split('?')[0].split('/').pop() || '';
    }
}

// Arabic: طلب بيانات React ونتائج الشبكة من عالم الصفحة الرئيسي.
// English: Ask the page-world bridge for React data and captured network payloads.
function requestBridgeImages(productBox, searchCode, styleCode, visibleImages) {
    return new Promise(resolve => {
        const token = `ac_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        let mailbox = document.getElementById('alphacode-bridge-mailbox');
        if (!mailbox) {
            mailbox = document.createElement('div');
            mailbox.id = 'alphacode-bridge-mailbox';
            mailbox.style.display = 'none';
            document.documentElement.appendChild(mailbox);
        }

        productBox.setAttribute('data-alphacode-target', token);
        mailbox.setAttribute('data-request', JSON.stringify({
            token,
            searchCode: searchCode || '',
            styleCode: styleCode || '',
            visibleBasenames: visibleImages.map(getBasenameFromUrl).filter(Boolean)
        }));
        mailbox.removeAttribute('data-response');

        let settled = false;
        const finish = images => {
            if (settled) return;
            settled = true;
            window.removeEventListener('alphacode-bridge-response', onResponse);
            productBox.removeAttribute('data-alphacode-target');
            resolve(Array.isArray(images) ? images : []);
        };

        const onResponse = () => {
            try {
                const response = JSON.parse(mailbox.getAttribute('data-response') || '{}');
                if (response.token !== token) return;
                // Arabic: توصيل تشخيص الجسر (لكل مرشح: عدد صوره وعينة روابطه) لسجل بايثون -
                //         كان يُبنى داخل page_bridge.js ويصل هنا لكنه يُتجاهَل بالكامل، بلا
                //         أي تعديل على نتيجة الصور نفسها أو منطق الاختيار.
                // English: Forward the bridge diagnostics (per-candidate image count and
                //          sample URLs) to the Python log - it was already built inside
                //          page_bridge.js and reaches here but was fully discarded; this
                //          does not change the returned images or the selection logic.
                if (response.diagnostics) {
                    logExtractorEvent(
                        'debug',
                        'image_bridge_diagnostics',
                        'Per-candidate image source breakdown from page_bridge.js',
                        response.diagnostics
                    ).catch(() => {});
                }
                finish(response.images || []);
            } catch (_) {
                finish([]);
            }
        };

        window.addEventListener('alphacode-bridge-response', onResponse);
        window.dispatchEvent(new Event('alphacode-bridge-request'));
        setTimeout(() => finish([]), 1600);
    });
}

// Arabic: دالة extractAllImages جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: extractAllImages is part of the extraction flow and can be adapted for another store.
// Arabic: تم تعطيل حد MaxImages عمداً — كل الصور المكتشفة تُعاد كاملة بدون أي قصّ.
//         (تحديث: نظام حظر الصور اليدوي/perceptual-hash حُذف بالكامل من المشروع - لم يعد
//         موجوداً أي قناة استبعاد تلقائي أو يدوي، لا هنا ولا بأي مكان ثاني بالإكستنشن.)
// English: The MaxImages cap is intentionally disabled — every discovered image is
//          returned in full, with no automatic trimming.
//          (Update: the manual/perceptual-hash image-ban system was removed entirely
//          from the project - there is no exclusion channel left, here or anywhere
//          else in the extension.)
async function extractAllImages(productBox, searchCode, styleCode) {
    const visibleImages = extractDomImages(productBox);
    const bridgeImages = await requestBridgeImages(productBox, searchCode, styleCode, visibleImages);
    const combined = new Map();
    visibleImages.forEach(url => addUniqueImage(combined, url));
    bridgeImages.forEach(url => addUniqueImage(combined, url));
    const all = Array.from(combined.values());
    acLog('debug', `extractAllImages: ${all.length} unique image(s) found, no cap/filter applied.`);
    return all;
}

// Arabic: دالة checkArchive جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: checkArchive is part of the extraction flow and can be adapted for another store.
async function checkArchive(searchCode, styleCode) {
    const response = await fetch(`${API_BASE_URL}/api/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            SearchCode: searchCode || 'NONE',
            StyleCode: styleCode || 'غير محدد'
        })
    });
    if (!response.ok) throw new Error(`Archive check failed (${response.status})`);
    return response.json();
}

// Arabic: دالة updateButtonAsAdded جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: updateButtonAsAdded is part of the extraction flow and can be adapted for another store.
function updateButtonAsAdded(button, id = null, workflowStatus = 'prepared') {
    button.classList.remove('alphacode-btn-red');
    button.classList.add('alphacode-btn-green');
    const submitted = workflowStatus === 'submitted';
    if (id) {
        button.innerHTML = submitted
            ? `✔ أُضيف للمتجر (ID: ${id})`
            : `✔ تم التجهيز محلياً (ID: ${id})`;
    } else {
        button.innerHTML = submitted ? '✔ أُضيف للمتجر' : '✔ تم التجهيز سابقاً';
    }
}

// Arabic: دالة injectExtractionButtons جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: injectExtractionButtons is part of the extraction flow and can be adapted for another store.
function injectExtractionButtons() {
    const websiteDownloadButtons = document.querySelectorAll('.wsxc_download');
    websiteDownloadButtons.forEach(downloadButton => {
        const card = getProductCard(downloadButton);
        const actionBar = downloadButton.parentElement || downloadButton;
        if (card && actionBar) createAndInjectButton(actionBar, card);
    });

    document.querySelectorAll(PRODUCT_CARD_SELECTOR).forEach(card => {
        let actionContainer = card.querySelector(
            '[class*="handle_bar"], [class*="footer"], [class*="bottom"], [class*="action"], [class*="operation"]'
        );
        const existingButton = card.querySelector('.alphacode-extract-btn');
        if (existingButton && actionContainer) {
            ensureBatchSelectionControl(actionContainer, card, existingButton);
            return;
        }
        if (!actionContainer) {
            actionContainer = document.createElement('div');
            actionContainer.className = 'alphacode-generated-action-bar';
            card.appendChild(actionContainer);
        }
        createAndInjectButton(actionContainer, card);
    });

    ensureBatchToolbar();
}

// Arabic: دالة createAndInjectButton جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: createAndInjectButton is part of the extraction flow and can be adapted for another store.
function createAndInjectButton(container, parentCard) {
    if (!container || !parentCard) return;

    const sourceText = extractSourceDescription(parentCard);
    const searchCode = extractSearchCode(parentCard);
    const styleCode = extractStyleCode(sourceText);
    const productKey = getBatchCardKey(parentCard);
    const existingButton = parentCard.querySelector('.alphacode-extract-btn');

    if (existingButton) {
        // Arabic: يعيد الموقع استخدام بطاقة المنتج؛ حدّث حالة الزر حتى لا تبقى حالة المنتج السابق.
        // English: Refresh a recycled card button so it cannot retain the previous product state.
        if (existingButton.dataset.alphacodeProductKey !== productKey) {
            existingButton.dataset.alphacodeProductKey = productKey;
            existingButton.classList.remove('alphacode-btn-green');
            existingButton.classList.add('alphacode-btn-red');
            existingButton.innerHTML = '⚡ سحب لـ 6amMart';
            existingButton.dataset.searchCode = searchCode || '';
            existingButton.dataset.styleCode = isValidCode(styleCode) ? styleCode : '';
            checkArchive(searchCode, styleCode)
                .then(data => {
                    if (existingButton.dataset.alphacodeProductKey !== productKey) return;
                    if (data.exists) updateButtonAsAdded(existingButton, data.id || null, data.workflow_status || 'prepared');
                })
                .catch(() => { });
        }
        ensureBatchSelectionControl(container, parentCard, existingButton);
        return;
    }

    const button = document.createElement('button');
    button.className = 'alphacode-extract-btn alphacode-btn-red';
    button.innerHTML = '⚡ سحب لـ 6amMart';
    button.type = 'button';
    button.dataset.alphacodeProductKey = productKey;
    if (searchCode) button.dataset.searchCode = searchCode;
    if (isValidCode(styleCode)) button.dataset.styleCode = styleCode;

    checkArchive(searchCode, styleCode)
        .then(data => {
            if (data.exists) updateButtonAsAdded(button, data.id || null, data.workflow_status || "prepared");
            if (data.last_added_code) lastAddedSearchCodeGlobal = data.last_added_code;
        })
        .catch(() => { });

    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        // Arabic: لا يبدأ أي استخراج قبل التأكد من جلسة لوحة المتجر.
        // English: No extraction starts before the store-panel session is confirmed.
        if (!(await ensureStoreSession())) return;
        openExtractionModal(parentCard, button);
    });

    container.insertBefore(button, container.firstChild);
    ensureBatchSelectionControl(container, parentCard, button);
    ensureBatchToolbar();
}

// =========================================================
// Arabic: بوابة جلسة لوحة تحكم سوقيفاي - تُفحص مرة واحدة لكل جلسة عمل قبل أول استخراج/رفع.
//         قبل هذا كانت الأداة تفترض أن المستخدم مسجل دخول، فيفشل الرفع متأخراً بعد كل
//         العمل. الآن يُفحص فعلياً بجلب صفحة اللوحة والبحث عن نموذج إضافة المنتج.
// English: Sooqify admin session gate - checked once per working session before the first
//          extraction/upload. Previously the tool simply assumed the operator was signed in,
//          so uploads failed late, after all the work. Now it is genuinely verified by
//          fetching the panel page and looking for the product-add form.
// =========================================================

// Arabic: null = لم يُفحص بعد؛ true = مؤكَّد/أكّده المستخدم؛ يُعاد ضبطه بإعادة تحميل الصفحة.
// English: null = not yet checked; true = verified or confirmed by the operator; resets on reload.
let storeSessionVerified = null;

function renderStoreSessionPrompt(detail) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'alphacode-session-overlay';
        overlay.innerHTML = `
            <div class="alphacode-session-box">
                <h3>تحقق من لوحة تحكم سوقيفاي</h3>
                <p>${escapeHtml(detail)}</p>
                <p class="alphacode-session-hint">الاستخراج والرفع لا يعملان بدون جلسة صالحة بلوحة المتجر.</p>
                <div class="alphacode-session-actions">
                    <button type="button" class="alphacode-session-open">فتح لوحة التحكم لتسجيل الدخول</button>
                    <button type="button" class="alphacode-session-recheck">أعد الفحص</button>
                    <button type="button" class="alphacode-session-confirm">أنا مسجل دخول — تابع</button>
                    <button type="button" class="alphacode-session-cancel">إلغاء</button>
                </div>
                <div class="alphacode-session-status"></div>
            </div>`;
        document.body.appendChild(overlay);

        const status = overlay.querySelector('.alphacode-session-status');

        overlay.querySelector('.alphacode-session-open').onclick = () => {
            chrome.runtime.sendMessage({
                action: 'OPEN_TAB',
                url: (extractorConfig.SooqifyAddUrl || 'https://admin.sooqifyonline.com/admin/item/add-new'),
            });
            status.textContent = 'فُتحت اللوحة بتبويب جديد. سجّل دخولك ثم اضغط "أعد الفحص".';
        };

        overlay.querySelector('.alphacode-session-recheck').onclick = async event => {
            event.currentTarget.disabled = true;
            status.textContent = 'جاري إعادة الفحص...';
            const result = await requestStoreSessionCheck();
            event.currentTarget.disabled = false;
            if (result.loggedIn) {
                overlay.remove();
                resolve(true);
                return;
            }
            status.textContent = result.checked
                ? `ما زالت الجلسة غير صالحة: ${result.reason || ''}`
                : 'تعذر الوصول للوحة للتحقق. تأكد من الاتصال أو تابع يدوياً.';
        };

        // Arabic: التأكيد اليدوي هو المخرج حين يتعذر الفحص التلقائي تقنياً (شبكة/تحويل غير متوقع).
        // English: Manual confirmation is the escape hatch when the automatic check is technically
        //          impossible (network issues / an unexpected redirect).
        overlay.querySelector('.alphacode-session-confirm').onclick = () => {
            overlay.remove();
            resolve(true);
        };

        overlay.querySelector('.alphacode-session-cancel').onclick = () => {
            overlay.remove();
            resolve(false);
        };
    });
}

async function requestStoreSessionCheck() {
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'CHECK_STORE_SESSION',
            addUrl: extractorConfig.SooqifyAddUrl || '',
        });
        return response || { loggedIn: false, checked: false };
    } catch (error) {
        return { loggedIn: false, checked: false, error: String(error?.message || error) };
    }
}

// Arabic: تُستدعى قبل أي استخراج أو رفع. تُرجع false إذا رفض المستخدم المتابعة.
// English: Called before any extraction or upload. Returns false if the operator declines.
async function ensureStoreSession() {
    if (storeSessionVerified) return true;

    const result = await requestStoreSessionCheck();
    if (result.loggedIn) {
        storeSessionVerified = true;
        acLog('ok', 'Sooqify admin session verified.');
        return true;
    }

    acLog('warn', `Sooqify admin session not verified: ${result.reason || result.error || 'unknown'}`);
    const detail = result.checked
        ? 'يبدو أنك غير مسجل دخول بلوحة تحكم سوقيفاي (تعذر العثور على نموذج إضافة المنتج).'
        : 'تعذر التحقق تلقائياً من جلسة لوحة سوقيفاي. هل أنت مسجل دخول بها؟';
    const proceed = await renderStoreSessionPrompt(detail);
    if (proceed) storeSessionVerified = true;
    return proceed;
}

// Arabic: دالة createModalShell جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: createModalShell is part of the extraction flow and can be adapted for another store.
function createModalShell() {
    const oldModal = document.getElementById('alphacode-modal-overlay');
    if (oldModal) oldModal.remove();

    const overlay = document.createElement('div');
    overlay.id = 'alphacode-modal-overlay';

    const modalBox = document.createElement('div');
    modalBox.className = 'alphacode-modal-box';
    modalBox.innerHTML = `
        <div class="alphacode-modal-title">
            <span>⚡ تأكيد سحب المنتج لـ 6amMart</span>
            <button class="alphacode-close-btn" type="button">&times;</button>
        </div>
        <div id="modal-content-area" class="alphacode-loading-box">
            <span class="alphacode-spinner"></span>
            جاري فحص الأرشيف وقراءة معرض الصور الكامل...
        </div>
    `;

    // Arabic: تطبيق الحجم الافتراضي المحفوظ مسبقًا (أو الحجم الأصلي إن لم يُحفظ بعد).
    // English: Apply the previously saved default size (or the original size if not yet saved).
    const savedW = localStorage.getItem('alphacode_modal_w');
    const savedH = localStorage.getItem('alphacode_modal_h');
    if (savedW) modalBox.style.width = savedW;
    if (savedH) modalBox.style.height = savedH;

    overlay.appendChild(modalBox);
    document.body.appendChild(overlay);
    modalBox.querySelector('.alphacode-close-btn').onclick = () => overlay.remove();

    // Arabic: تمدد شاشة المراجعة بسحب الحافة السفلية اليمنى + حفظ الحجم تلقائيًا.
    // English: Resize the review panel by dragging the bottom-right corner + auto-save size.
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'alphacode-resize-handle';
    modalBox.appendChild(resizeHandle);

    let isResizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
    resizeHandle.addEventListener('mousedown', e => {
        isResizing = true;
        startX = e.clientX; startY = e.clientY;
        startW = modalBox.offsetWidth; startH = modalBox.offsetHeight;
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        const newW = Math.max(360, startW + (e.clientX - startX));
        const newH = Math.max(300, startH + (e.clientY - startY));
        modalBox.style.width = `${newW}px`;
        modalBox.style.height = `${newH}px`;
    });
    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        localStorage.setItem('alphacode_modal_w', modalBox.style.width);
        localStorage.setItem('alphacode_modal_h', modalBox.style.height);
    });

    return { overlay, modalBox };
}

// Arabic: دالة openExtractionModal جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: openExtractionModal is part of the extraction flow and can be adapted for another store.
async function openExtractionModal(productBox, buttonElement) {
    const { overlay, modalBox } = createModalShell();
    const sourceText = extractSourceDescription(productBox);
    const originalProductName = extractOriginalProductName(productBox);
    const searchCode = extractSearchCode(productBox);
    const styleCode = extractStyleCode(sourceText);
    const displayedPrice = extractOriginalPrice(sourceText) || extractStructuredPrice(productBox);

    try {
        // Arabic: السعر المعروض قد لا يكون باليوان (العملة تتبع الـIP/VPN). نستعيد اليوان
        //         الحقيقي قبل أي حساب رسوم، ونعرف هل النتيجة موثوقة أو تحتاج إدخالاً يدوياً.
        // English: The displayed price may not be in CNY (the currency follows the IP/VPN).
        //          Recover the true CNY before any fee maths, and learn whether the result is
        //          trustworthy or needs a manual value.
        const priceCheck = await SUPPLIER_CURRENCY.resolveCnyPriceForPage(displayedPrice, sourceText);
        const originalPrice = priceCheck.cnyPrice;
        const [archiveData, images] = await Promise.all([
            checkArchive(searchCode, styleCode),
            extractAllImages(productBox, searchCode, styleCode)
        ]);

        if (!document.body.contains(overlay)) return;
        if (archiveData.last_added_code) lastAddedSearchCodeGlobal = archiveData.last_added_code;

        if (archiveData.exists) {
            updateButtonAsAdded(buttonElement, archiveData.id, archiveData.workflow_status || 'prepared');
            const contentArea = modalBox.querySelector('#modal-content-area');
            const statusLabel = archiveData.workflow_status === 'submitted'
                ? 'أُضيف المنتج إلى المتجر'
                : 'تم تجهيز المنتج محلياً ولم يُعتبر مضافاً للمتجر بعد';
            contentArea.className = '';
            contentArea.innerHTML = `
                <div class="alphacode-already-box">
                    <strong>⚠️ ${statusLabel}</strong><br>
                    ID المحلي: <b>${archiveData.id}</b><br>
                    الصور المحفوظة: <b>${archiveData.image_count || 0}</b><br>
                    المورد: <b>${archiveData.supplier_store_name || extractorConfig.SupplierStoreName || '-'}</b>
                </div>
                <div class="alphacode-actions alphacode-duplicate-actions">
                    <button class="alphacode-btn-submit" id="openPreparedProductBtn" type="button">فتح وتجهيز المنتج في Sooqify</button>
                    <button class="alphacode-btn-scroll" id="scrollToLastBtn" type="button">الذهاب إلى المنتج في الصفحة</button>
                </div>`;

            modalBox.querySelector('#openPreparedProductBtn').onclick = async event => {
                event.currentTarget.disabled = true;
                try {
                    const pendingResponse = await fetch(`${API_BASE_URL}/api/pending/${archiveData.id}`);
                    const pendingData = await pendingResponse.json();
                    if (!pendingResponse.ok || !pendingData.success) throw new Error(pendingData.error || 'تعذر تجهيز المنتج.');
                    await safeStorageSet({
                        pendingSooqifyProduct: pendingData.pending_product,
                        lastAlphaCodeProductId: archiveData.id
                    });
                    if (extractorConfig.AutoAddProduct) {
                        overlay.remove();

                        await submitPreparedProductInBackground(
                            pendingData.pending_product,
                            {
                                searchCode,
                                styleCode,
                            },
                        );

                        return;
                    }

                    const opened = await openStorePageSafely(extractorConfig.SooqifyAddUrl);
                    if (!opened) throw new Error('تعذر فتح صفحة المتجر. افتحها يدوياً من لوحة الإضافة.');
                    overlay.remove();
                } catch (error) {
                    event.currentTarget.disabled = false;
                    await logExtractorEvent('ERROR', 'reopen_prepared_product_failed', error.message, { product_id: archiveData.id });
                    contentArea.querySelector('.alphacode-already-box').insertAdjacentHTML('beforeend', `<br><span class="alphacode-inline-error">${error.message}</span>`);
                }
            };
            modalBox.querySelector('#scrollToLastBtn').onclick = () => {
                overlay.remove();
                scrollToLastProduct(lastAddedSearchCodeGlobal);
            };
            return;
        }

        renderNewProductForm({
            overlay,
            modalBox,
            buttonElement,
            sourceText,
            originalProductName,
            searchCode,
            styleCode,
            originalPrice,
            priceCheck,
            images
        });
    } catch (error) {
        const contentArea = modalBox.querySelector('#modal-content-area');
        contentArea.className = 'alphacode-error-box';
        contentArea.textContent = `تعذر تجهيز بيانات المنتج: ${error.message}`;
    }
}


// Arabic: إنشاء محدد صور يسمح باختيار صور المتجر وتحديد الصورة الرئيسية.
// English: Build a per-product image picker for store selection and main-image choice.
function initializeStoreImageSelector(modalBox, images, configuredLimit) {
    const grid = modalBox.querySelector('#alphacodeImageSelector');
    const counter = modalBox.querySelector('#alphacodeSelectedImageCounter');
    const limit = Math.max(1, Math.min(Number(configuredLimit || 6), 6));

    // Arabic: اختيار الصور 1 و2 و3 و4 و6 و10 تلقائياً.
    // English: Automatically select images 1, 2, 3, 4, 6, and 10.
    const preferredImageOrder = [
        0, // الصورة الأولى / First image
        1, // الصورة الثانية / Second image
        2, // الصورة الثالثة / Third image
        3, // الصورة الرابعة / Fourth image
        5, // الصورة السادسة / Sixth image
        9, // الصورة العاشرة / Tenth image
    ];

    // Arabic: تجاهل أي رقم غير موجود مع الالتزام بحد صور المتجر.
    // English: Ignore unavailable indexes while respecting the store image limit.
    const validImageOrder = preferredImageOrder
        .filter(index => (
            Number.isInteger(index)
            && index >= 0
            && index < images.length
        ))
        .slice(0, limit);

    // Arabic: إذا كان المنتج أقل من الصور المطلوبة، أكمل من الصور المتاحة دون تكرار.
    // English: If fewer preferred images exist, fill the remaining slots from available images without duplicates.
    for (
        let index = 0;
        index < images.length && validImageOrder.length < limit;
        index += 1
    ) {
        if (!validImageOrder.includes(index)) {
            validImageOrder.push(index);
        }
    }

    const selected = new Set(validImageOrder);

    // Arabic: الصورة العاشرة هي الرئيسية، وإن لم توجد تُستخدم آخر صورة مختارة.
    // English: Use the tenth image as main; otherwise use the last selected image.
    let mainIndex = images.length > 9
        ? 9
        : (validImageOrder[validImageOrder.length - 1] ?? 0);

    // Arabic: ضمان بقاء الصورة الرئيسية ضمن الصور الست المختارة.
    // English: Ensure the main image remains among the six selected images.
    if (!selected.has(mainIndex)) {
        const removable = Array.from(selected)
            .reverse()
            .find(index => index !== mainIndex);

        if (removable !== undefined && selected.size >= limit) {
            selected.delete(removable);
        }

        selected.add(mainIndex);
    }

    // Arabic: تحديث البطاقات والعداد بعد كل اختيار.
    // English: Refresh image cards and selection counter after every change.
    function refresh() {
        grid.querySelectorAll('.alphacode-image-choice').forEach(card => {
            const index = Number(card.dataset.index);
            const checkbox = card.querySelector('.alphacode-image-check');
            const radio = card.querySelector('.alphacode-image-main');
            checkbox.checked = selected.has(index);
            radio.checked = index === mainIndex;
            radio.disabled = !selected.has(index);
            card.classList.toggle('selected', selected.has(index));
            card.classList.toggle('main-image', index === mainIndex);
        });
        counter.textContent = `${selected.size} / ${limit} صور مختارة — الصورة الرئيسية رقم ${mainIndex + 1}`;
    }

    // Arabic: ضمان أن الصورة الرئيسية مختارة دائماً وعدم تجاوز حد المتجر.
    // English: Keep the main image selected and enforce the store image limit.
    function selectImage(index, shouldSelect) {
        if (shouldSelect) {
            if (!selected.has(index) && selected.size >= limit) {
                alert(`المتجر يقبل ${limit} صور فقط. ألغِ صورة محددة ثم اختر الصورة المطلوبة.`);
                return false;
            }
            selected.add(index);
        } else {
            if (index === mainIndex) {
                alert('لا يمكن إلغاء الصورة الرئيسية. اختر صورة رئيسية أخرى أولاً.');
                return false;
            }
            selected.delete(index);
        }
        refresh();
        return true;
    }

    images.forEach((url, index) => {
        const card = document.createElement('div');
        card.className = 'alphacode-image-choice';
        card.dataset.index = String(index);
        card.innerHTML = `
            <img loading="lazy" alt="Product image ${index + 1}">
            <div class="alphacode-image-choice-footer">
                <label><input class="alphacode-image-check" type="checkbox"> رفع</label>
                <label><input class="alphacode-image-main" type="radio" name="alphacode-main-image"> رئيسية</label>
                <strong>#${index + 1}</strong>
            </div>`;
        card.querySelector('img').src = url;
        card.querySelector('.alphacode-image-check').addEventListener('change', event => {
            if (!selectImage(index, event.target.checked)) event.target.checked = selected.has(index);
        });
        card.querySelector('.alphacode-image-main').addEventListener('change', event => {
            if (!event.target.checked) return;
            if (!selected.has(index)) selectImage(index, true);
            mainIndex = index;
            refresh();
        });
        grid.appendChild(card);
    });

    refresh();
    return {
        getSelectedIndexes() {
            const ordered = Array.from(selected).sort((a, b) => a - b);
            return [mainIndex, ...ordered.filter(index => index !== mainIndex)].slice(0, limit);
        },
        getMainIndex() { return mainIndex; },
        getLimit() { return limit; },
    };
}

// Arabic: شريط حالة السعر — يشرح للمستخدم بأي عملة كان السعر معروضاً وكيف حُوّل لليوان،
//         ويطلب إدخالاً يدوياً صريحاً عند الشك بدل تمرير رقم غير موثوق للمتجر.
// English: Price status banner - tells the operator which currency the price was displayed in
//          and how it was converted to CNY, and demands an explicit manual value when in doubt
//          instead of passing an untrusted number on to the store.
function buildPriceCheckBanner(priceCheck, scope = 'single') {
    if (!priceCheck) return '';
    const hint = priceCheck.titleHint
        ? ` سعر العنوان: <strong>${priceCheck.titleHint.value}</strong> يوان (نمط ${escapeHtml(priceCheck.titleHint.pattern)}).`
        : '';

    if (priceCheck.status === 'needs_manual') {
        return `<div class="alphacode-price-alert alphacode-price-alert-danger">
            <strong>⚠️ تعذّر التأكد من السعر باليوان — الرجاء إدخاله يدوياً.</strong>
            <div>${escapeHtml(priceCheck.reason || '')}</div>
            <div>الرقم المستخرج تلقائياً <em>للمرجع فقط</em>: ${priceCheck.displayedPrice} ${escapeHtml(priceCheck.currencyCode)}${priceCheck.converted ? ` ← ${priceCheck.cnyPrice} يوان (سعر صرف ${priceCheck.exchangeRate})` : ''}.${hint}</div>
            <label class="alphacode-price-confirm"><input type="checkbox" ${scope === 'batch' ? 'class="batch-price-confirm"' : 'id="modPriceConfirm"'}> أؤكّد أن السعر المكتوب بالأعلى صحيح باليوان</label>
        </div>`;
    }
    if (priceCheck.status === 'converted_confirmed') {
        return `<div class="alphacode-price-alert alphacode-price-alert-ok">
            ✔ السعر كان معروضاً بـ<strong>${escapeHtml(priceCheck.currencyCode)}</strong>${priceCheck.ipCountry ? ` (IP: ${escapeHtml(priceCheck.ipCountry)})` : ''} =
            ${priceCheck.displayedPrice} ← حُوّل إلى <strong>${priceCheck.cnyPrice} يوان</strong> بسعر صرف الموقع ${priceCheck.exchangeRate}.${hint}
        </div>`;
    }
    if (priceCheck.note) {
        return `<div class="alphacode-price-alert alphacode-price-alert-warn">⚠️ ${escapeHtml(priceCheck.note)}${hint}</div>`;
    }
    return '';
}

// Arabic: بناء نافذة مراجعة ثنائية اللغة تشمل البراند والمقاسات قبل الحفظ.
// English: Render the bilingual review modal with brand and size controls.
function renderNewProductForm(context) {
    const {
        overlay,
        modalBox,
        buttonElement,
        sourceText,
        originalProductName,
        searchCode,
        styleCode,
        originalPrice,
        priceCheck,
        images,
    } = context;

    const detectedProductType = detectProductType(sourceText);
    // Arabic: المعاينة تستخدم الآن نفس الدالة المشتركة لمسار الإرسال الفعلي
    //         (computeFeeAndPrice) بدل نسخة مكررة من نفس الشرط. كانت النسخة المكررة هنا
    //         صحيحة رياضياً، لكن وجودها هو ما سمح تاريخياً بانحراف المعاينة عن الفعلي كل
    //         مرة يُعدَّل فيها مسار واحد فقط - فأُزيلت من الجذر.
    // English: The preview now uses the very same shared helper as the real submission path
    //          (computeFeeAndPrice) instead of a duplicated copy of the same condition. The
    //          duplicate here was arithmetically correct, but its existence is what
    //          historically let the preview drift from the real price whenever only one path
    //          was edited - so it is removed at the root.
    const { addedFee, priceAfterFee, priceSAR } = computeFeeAndPrice(
        originalPrice,
        detectedProductType,
        extractorConfig,
    );
    const exchangeRate = Number(extractorConfig.ExchangeRate || 0);
    const sizes = extractSizes(sourceText);
    // Arabic: لا نص افتراضي - الحقول تبدأ فاضية ويكتبها المستخدم بنفسه (أو يلصق قالب JSON).
    //         كانت تُملأ سابقاً بصياغة احتياطية مولّدة، وحُذفت بطلب المستخدم.
    // English: No default copy - the fields start empty for the operator to fill in (or paste a
    //          JSON template). They used to be pre-filled with generated fallback text, removed
    //          at the operator's request.
    const fallbackNameEN = '';
    const fallbackDescriptionEN = '';
    const fallbackNameAR = '';
    const fallbackDescriptionAR = '';
    const fallbackBrand = canonicalBrandName(sourceText);

    const contentArea = modalBox.querySelector('#modal-content-area');
    contentArea.className = '';
    contentArea.innerHTML = `
        <section class="alphacode-json-template-section">
            <div class="alphacode-json-template-heading">
                <div><strong>قالب محتوى JSON</strong><small>ألصق قالب الاسم والوصف جاهزاً ثم اضغط قبول القالب.</small></div>
                <span class="alphacode-json-template-status" id="externalCopyJsonStatus"></span>
            </div>
            <textarea id="externalCopyJson" class="alphacode-json-template-input" dir="ltr" spellcheck="false" placeholder='{"name_en":"","description_en":"","name_ar":"","description_ar":""}'></textarea>
            <div class="alphacode-json-template-actions">
                <button type="button" class="primary" id="applyExternalCopyJson">قبول القالب</button>
                <button type="button" id="copyEmptyExternalCopyJson">نسخ القالب الفارغ</button>
                <button type="button" id="copyOriginalNameJson">نسخ الاسم الأصلي</button>
            </div>
        </section>
        <div class="alphacode-language-grid">
            <div>
                <div class="alphacode-field alphacode-ltr-field">
                    <label style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <span>اسم المنتج بالإنجليزية:</span>
                        <button class="alphacode-copy-btn" id="copyOriginalNameBtn" type="button" title="نسخ اسم المنتج الأصلي من موقع المورد" style="min-width:32px;padding:3px 7px;font-size:13px;line-height:1;">📋</button>
                    </label>
                    <input type="text" id="modNameEN" dir="ltr">
                </div>
                <div class="alphacode-field alphacode-ltr-field"><label>الوصف بالإنجليزية:</label><textarea id="modDescEN" dir="ltr"></textarea></div>
            </div>
            <div>
                <div class="alphacode-field"><label>اسم المنتج بالعربية:</label><input type="text" id="modNameAR" dir="rtl"></div>
                <div class="alphacode-field"><label>الوصف بالعربية:</label><textarea id="modDescAR" dir="rtl"></textarea></div>
            </div>
        </div>
        <div class="alphacode-inline-grid">
            <div class="alphacode-field"><label>اسم البراند:</label><input type="text" id="modBrandName" dir="ltr"></div>
            <div class="alphacode-field"><label>Brand ID:</label><input type="number" id="modBrandId"></div>
            <div class="alphacode-field alphacode-wide-field"><label>المقاسات — افصل بينها بفاصلة ويمكن تعديلها:</label><input type="text" id="modSizes" dir="ltr"></div>
        </div>
        <div class="alphacode-note">كل مقاس سيحصل على السعر نفسه وكمية المخزون نفسها (${Number(extractorConfig.Stock || 0)}).</div>
        <section class="alphacode-image-selector-section">
            <div class="alphacode-image-selector-heading">
                <div><strong>اختيار صور المتجر</strong><small>سيتم تنزيل كل الصور محلياً، ويمكن رفع ${Math.min(Number(extractorConfig.StoreImageLimit || 6), 6)} صور فقط إلى المتجر.</small></div>
                <span id="alphacodeSelectedImageCounter"></span>
            </div>
            <div id="alphacodeImageSelector" class="alphacode-image-selector-grid"></div>
        </section>
        ${buildPriceCheckBanner(priceCheck)}
        <div class="alphacode-price-row">
            <div class="alphacode-field"><label>السعر الأساسي (يوان):</label><input type="number" id="modPrice"></div>
            <div class="alphacode-field"><label>بعد إضافة ${addedFee} يوان:</label><input type="number" id="modPriceFee" disabled></div>
        </div>
        <div class="alphacode-readonly-group">
            <div class="alphacode-readonly-item"><span>نوع المنتج:</span><strong class="alphacode-success-text">${PRODUCT_TYPES.productTypeLabel(detectedProductType)}</strong></div>
            <div class="alphacode-readonly-item"><span>السعر بعد المصارفة:</span><strong id="displaySAR" class="alphacode-success-text"></strong></div>
            <div class="alphacode-readonly-item"><span>Category / SubCategory:</span><strong>${PRODUCT_TYPES.productTypeCategoryId(detectedProductType, extractorConfig)} / ${PRODUCT_TYPES.productTypeSubCategoryId(detectedProductType, extractorConfig) ?? 'بدون (None)'}</strong></div>
            <div class="alphacode-readonly-item"><span>صور المعرض الكامل:</span><strong class="alphacode-image-count">${images.length} صور</strong></div>
            <div class="alphacode-readonly-item"><span>متجر المورد:</span><strong>${normalizeText(extractorConfig.SupplierStoreName) || 'غير محدد'} / ${resolveSupplierStoreId() || 'لا يوجد ID'}</strong></div>
            <div class="alphacode-readonly-item"><span>Search Code:</span><strong>${searchCode || 'غير موجود'}</strong></div>
            <div class="alphacode-readonly-item alphacode-code-row"><span>Style Code / Item No.:</span><div><input id="modStyleCode" type="text" placeholder="ادخل كود الستايل إن وجد" style="min-width:140px;padding:6px 8px;border-radius:6px;border:1px solid #ccd5e3;" value="${escapeHtml(styleCode || '')}"><button class="alphacode-copy-btn" id="copyStyleBtn" type="button">📋 نسخ</button></div></div>
            <div class="alphacode-readonly-item"><span>الصور:</span><strong>JPG / ${extractorConfig.ImageQuality}% / ${extractorConfig.ImageMaxDimension}px</strong></div>
        </div>
        <div class="alphacode-actions">
            <button class="alphacode-btn-submit" id="confirmExtractBtn" type="button">🚀 حفظ وتجهيز للوحة المتجر</button>
            <button class="alphacode-btn-cancel" id="cancelBtn" type="button">إلغاء</button>
        </div>`;

    const fields = {
        nameEN: modalBox.querySelector('#modNameEN'),
        descEN: modalBox.querySelector('#modDescEN'),
        nameAR: modalBox.querySelector('#modNameAR'),
        descAR: modalBox.querySelector('#modDescAR'),
        brandName: modalBox.querySelector('#modBrandName'),
        brandId: modalBox.querySelector('#modBrandId'),
        sizes: modalBox.querySelector('#modSizes'),
        price: modalBox.querySelector('#modPrice'),
        fee: modalBox.querySelector('#modPriceFee'),
        sar: modalBox.querySelector('#displaySAR'),
    };

    fields.nameEN.value = fallbackNameEN;
    fields.descEN.value = fallbackDescriptionEN;
    fields.nameAR.value = fallbackNameAR;
    fields.descAR.value = fallbackDescriptionAR;
    fields.brandName.value = fallbackBrand;
    fields.brandId.value = resolveBrandId(fallbackBrand);
    fields.sizes.value = sizes.join(', ');
    fields.price.value = originalPrice;
    fields.fee.value = priceAfterFee;
    fields.sar.textContent = `${priceSAR} ريال`;

    const imageSelection = initializeStoreImageSelector(
        modalBox,
        images,
        extractorConfig.StoreImageLimit || 6,
    );

    bindExternalCopyTemplateControls({
        root: modalBox,
        textarea: modalBox.querySelector('#externalCopyJson'),
        applyButton: modalBox.querySelector('#applyExternalCopyJson'),
        copyEmptyButton: modalBox.querySelector('#copyEmptyExternalCopyJson'),
        copyOriginalButton: modalBox.querySelector('#copyOriginalNameJson'),
        statusElement: modalBox.querySelector('#externalCopyJsonStatus'),
        fields,
        originalProductName: originalProductName || sourceText,
    });

    fields.styleCode = modalBox.querySelector('#modStyleCode');
    fields.brandName.addEventListener('input', () => {
        fields.brandId.value = resolveBrandId(fields.brandName.value);
    });

    fields.price.addEventListener('input', () => {
        const base = parseFloat(fields.price.value) || 0;
        const afterFee = base + addedFee;
        fields.fee.value = afterFee;
        fields.sar.textContent = `${Math.round(afterFee * exchangeRate)} ريال`;
    });

    modalBox.querySelector('#copyOriginalNameBtn').onclick = async event => {
        const copied = await copyTextToClipboard(originalProductName || sourceText);
        event.currentTarget.textContent = copied ? '✔' : '✖';
        setTimeout(() => {
            if (event.currentTarget?.isConnected) {
                event.currentTarget.textContent = '📋';
            }
        }, 1800);
    };

    modalBox.querySelector('#copyStyleBtn').onclick = async event => {
        const value = (modalBox.querySelector('#modStyleCode')?.value || styleCode || '').trim();
        const copied = await copyTextToClipboard(value);
        event.currentTarget.textContent = copied ? '✔ تم النسخ' : 'تعذر النسخ';
        setTimeout(() => { if (event.currentTarget?.isConnected) event.currentTarget.textContent = '📋 نسخ'; }, 1400);
    };

    modalBox.querySelector('#cancelBtn').onclick = () => overlay.remove();

    // Arabic: بوابة السعر — عند الشك لا يُسمح بالحفظ إلا بعد إدخال/تأكيد السعر يدوياً.
    //         هذا يمنع تكرار ما حصل: منتج سعره 300 يوان طلع بـ3839 ريال لأن الرقم المعروض
    //         كان بالين الياباني ومرّ للمتجر بلا اعتراض.
    // English: Price gate - when in doubt, saving is blocked until the price is entered or
    //          confirmed manually. This prevents a repeat of the reported failure: a 300 CNY
    //          product reaching the store as 3839 SAR because the displayed number was in
    //          Japanese yen and passed through unchallenged.
    const priceConfirmBox = modalBox.querySelector('#modPriceConfirm');
    const submitBtn = modalBox.querySelector('#confirmExtractBtn');
    const priceGateActive = Boolean(priceCheck && priceCheck.status === 'needs_manual');

    const refreshPriceGate = () => {
        if (!priceGateActive) return;
        const typedPrice = parseFloat(fields.price.value) || 0;
        const confirmed = Boolean(priceConfirmBox?.checked) && typedPrice > 0;
        submitBtn.disabled = !confirmed;
        submitBtn.title = confirmed
            ? ''
            : 'أدخل السعر باليوان ثم أكّد الخانة أعلاه للمتابعة.';
    };
    if (priceGateActive) {
        priceConfirmBox?.addEventListener('change', refreshPriceGate);
        fields.price.addEventListener('input', refreshPriceGate);
        refreshPriceGate();
    }

    submitBtn.onclick = () => submitProduct({
        overlay,
        modalBox,
        buttonElement,
        sourceText,
        originalProductName,
        searchCode,
        styleCode: (modalBox.querySelector('#modStyleCode')?.value || '').trim(),
        images,
        fields,
        imageSelection,
        productType: detectedProductType,
    });
}

// Arabic: إرسال المنتج إلى Flask ثم حفظ حزمة التعبئة في تخزين الإضافة.
// English: Save through Flask, then persist the Sooqify autofill package in extension storage.

// Arabic: التحقق من حالة المنتج في الأرشيف المحلي بعد الإضافة.
// English: Verify the archived workflow state after submission.
async function verifyAutomaticSubmission(
    productId,
    detailsElement,
    button,
) {
    button.disabled = true;
    button.textContent = 'جارٍ التحقق...';

    try {
        const response = await fetch(
            `${API_BASE_URL}/api/archive/product/${Number(productId)}`,
            {
                cache: 'no-store',
            },
        );

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(
                data.error || 'تعذر قراءة حالة المنتج.',
            );
        }

        const status = (
            data.product?.workflow_status
            || data.product?.store_submission_status
            || 'غير محدد'
        );

        const verified = status === 'submitted';
        const workflowDetails = (
            data.product?.workflow_details || {}
        );

        detailsElement.textContent = verified
            ? `تم التحقق: المنتج مضاف بحالة submitted${workflowDetails.store_product_id ? `، ورقم المتجر ${workflowDetails.store_product_id}` : ''}.`
            : `الحالة الحالية: ${status}.`;

        button.textContent = verified
            ? '✅ تمت الإضافة'
            : 'إعادة التحقق';

        return verified;

    } catch (error) {
        detailsElement.textContent = (
            `فشل التحقق: ${error.message}`
        );
        button.textContent = 'إعادة التحقق';
        return false;

    } finally {
        button.disabled = false;
    }
}

// Arabic: عرض حالة انتظار بسيطة أثناء تنفيذ الإضافة داخل تبويب Sooqify غير نشط.
// English: Show a lightweight waiting state while an inactive Sooqify tab performs the submission.
async function renderAutomaticSubmissionProgress(
    product,
    context = {},
) {
    if (activeAutomaticResultOverlay?.isConnected) {
        activeAutomaticResultOverlay.remove();
    }

    const { overlay, modalBox } = createModalShell();
    activeAutomaticResultOverlay = overlay;

    const productId = Number(
        product?.local_id
        || context.productId
        || 0,
    );

    const styleCode = String(
        context.styleCode
        || product?.style_code
        || '',
    );

    const contentArea = modalBox.querySelector(
        '#modal-content-area',
    );

    contentArea.className = '';
    contentArea.innerHTML = `
        <div class="alphacode-already-box">
            <strong>⏳ جارٍ إضافة المنتج إلى Sooqify في الخلفية</strong><br>
            ID المحلي: <b>${productId || '-'}</b><br>
            Style Code: <b>${escapeHtml(styleCode || '-')}</b><br>
            <span>يمكنك البقاء في صفحة المورد. ستظهر النتيجة هنا فور انتهاء الإضافة.</span>
        </div>`;

    modalBox.querySelector(
        '.alphacode-close-btn',
    ).style.display = 'none';
}

// Arabic: عرض نتيجة الإضافة الخلفية، مع زر استمرار أكبر وزر تحقق أصغر.
// English: Show the background result with a larger Continue button and a smaller Verify button.
async function renderAutomaticSubmissionResult(
    result,
    context = {},
) {
    if (activeAutomaticResultOverlay?.isConnected) {
        activeAutomaticResultOverlay.remove();
    }

    const { overlay, modalBox } = createModalShell();
    activeAutomaticResultOverlay = overlay;

    const contentArea = modalBox.querySelector(
        '#modal-content-area',
    );

    const submitted = Boolean(result?.success);
    const productId = Number(
        result?.productId
        || context.product?.local_id
        || context.productId
        || 0,
    );

    const searchCode = String(
        result?.searchCode
        || context.searchCode
        || context.product?.search_code
        || '',
    );

    const styleCode = String(
        result?.styleCode
        || context.styleCode
        || context.product?.style_code
        || '',
    );

    const closeResult = () => {
        if (overlay.isConnected) overlay.remove();
        if (activeAutomaticResultOverlay === overlay) {
            activeAutomaticResultOverlay = null;
        }
    };

    contentArea.className = '';

    if (submitted) {
        contentArea.innerHTML = `
            <div class="alphacode-already-box">
                <strong>✅ تم إضافة المنتج إلى Sooqify بنجاح</strong><br>
                ID المحلي: <b>${productId || '-'}</b><br>
                ${result.storeProductId ? `رقم المنتج في المتجر: <b>${result.storeProductId}</b><br>` : ''}
                Style Code: <b>${escapeHtml(styleCode || '-')}</b><br>
                <span id="alphacode-auto-result-details">تم إرسال المنتج في الخلفية دون مغادرة صفحة المورد.</span>
            </div>
            <div class="alphacode-actions" style="display:flex;gap:10px;direction:ltr;">
                <button class="alphacode-btn-scroll" id="alphacode-auto-verify" type="button" style="flex:1;">التحقق من الإضافة</button>
                <button class="alphacode-btn-submit" id="alphacode-auto-continue" type="button" style="flex:2;font-weight:700;">استمرار</button>
            </div>`;

        const details = modalBox.querySelector(
            '#alphacode-auto-result-details',
        );

        const verifyButton = modalBox.querySelector(
            '#alphacode-auto-verify',
        );

        const continueButton = modalBox.querySelector(
            '#alphacode-auto-continue',
        );

        verifyButton.onclick = () => (
            verifyAutomaticSubmission(
                productId,
                details,
                verifyButton,
            )
        );

        continueButton.onclick = async () => {
            closeResult();
            if (searchCode) {
                await scrollToLastProduct(searchCode);
            }
        };

        modalBox.querySelector(
            '.alphacode-close-btn',
        ).onclick = closeResult;

        return;
    }

    contentArea.innerHTML = `
        <div class="alphacode-already-box">
            <strong>⚠️ تعذر إضافة المنتج في الخلفية</strong><br>
            ID المحلي: <b>${productId || '-'}</b><br>
            Style Code: <b>${escapeHtml(styleCode || '-')}</b><br>
            <span id="alphacode-auto-result-details">${escapeHtml(result?.error || 'حدث خطأ غير معروف.')}</span>
        </div>
        <div class="alphacode-actions" style="display:flex;gap:10px;direction:ltr;">
            <button class="alphacode-btn-cancel" id="alphacode-auto-close" type="button" style="flex:1;">إغلاق</button>
            <button class="alphacode-btn-submit" id="alphacode-auto-retry" type="button" style="flex:2;font-weight:700;">إعادة المحاولة في تبويب جديد</button>
        </div>`;

    const retryButton = modalBox.querySelector(
        '#alphacode-auto-retry',
    );

    const details = modalBox.querySelector(
        '#alphacode-auto-result-details',
    );

    const closeButton = modalBox.querySelector(
        '#alphacode-auto-close',
    );

    const product = context.product
        || (await fetch(
            `${API_BASE_URL}/api/pending/${productId}`,
            { cache: 'no-store' },
        ).then(async response => {
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(
                    data.error || 'تعذر تجهيز منتج إعادة المحاولة.',
                );
            }
            return data.pending_product;
        }).catch(error => {
            details.textContent = error.message;
            return null;
        }));

    closeButton.onclick = closeResult;
    modalBox.querySelector(
        '.alphacode-close-btn',
    ).onclick = closeResult;

    retryButton.onclick = async () => {
        if (!product) {
            details.textContent = (
                'بيانات المنتج غير متاحة لإعادة المحاولة.'
            );
            return;
        }

        retryButton.disabled = true;
        retryButton.textContent = (
            'جارٍ فتح تبويب إعادة المحاولة...'
        );

        await safeStorageSet({
            pendingSooqifyProduct: product,
            lastAlphaCodeProductId: product.local_id,
        });

        const response = await safeRuntimeMessage({
            action: 'OPEN_FALLBACK_SUBMISSION_TAB',
            product,
            addUrl: extractorConfig.SooqifyAddUrl,
            searchCode,
            styleCode,
        });

        if (!response?.success) {
            retryButton.disabled = false;
            retryButton.textContent = (
                'إعادة المحاولة في تبويب جديد'
            );
            details.textContent = (
                response?.error
                || 'تعذر فتح تبويب إعادة المحاولة.'
            );
            return;
        }

        details.textContent = (
            'تم فتح تبويب مؤقت. ستتم تعبئة المنتج وإضافته ثم سيُغلق التبويب تلقائياً.'
        );
        retryButton.textContent = 'جارٍ تنفيذ المحاولة...';
    };
}

// Arabic: تشغيل الإضافة في تبويب غير نشط مع انتظار النتيجة عبر رسالة لاحقة من Service Worker.
// English: Run submission in an inactive tab and receive the final result asynchronously from the service worker.
async function submitPreparedProductInBackground(
    product,
    context = {},
) {
    const productId = Number(product?.local_id || 0);

    automaticSubmissionContexts.set(
        productId,
        {
            ...context,
            product,
        },
    );

    const response = await safeRuntimeMessage({
        action: 'SUBMIT_PRODUCT_BACKGROUND',
        product,
        addUrl: extractorConfig.SooqifyAddUrl,
        searchCode: context.searchCode || product.search_code || '',
        styleCode: context.styleCode || product.style_code || '',
    });

    if (!response?.success) {
        automaticSubmissionContexts.delete(productId);

        await renderAutomaticSubmissionResult(
            {
                success: false,
                productId,
                error: response?.error
                    || 'تعذر تشغيل تبويب الإضافة الخلفية.',
            },
            {
                ...context,
                product,
            },
        );

        return false;
    }

    await renderAutomaticSubmissionProgress(
        product,
        context,
    );

    return true;
}

// Arabic: نواة مشتركة لحساب الرسم والسعر حسب نوع المنتج - كانت مكررة حرفياً بين
//         submitProduct وprepareBatchDraftForStore (وهذا التكرار كان السبب الجذري
//         لتكرار أخطاء الرسوم التاريخية: تصليح مسار وحيد ينسى الآخر). أي تعديل مستقبلي
//         على منطق الرسم/السعر يصير هنا فقط.
// English: Shared core for computing the fee and price by product type - was duplicated
//          verbatim between submitProduct and prepareBatchDraftForStore (this duplication
//          was the root cause of the historical fee bugs: fixing one path forgot the
//          other). Any future change to the fee/price logic goes here only.
// Arabic: بعد إدخال ملفات تعريف نوع المنتج (product_types.js) لم يعد هنا أي شرط
//         if (type === 'watches') - الرسم يُقرأ من ملف التعريف الموحّد. النتيجة الرياضية
//         مطابقة تماماً للصيغة السابقة: (السعر + رسم النوع) × سعر الصرف، مقرَّباً.
// English: With the product type profiles in place (product_types.js) there is no
//          `if (type === 'watches')` here any more - the fee comes from the unified
//          profile. The arithmetic is identical to the previous formula:
//          (price + type fee) x exchange rate, rounded.
function computeFeeAndPrice(originalPrice, productType, config) {
    return PRODUCT_TYPES.computeProductTypePrice(originalPrice, productType, config);
}

async function submitProduct(context) {
    const {
        overlay,
        modalBox,
        buttonElement,
        searchCode,
        styleCode,
        originalProductName,
        images,
        fields,
        imageSelection,
        productType,
    } = context;

    const submitButton = modalBox.querySelector('#confirmExtractBtn');
    submitButton.textContent = `⏳ تنزيل ${images.length} صور وحفظ المنتج...`;
    submitButton.disabled = true;

    const originalPrice = parseFloat(fields.price.value) || 0;
    const { priceAfterFee: finalFeePrice, priceSAR: finalSar } = computeFeeAndPrice(
        originalPrice,
        productType,
        extractorConfig,
    );
    const sizes = uniqueSizes(fields.sizes.value.split(/[,،\s]+/).filter(Boolean));

    const payload = {
        Name: fields.nameEN.value.trim(),
        Description: fields.descEN.value.trim(),
        NameEN: fields.nameEN.value.trim(),
        DescriptionEN: fields.descEN.value.trim(),
        NameAR: fields.nameAR.value.trim(),
        DescriptionAR: fields.descAR.value.trim(),
        BrandName: canonicalBrandName(fields.brandName.value),
        BrandId: Number(fields.brandId.value || 0),
        ProductType: PRODUCT_TYPES.resolveProductType(productType),
        Sizes: sizes,
        OriginalPrice: originalPrice,
        PriceAfterFee: finalFeePrice,
        PriceSAR: finalSar,
        SearchCode: searchCode || 'NONE',
        StyleCode: styleCode,
        Images: images,
        SelectedImageIndexes: imageSelection.getSelectedIndexes(),
        MainImageIndex: imageSelection.getMainIndex(),
        StoreImageLimit: imageSelection.getLimit(),
        SourceUrl: window.location.href,
        SupplierStoreName: extractorConfig.SupplierStoreName || '',
        SupplierStoreId: resolveSupplierStoreId(),
        // Arabic: نفس إصلاح الدفعة بالضبط - الباك اند يقرأ ProductType من جوا Settings حصراً،
        //         فنفرض هنا القيمة الصحيحة بدل توريث extractorConfig.ProductType العام كما هو
        //         (واللي ممكن يكون عالق على "watches" من جلسة سابقة).
        // English: Same fix as the batch path exactly - the backend reads ProductType only
        //          from inside Settings, so we force the correct value here instead of
        //          inheriting extractorConfig.ProductType as-is (which may be stuck on
        //          "watches" from an earlier session).
        Settings: { ...extractorConfig, ProductType: PRODUCT_TYPES.resolveProductType(productType) },
    };

    try {
        const response = await fetch(`${API_BASE_URL}/api/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const result = await response.json();
        if (response.status === 409 && result.exists) {
            updateButtonAsAdded(buttonElement, result.id, result.workflow_status || 'prepared');
            throw new Error(`المنتج مجهز مسبقاً في ID رقم ${result.id}. استخدم زر فتح المنتج المجهز.`);
        }
        if (!response.ok || !result.success) {
            throw new Error(result.error || `Save request failed (${response.status})`);
        }

        const stored = await safeStorageSet({
            pendingSooqifyProduct: result.pending_product,
            lastAlphaCodeProductId: result.id,
        });

        await logExtractorEvent(
            'INFO',
            'product_saved_for_store',
            'Product saved and prepared for Sooqify.',
            {
                product_id: result.id,
                downloaded_images: result.downloaded_images,
                requested_images: result.requested_images,
                pending_saved_to_extension: stored,
                automatic_add: Boolean(extractorConfig.AutoAddProduct),
            },
        );

        updateButtonAsAdded(buttonElement, result.id, 'prepared');
        lastAddedSearchCodeGlobal = searchCode;

        if (extractorConfig.AutoAddProduct) {
            submitButton.textContent = (
                'جارٍ إضافة المنتج في الخلفية...'
            );

            overlay.remove();

            await submitPreparedProductInBackground(
                result.pending_product,
                {
                    searchCode,
                    styleCode,
                },
            );

            return;
        }

        overlay.remove();
        const openStore = confirm(
            `تم تجهيز المنتج رقم ${result.id} وحفظ ${result.downloaded_images} صور.\n`
            + 'اضغط موافق لفتح صفحة إضافة المنتج في Sooqify.',
        );

        if (openStore) {
            await openStorePageSafely(extractorConfig.SooqifyAddUrl);
        }
    } catch (error) {
        await logExtractorEvent('ERROR', 'product_save_failed', error.message, {
            search_code: searchCode,
            style_code: styleCode,
            image_count: images.length,
            stack: error.stack || '',
        });

        const contextInvalidated = /Extension context invalidated/i.test(String(error.message || error));
        if (!contextInvalidated) alert(`❌ حدث خطأ: ${error.message}`);
        submitButton.textContent = '🚀 حفظ وتجهيز للوحة المتجر';
        submitButton.disabled = false;
    }
}

// Arabic: دالة scrollToLastProduct جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: scrollToLastProduct is part of the extraction flow and can be adapted for another store.
async function scrollToLastProduct(targetSearchCode, options = {}) {
    const wantedCode = String(targetSearchCode || '').trim();
    if (!wantedCode) {
        alert('لم يتم العثور على رمز لآخر منتج مضاف في الأرشيف!');
        return false;
    }

    const findCard = () => {
        const cards = Array.from(document.querySelectorAll(PRODUCT_CARD_SELECTOR));
        const card = cards.find(item => String(extractSearchCode(item) || '') === wantedCode) || null;
        return { card, cards };
    };

    const findLoadMoreButton = () => Array.from(
        document.querySelectorAll('button, a, [role="button"]'),
    ).find(element => {
        if (!element || !element.offsetParent) return false;
        const text = normalizeText(element.textContent).toLowerCase();
        return /load more|more|تحميل المزيد|عرض المزيد|المزيد|加载更多|更多/.test(text);
    }) || null;

    let stagnantRounds = 0;
    const maximumRounds = Number(options.maximumRounds || 80);

    for (let round = 0; round < maximumRounds; round += 1) {
        const { card, cards } = findCard();
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('alphacode-highlight-card');
            setTimeout(() => card.classList.remove('alphacode-highlight-card'), 5000);
            return true;
        }

        const oldHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
        );
        const oldCount = cards.length;
        const loadMoreButton = findLoadMoreButton();

        if (loadMoreButton) {
            loadMoreButton.click();
        } else {
            window.scrollTo({ top: oldHeight, behavior: 'smooth' });
        }

        const loaded = await waitForCondition(() => {
            const newHeight = Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight,
            );
            const newCount = document.querySelectorAll(PRODUCT_CARD_SELECTOR).length;
            return newHeight > oldHeight || newCount > oldCount ? true : null;
        }, 4500, 180);

        if (loaded) {
            stagnantRounds = 0;
            await sleep(250);
            continue;
        }

        stagnantRounds += 1;
        window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: 'smooth' });
        await sleep(900);

        if (stagnantRounds >= 5) break;
    }

    alert(`تم تمرير الصفحة وتحميل المنتجات المتاحة، لكن لم يتم العثور على Search Code رقم (${wantedCode}).`);
    return false;
}




// =========================================================
// AlphaCode Batch Product Queue
// Arabic: تحديد عدة منتجات، مراجعتها، تجهيزها بخط أنابيب، ثم إرسالها بالتتابع.
// English: Select, review, pipeline-prepare, and sequentially submit multiple products.
// =========================================================

function stableBatchHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function getBatchPageIdentity() {
    return `${window.location.origin}${window.location.pathname}`;
}

function getBatchCardKey(card) {
    // Arabic: لا نعتمد على data قديمة لأن React قد يعيد استخدام العنصر لمنتج آخر.
    // English: Never trust cached dataset values because React may recycle the node for another product.
    const sourceText = extractSourceDescription(card);
    const searchCode = extractSearchCode(card);
    const styleCode = extractStyleCode(sourceText);
    const firstImage = normalizeImageUrl(
        card.querySelector('img')?.currentSrc
        || card.querySelector('img')?.src
        || '',
    );

    const key = isValidCode(searchCode)
        ? `search:${String(searchCode).toUpperCase()}`
        : (isValidCode(styleCode)
            ? `style:${String(styleCode).toUpperCase()}:${stableBatchHash(sourceText.slice(0, 260))}`
            : `text:${stableBatchHash(`${sourceText.slice(0, 900)}|${firstImage}`)}`);

    card.dataset.alphacodeBatchKey = key;
    return key;
}

function serializeBatchSelectionEntry(entry) {
    return {
        key: entry.key,
        sourceText: entry.sourceText || '',
        originalProductName: entry.originalProductName || '',
        searchCode: entry.searchCode || '',
        styleCode: entry.styleCode || '',
        originalPrice: Number(entry.originalPrice || 0),
        sizes: Array.isArray(entry.sizes) ? entry.sizes : [],
        images: Array.isArray(entry.images) ? entry.images : [],
        selectedAt: Number(entry.selectedAt || Date.now()),
    };
}

function persistBatchSelections() {
    if (extractorConfig.BatchSelectionPersistence === false) return;
    try {
        sessionStorage.setItem(
            BATCH_SELECTION_SESSION_KEY,
            JSON.stringify({
                pageIdentity: getBatchPageIdentity(),
                entries: Array.from(selectedBatchProducts.values()).map(serializeBatchSelectionEntry),
            }),
        );
    } catch (_) { }
}

function restoreBatchSelections() {
    if (extractorConfig.BatchSelectionPersistence === false) return;
    try {
        const stored = JSON.parse(sessionStorage.getItem(BATCH_SELECTION_SESSION_KEY) || 'null');
        if (!stored || stored.pageIdentity !== getBatchPageIdentity() || !Array.isArray(stored.entries)) return;
        for (const rawEntry of stored.entries) {
            if (!rawEntry?.key) continue;
            selectedBatchProducts.set(rawEntry.key, {
                ...rawEntry,
                card: null,
                button: null,
                checkbox: null,
                imagePromise: null,
            });
        }
    } catch (_) { }
}

function createBatchSelectionSnapshot(card, button, key) {
    const sourceText = extractSourceDescription(card);
    const originalProductName = extractOriginalProductName(card);
    const searchCode = extractSearchCode(card);
    const styleCode = extractStyleCode(sourceText);
    const snapshot = {
        key,
        card,
        button,
        checkbox: null,
        sourceText,
        originalProductName,
        searchCode,
        styleCode,
        originalPrice: extractOriginalPrice(sourceText) || extractStructuredPrice(card),
        allPrices: extractAllStructuredPrices(card),
        specs: extractSpecs(card),
        sizes: extractSizes(sourceText),
        images: extractDomImages(card),
        imagePromise: null,
        selectedAt: Date.now(),
    };

    // Arabic: ابدأ جمع المعرض الكامل فور التحديد قبل أن يزيل التمرير بطاقة المنتج من DOM.
    // English: Capture the full gallery immediately before virtualization removes the card from the DOM.
    snapshot.imagePromise = extractAllImages(card, searchCode, styleCode)
        .then(images => {
            if (images.length) snapshot.images = images;
            snapshot.imagePromise = null;
            persistBatchSelections();
            return snapshot.images;
        })
        .catch(() => {
            snapshot.imagePromise = null;
            persistBatchSelections();
            return snapshot.images;
        });

    return snapshot;
}

function bindBatchEntryToRenderedCard(entry, card, button, checkbox) {
    entry.card = card;
    entry.button = button;
    entry.checkbox = checkbox;
    checkbox.checked = true;
    card.classList.add('alphacode-batch-selected-card');

    if ((!entry.images || !entry.images.length) && !entry.imagePromise) {
        entry.imagePromise = extractAllImages(card, entry.searchCode, entry.styleCode)
            .then(images => {
                if (images.length) entry.images = images;
                entry.imagePromise = null;
                persistBatchSelections();
                return entry.images;
            })
            .catch(() => {
                entry.imagePromise = null;
                return entry.images || [];
            });
    }
}

function ensureBatchSelectionControl(container, card, button) {
    if (!extractorConfig.BatchModeEnabled) return;

    const previousKey = card.dataset.alphacodeBatchKey || '';
    const key = getBatchCardKey(card);
    let label = card.querySelector('.alphacode-batch-select');

    if (previousKey && previousKey !== key) {
        const previousEntry = selectedBatchProducts.get(previousKey);
        if (previousEntry?.card === card) {
            previousEntry.card = null;
            previousEntry.button = null;
            previousEntry.checkbox = null;
        }
    }

    // Arabic: عند إعادة تدوير البطاقة احذف عنصر التحكم المرتبط بالمنتج السابق.
    // English: Replace stale controls when a virtualized card node now represents a different product.
    if (label && label.dataset.batchKey !== key) {
        label.remove();
        label = null;
    }

    card.classList.remove('alphacode-batch-selected-card');

    if (!label) {
        label = document.createElement('label');
        label.className = 'alphacode-batch-select';
        label.dataset.batchKey = key;
        label.innerHTML = '<input class="alphacode-batch-checkbox" type="checkbox"> <span>تحديد للدفعة</span>';
        container.insertBefore(label, button.nextSibling);
    }

    const checkbox = label.querySelector('input');
    const existingEntry = selectedBatchProducts.get(key);
    if (existingEntry) {
        bindBatchEntryToRenderedCard(existingEntry, card, button, checkbox);
    } else {
        checkbox.checked = false;
    }

    if (checkbox.dataset.alphacodeBoundKey === key) return;
    checkbox.dataset.alphacodeBoundKey = key;
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', event => {
        event.stopPropagation();
        const currentKey = getBatchCardKey(card);
        const maximum = Math.max(2, Number(extractorConfig.BatchMaximumProducts || 25));

        if (checkbox.checked && selectedBatchProducts.size >= maximum && !selectedBatchProducts.has(currentKey)) {
            checkbox.checked = false;
            alert(`الحد الأقصى للدفعة هو ${maximum} منتجاً.`);
            return;
        }

        if (checkbox.checked) {
            const entry = selectedBatchProducts.get(currentKey)
                || createBatchSelectionSnapshot(card, button, currentKey);
            selectedBatchProducts.set(currentKey, entry);
            bindBatchEntryToRenderedCard(entry, card, button, checkbox);
        } else {
            selectedBatchProducts.delete(currentKey);
            card.classList.remove('alphacode-batch-selected-card');
        }

        persistBatchSelections();
        updateBatchToolbar();
    });
}

function ensureBatchToolbar() {
    let toolbar = document.getElementById('alphacode-batch-toolbar');

    if (!extractorConfig.BatchModeEnabled) {
        toolbar?.remove();
        return null;
    }

    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'alphacode-batch-toolbar';
        toolbar.innerHTML = `
            <div class="alphacode-batch-toolbar-main">
                <strong>دفعة AlphaCode</strong>
                <span id="alphacodeBatchSelectedCount">0 منتج</span>
            </div>
            <div class="alphacode-batch-toolbar-actions">
                <button id="alphacodeSelectVisibleBatch" type="button">تحديد الظاهر</button>
                <button id="alphacodeReviewBatch" class="primary" type="button">مراجعة وإضافة</button>
                <button id="alphacodeClearBatch" type="button">مسح</button>
            </div>`;
        document.body.appendChild(toolbar);

        toolbar.querySelector('#alphacodeSelectVisibleBatch').onclick = () => {
            const maximum = Math.max(2, Number(extractorConfig.BatchMaximumProducts || 25));
            for (const checkbox of document.querySelectorAll('.alphacode-batch-checkbox')) {
                if (selectedBatchProducts.size >= maximum) break;
                if (!checkbox.checked && checkbox.isConnected) {
                    checkbox.checked = true;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        };

        toolbar.querySelector('#alphacodeClearBatch').onclick = () => {
            for (const item of selectedBatchProducts.values()) {
                if (item.checkbox?.isConnected) item.checkbox.checked = false;
                if (item.card?.isConnected) item.card.classList.remove('alphacode-batch-selected-card');
            }
            selectedBatchProducts.clear();
            persistBatchSelections();
            updateBatchToolbar();
        };

        toolbar.querySelector('#alphacodeReviewBatch').onclick = () => openBatchReviewModal();
    }

    updateBatchToolbar();
    return toolbar;
}

function updateBatchToolbar() {
    const toolbar = document.getElementById('alphacode-batch-toolbar');
    if (!toolbar) return;
    const count = selectedBatchProducts.size;
    toolbar.querySelector('#alphacodeBatchSelectedCount').textContent = `${count} منتج`;
    toolbar.querySelector('#alphacodeReviewBatch').disabled = count === 0;
    toolbar.classList.toggle('has-selection', count > 0);
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const count = Math.max(1, Math.min(Number(concurrency || 1), 3, items.length || 1));

    async function runWorker() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                results[index] = { error };
            }
        }
    }

    await Promise.all(Array.from({ length: count }, runWorker));
    return results;
}

// Arabic: الترتيب الافتراضي: الصور 1 و2 و3 و4 و6 و10، والصورة 10 رئيسية.
// English: Default order: images 1, 2, 3, 4, 6, and 10, with image 10 as main.
function defaultBatchImageSelection(images) {
    const limit = Math.max(
        1,
        Math.min(
            Number(extractorConfig.StoreImageLimit || 6),
            6,
        ),
    );

    // الأرقام تبدأ من صفر داخل JavaScript:
    // 0 = الصورة 1، و5 = الصورة 6، و9 = الصورة 10.
    const preferredIndexes = [
        0, // #1
        1, // #2
        2, // #3
        3, // #4
        5, // #6
        9, // #10
    ];

    const selectedIndexes = preferredIndexes
        .filter(index => (
            index >= 0
            && index < images.length
        ))
        .slice(0, limit);

    // إكمال العدد من الصور المتوفرة إذا لم توجد الصورة 6 أو 10.
    for (
        let index = 0;
        index < images.length
        && selectedIndexes.length < limit;
        index += 1
    ) {
        if (!selectedIndexes.includes(index)) {
            selectedIndexes.push(index);
        }
    }

    // الصورة رقم 10 رئيسية، وإن لم توجد فآخر صورة مختارة تكون الرئيسية.
    const mainIndex = images.length > 9
        ? 9
        : (selectedIndexes[selectedIndexes.length - 1] ?? 0);

    return {
        selectedIndexes,
        mainIndex,
        limit,
    };
}
// Arabic: محدد صور مستقل لكل منتج داخل شرائح الدفعة.
// English: Independent image picker for every product in the batch-review slides.
function initializeBatchDraftImageSelector(slide, draft) {
    const grid = slide.querySelector('.batch-image-selector-grid');
    const counter = slide.querySelector('.batch-image-counter');
    const selectFirstButton = slide.querySelector('.batch-select-first-images');
    const clearButton = slide.querySelector('.batch-clear-images');
    if (!grid || !counter) return;

    const initial = draft.imageSelection || defaultBatchImageSelection(draft.images);
    const limit = Math.max(1, Math.min(Number(initial.limit || 6), 6));
    const selectionLocked = Boolean(draft.archiveData?.exists);
    const selected = new Set(
        (initial.selectedIndexes || [])
            .map(Number)
            .filter(index => Number.isInteger(index) && index >= 0 && index < draft.images.length)
            .slice(0, limit),
    );
    let mainIndex = Number(initial.mainIndex);
    if (!selected.size && draft.images.length) selected.add(0);
    if (!selected.has(mainIndex)) mainIndex = Array.from(selected)[0] ?? 0;

    const refresh = () => {
        grid.querySelectorAll('.batch-image-choice').forEach(card => {
            const index = Number(card.dataset.index);
            const checkbox = card.querySelector('.batch-image-check');
            const radio = card.querySelector('.batch-image-main');
            const isSelected = selected.has(index);
            checkbox.checked = isSelected;
            checkbox.disabled = selectionLocked;
            radio.checked = index === mainIndex;
            radio.disabled = selectionLocked || !isSelected;
            card.classList.toggle('selected', isSelected);
            card.classList.toggle('main-image', index === mainIndex);
        });
        counter.textContent = selectionLocked
            ? `مؤرشف — يستخدم الصور المحفوظة`
            : `${selected.size} / ${limit} — الرئيسية #${mainIndex + 1}`;
        draft.imageSelection = {
            selectedIndexes: [mainIndex, ...Array.from(selected).filter(index => index !== mainIndex)],
            mainIndex,
            limit,
        };
    };

    const setSelected = (index, shouldSelect) => {
        if (shouldSelect) {
            if (!selected.has(index) && selected.size >= limit) {
                alert(`المتجر يقبل ${limit} صور فقط. ألغِ صورة ثم اختر البديلة.`);
                return false;
            }
            selected.add(index);
        } else {
            if (index === mainIndex) {
                alert('اختر صورة رئيسية أخرى قبل إلغاء هذه الصورة.');
                return false;
            }
            selected.delete(index);
        }
        refresh();
        return true;
    };

    draft.images.forEach((url, index) => {
        const card = document.createElement('div');
        card.className = 'batch-image-choice';
        card.dataset.index = String(index);
        card.innerHTML = `
            <img loading="lazy" alt="Product image ${index + 1}">
            <div class="batch-image-choice-footer">
                <label><input class="batch-image-check" type="checkbox"> رفع</label>
                <label><input class="batch-image-main" type="radio" name="batch-main-image-${stableBatchHash(draft.key)}"> رئيسية</label>
                <strong>#${index + 1}</strong>
            </div>`;
        card.querySelector('img').src = url;
        card.querySelector('.batch-image-check').addEventListener('change', event => {
            if (!setSelected(index, event.target.checked)) event.target.checked = selected.has(index);
        });
        card.querySelector('.batch-image-main').addEventListener('change', event => {
            if (!event.target.checked) return;
            if (!selected.has(index) && !setSelected(index, true)) return;
            mainIndex = index;
            refresh();
        });
        grid.appendChild(card);
    });

    const selectAllButton = slide.querySelector('.batch-select-all-images');
    const deselectAllButton = slide.querySelector('.batch-deselect-all-images');

    if (selectionLocked) {
        if (selectFirstButton) selectFirstButton.disabled = true;
        if (clearButton) clearButton.disabled = true;
        if (selectAllButton) selectAllButton.disabled = true;
        if (deselectAllButton) deselectAllButton.disabled = true;
    }

    selectFirstButton?.addEventListener('click', () => {
        if (selectionLocked) return;
        selected.clear();
        for (let index = 0; index < Math.min(limit, draft.images.length); index += 1) selected.add(index);
        mainIndex = Array.from(selected)[0] ?? 0;
        refresh();
    });

    selectAllButton?.addEventListener('click', () => {
        if (selectionLocked) return;
        selected.clear();
        for (let index = 0; index < Math.min(limit, draft.images.length); index += 1) selected.add(index);
        refresh();
    });

    deselectAllButton?.addEventListener('click', () => {
        if (selectionLocked) return;
        const keep = mainIndex >= 0 && mainIndex < draft.images.length ? mainIndex : 0;
        selected.clear();
        selected.add(keep);
        mainIndex = keep;
        refresh();
    });

    clearButton?.addEventListener('click', () => {
        if (selectionLocked) return;
        selected.clear();
        if (draft.images.length) selected.add(mainIndex >= 0 && mainIndex < draft.images.length ? mainIndex : 0);
        mainIndex = Array.from(selected)[0] ?? 0;
        refresh();
    });

    // Arabic: حساب السعر بالريال السعودي تلقائياً عند تغيير السعر اليوان أو الرسوم
    // English: Auto-calculate SAR price when Yuan price or fee changes
    const priceInput = slide.querySelector('.batch-price');
    const feeInput = slide.querySelector('.batch-fee-yuan');
    const sarPreview = slide.querySelector('.batch-price-sar-preview');

    // Arabic: هذي المعاينة كانت تحمل صيغة ثالثة مستقلة للأحذية: yuan × rate × (1+FeePercent/100)،
    //         و`FeePercent` غير موجود أصلاً بالإعدادات (config.js) فيؤول دايماً إلى 0. النتيجة:
    //         حذاء بـ350 يوان يعرض 175 ريال بينما المُرسَل فعلياً (350+250)×0.5 = 300 ريال.
    //         الآن المعاينة تستخدم نفس صيغة الإرسال الفعلي للنوعين، مع احترام أي تعديل يدوي
    //         يكتبه المستخدم بحقل الرسوم.
    // English: This preview carried a third, independent formula for shoes:
    //          yuan x rate x (1 + FeePercent/100) - and `FeePercent` does not exist in the
    //          settings (config.js) at all, so it always collapsed to 0. Result: a 350 CNY shoe
    //          displayed 175 SAR while the real submission was (350+250) x 0.5 = 300 SAR.
    //          The preview now uses the exact submission formula for both types, while still
    //          honouring whatever the operator types into the fee field.
    const updateSarPreview = () => {
        const yuan = parseFloat(priceInput?.value || 0) || 0;
        const fee = parseFloat(feeInput?.value || 0) || 0;
        const rate = Number(extractorConfig.ExchangeRate) || 0;
        if (sarPreview) sarPreview.textContent = `${Math.round((yuan + fee) * rate)} ر.س`;
    };

    priceInput?.addEventListener('input', updateSarPreview);
    feeInput?.addEventListener('input', updateSarPreview);

    // Arabic: بوابة السعر لكل منتج بالدفعة — المنتج المشكوك بسعره لا يُسمح بإضافته حتى
    //         يدخل المستخدم السعر باليوان ويؤكّده صراحةً.
    // English: Per-product price gate in the batch - a product with a doubtful price cannot be
    //          added until the operator types the CNY price and explicitly confirms it.
    const priceConfirm = slide.querySelector('.batch-price-confirm');
    if (priceConfirm) {
        const syncConfirm = () => {
            const typed = parseFloat(priceInput?.value || 0) || 0;
            draft.priceConfirmed = Boolean(priceConfirm.checked) && typed > 0;
            refreshBatchStartGate(slide.closest('#modal-content-area'));
        };
        priceConfirm.addEventListener('change', syncConfirm);
        priceInput?.addEventListener('input', syncConfirm);
        syncConfirm();
    }

    // Arabic: زر نوع المنتج (shoes/watches) يدوي — يُحدّث نوع المسودة ويعيد حساب السعر
    // English: Manual product type toggle — updates the draft type and recalculates the price
    slide.querySelectorAll('.batch-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            slide.querySelectorAll('.batch-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            draft.productType = PRODUCT_TYPES.resolveProductType(btn.dataset.type);
            const profile = PRODUCT_TYPES.getProfile(draft.productType);
            const variantsSection = slide.querySelector('.batch-variants')?.closest('.alphacode-field');
            if (variantsSection) variantsSection.style.display = profile.hasColorVariantEditor ? '' : 'none';
            // Arabic: عند تبديل النوع يدوياً لازم يتبدّل الرسم معه - قبل التوحيد كان الحقل
            //         يبقى على رسم النوع السابق، فيُحسب حذاء برسم ساعة أو العكس.
            // English: Switching the type manually must switch the fee with it - before the
            //          unification the field kept the previous type's fee, pricing a shoe with
            //          a watch fee or vice versa.
            if (feeInput) feeInput.value = PRODUCT_TYPES.productTypeFee(draft.productType, extractorConfig);
            updateSarPreview();
        });
    });

    updateSarPreview();
    refresh();
}

async function buildBatchDraft(entry, index, total, updateProgress) {
    const card = entry.card?.isConnected ? entry.card : null;
    const sourceText = entry.sourceText || (card ? extractSourceDescription(card) : '');
    const originalProductName = entry.originalProductName || (card ? extractOriginalProductName(card) : sourceText);
    const searchCode = entry.searchCode || (card ? extractSearchCode(card) : '');
    const styleCode = entry.styleCode || extractStyleCode(sourceText);
    const displayedPrice = Number(entry.originalPrice) || extractOriginalPrice(sourceText) || (card ? extractStructuredPrice(card) : 0);
    // Arabic: نفس فحص العملة بمسار الدفعة — السعر المعروض قد يكون بعملة أجنبية حسب الـIP.
    // English: The same currency check on the batch path - the displayed price may be in a
    //          foreign currency depending on the IP.
    const priceCheck = await SUPPLIER_CURRENCY.resolveCnyPriceForPage(displayedPrice, sourceText);
    const originalPrice = priceCheck.cnyPrice;
    const allPrices = entry.allPrices?.length ? entry.allPrices : (card ? extractAllStructuredPrices(card) : []);
    const specs = entry.specs?.length ? entry.specs : (card ? extractSpecs(card) : []);
    const sizes = uniqueSizes(entry.sizes?.length ? entry.sizes : extractSizes(sourceText));

    updateProgress?.(`قراءة المنتج ${index + 1} من ${total}...`);
    const imageTask = entry.imagePromise
        || (entry.images?.length ? Promise.resolve(entry.images) : null)
        || (card ? extractAllImages(card, searchCode, styleCode) : Promise.resolve([]));
    const [archiveData, images] = await Promise.all([
        checkArchive(searchCode, styleCode),
        imageTask,
    ]);

    if (!images.length) {
        throw new Error(`لم تُحفظ صور المنتج المحدد رقم ${index + 1}. أعد إظهاره في الصفحة وحدده مرة أخرى.`);
    }

    entry.images = images;
    entry.imagePromise = null;
    persistBatchSelections();

    const draft = {
        key: entry.key,
        card,
        button: entry.button,
        include: archiveData.workflow_status !== 'submitted',
        archiveData,
        sourceText,
        originalProductName,
        searchCode,
        styleCode,
        originalPrice,
        priceCheck,
        // Arabic: يصير true بعد ما يدخل/يؤكّد المستخدم السعر يدوياً بشاشة المراجعة.
        // English: Becomes true once the operator enters/confirms the price manually in review.
        priceConfirmed: priceCheck.status !== 'needs_manual',
        allPrices,
        specs,
        sizes,
        images,
        imageSelection: defaultBatchImageSelection(images),
        // Arabic: تبدأ فاضية - لا صياغة احتياطية تلقائية.
        // English: Start empty - no automatic fallback copy.
        nameEN: '',
        descriptionEN: '',
        nameAR: '',
        descriptionAR: '',
        brandName: canonicalBrandName(sourceText),
        brandId: 0,
        // Arabic: حالة تجهيز المسودة - لا علاقة لها بالذكاء الاصطناعي بعد حذفه.
        // English: Draft preparation status - unrelated to AI now that it has been removed.
        prepStatus: archiveData.exists ? 'archived' : 'manual',
        productType: detectProductType(sourceText),
        variants: [],
    };
    draft.brandId = resolveBrandId(draft.brandName);

    if (archiveData.exists && Number(archiveData.id)) {
        try {
            const archivedResponse = await fetch(
                `${API_BASE_URL}/api/archive/product/${Number(archiveData.id)}`,
                { cache: 'no-store' },
            );
            const archivedData = await archivedResponse.json();
            if (archivedResponse.ok && archivedData.success && archivedData.product) {
                const archived = archivedData.product;
                draft.nameEN = archived.name_en || archived.name || draft.nameEN;
                draft.descriptionEN = archived.description_en || archived.description || draft.descriptionEN;
                draft.nameAR = archived.name_ar || draft.nameAR;
                draft.descriptionAR = archived.description_ar || draft.descriptionAR;
                draft.brandName = canonicalBrandName(archived.brand_name || draft.brandName);
                draft.brandId = resolveBrandId(draft.brandName);
                draft.sizes = uniqueSizes(archived.sizes || draft.sizes);
                draft.originalPrice = Number(archived.original_price || draft.originalPrice || 0);
                draft.variants = Array.isArray(archived.variants) ? archived.variants : draft.variants;
            }
        } catch (_) { }
    }

    // Arabic: مسار خاص بالساعات - الاسم والوصف يبقيان فاضيين للإدخال اليدوي (أو لصق قالب
    //         JSON). كان هنا استدعاء ذكاء اصطناعي لاستخراج الألوان والأسعار، وحُذف بالكامل
    //         بطلب المستخدم؛ الألوان تُدخَل يدوياً بمحرر الألوان بشاشة المراجعة.
    // English: Watches path - name and description stay empty for manual entry (or a pasted
    //          JSON template). An AI call used to extract colours and prices here; it was
    //          removed entirely at the operator's request, and colours are now entered by
    //          hand in the colour editor on the review screen.
    if (!archiveData.exists && PRODUCT_TYPES.getProfile(draft.productType).hasColorVariantEditor) {
        draft.nameEN = '';
        draft.descriptionEN = '';
        draft.nameAR = '';
        draft.descriptionAR = '';
        draft.prepStatus = 'watch_manual';
    }

    return draft;
}

// Arabic: يُحدّث حالة زر بدء الدفعة حسب وجود منتجات سعرها غير مؤكَّد، ويشرح السبب بالزر.
// English: Updates the batch start button based on products with an unconfirmed price, and
//          explains the reason on the button itself.
function refreshBatchStartGate(contentArea) {
    const root = contentArea || document.querySelector('#modal-content-area');
    const startButton = root?.querySelector('#alphacodeStartBatch');
    if (!startButton || !Array.isArray(activeBatchDrafts)) return;
    const blocking = activeBatchDrafts.filter(
        draft => draft.include && draft.priceConfirmed === false,
    ).length;
    startButton.disabled = blocking > 0;
    startButton.title = blocking
        ? `${blocking} منتج بحاجة لتأكيد السعر باليوان قبل البدء.`
        : '';
}

function renderBatchReviewSlides(modalBox, drafts) {
    activeBatchDrafts = drafts;
    const content = modalBox.querySelector('#modal-content-area');
    const brandOptions = getAllowedBrandNames()
        .map(brand => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`)
        .join('');

    content.className = '';
    content.innerHTML = `
        <div class="alphacode-batch-review-header">
            <strong>مراجعة دفعة من ${drafts.length} منتجات</strong>
            <div class="alphacode-batch-copy-all-wrap">
                <button class="alphacode-copy-btn" id="alphacodeCopyAllOriginalNames" type="button" title="نسخ الأسماء الأصلية لكل منتجات الدفعة، كل اسم بسطر لحاله وبينها فاصل +">📋 نسخ كل الأسماء الأصلية للدفعة</button>
                <span class="alphacode-ai-status" id="alphacodeCopyAllOriginalNamesStatus"></span>
            </div>
            <span id="alphacodeBatchSlideCounter"></span>
        </div>
        <div class="alphacode-batch-slide-list">
            ${drafts.map((draft, index) => `
                <section class="alphacode-batch-slide" data-index="${index}">
                    <div class="alphacode-batch-slide-top">
                        <label><input class="batch-include" type="checkbox" ${draft.include ? 'checked' : ''} ${draft.archiveData.workflow_status === 'submitted' ? 'disabled' : ''}> ${draft.archiveData.workflow_status === 'submitted' ? 'مضاف سابقاً للمتجر' : 'إضافة هذا المنتج'}</label>
                        <span class="batch-draft-status ${draft.prepStatus}">${draft.archiveData.exists ? `مؤرشف ID ${draft.archiveData.id}` : 'إدخال يدوي'}</span>
                    </div>
                    <section class="batch-image-selector-section">
                        <div class="batch-image-selector-heading">
                            <div><strong>اختيار صور هذا المنتج</strong><small>حدد حتى ${Math.min(Number(extractorConfig.StoreImageLimit || 6), 6)} صور واختر الرئيسية.</small></div>
                            <span class="batch-image-counter"></span>
                        </div>
                        <div class="batch-image-selector-actions">
                            <button class="batch-select-first-images" type="button">اختيار أول 6</button>
                            <button class="batch-select-all-images" type="button">تحديد الكل</button>
                            <button class="batch-deselect-all-images" type="button">إلغاء الكل</button>
                            <button class="batch-clear-images" type="button">الرئيسية فقط</button>
                        </div>
                        <div class="batch-image-selector-grid"></div>
                    </section>
                    <section class="alphacode-json-template-section batch-json-template-section">
                        <div class="alphacode-json-template-heading">
                            <div><strong>قالب محتوى JSON خارجي</strong><small>يمكنك توليد المحتوى خارج الإضافة ثم لصقه هنا.</small></div>
                            <span class="alphacode-json-template-status batch-json-status"></span>
                        </div>
                        <textarea class="alphacode-json-template-input batch-copy-json" dir="ltr" spellcheck="false" placeholder='{"name_en":"","description_en":"","name_ar":"","description_ar":""}'></textarea>
                        <div class="alphacode-json-template-actions">
                            <button class="primary batch-apply-json" type="button">قبول القالب</button>
                            <button class="batch-copy-empty-json" type="button">نسخ القالب الفارغ</button>
                            <button class="batch-copy-original-name" type="button">نسخ الاسم الأصلي</button>
                        </div>
                    </section>
                    <div class="alphacode-language-grid">
                        <div>
                            <div class="alphacode-field alphacode-ltr-field"><label>الاسم الإنجليزي</label><input class="batch-name-en" dir="ltr" value="${escapeHtml(draft.nameEN)}"></div>
                            <div class="alphacode-field alphacode-ltr-field"><label>الوصف الإنجليزي</label><textarea class="batch-desc-en" dir="ltr">${escapeHtml(draft.descriptionEN)}</textarea></div>
                        </div>
                        <div>
                            <div class="alphacode-field"><label>الاسم العربي</label><input class="batch-name-ar" dir="rtl" value="${escapeHtml(draft.nameAR)}"></div>
                            <div class="alphacode-field"><label>الوصف العربي</label><textarea class="batch-desc-ar" dir="rtl">${escapeHtml(draft.descriptionAR)}</textarea></div>
                        </div>
                    </div>
                    <div class="alphacode-inline-grid">
                        <div class="alphacode-field"><label>البراند المتاح في المتجر</label><select class="batch-brand">${brandOptions}</select></div>
                        <div class="alphacode-field">
                            <label>نوع المنتج</label>
                            <div class="alphacode-type-toggle">
                                ${PRODUCT_TYPES.listProductTypes().map(typeId => `
                                <button class="batch-type-btn ${PRODUCT_TYPES.resolveProductType(draft.productType) === typeId ? 'active' : ''}" data-type="${typeId}" type="button">${PRODUCT_TYPES.productTypeLabel(typeId, { withIcon: true })}</button>`).join('')}
                            </div>
                        </div>
                        <div class="alphacode-field alphacode-wide-field">${buildPriceCheckBanner(draft.priceCheck, 'batch')}</div>
                        <div class="alphacode-field">
                            <label>السعر باليوان (أساسي)</label>
                            <input class="batch-price" type="number" step="0.01" value="${Number(draft.originalPrice || 0)}">
                        </div>
                        <div class="alphacode-field">
                            <label>رسوم ثابتة إضافية (يوان)</label>
                            <!-- Arabic: كان هذا الحقل يكتب 0 حرفياً للأحذية ويتجاهل AddedFeeYuan (250)،
                                 فتظهر المعاينة برسم صفر وسعر أقل 125 ريال من المُرسَل فعلياً. الآن
                                 يُقرأ رسم النوع من المصدر الموحّد للنوعين بلا استثناء.
                                 English: This field used to hard-code 0 for shoes and ignore
                                 AddedFeeYuan (250), so the preview showed a zero fee and a price
                                 125 SAR below what was actually submitted. It now reads the type's
                                 fee from the unified source, for both types with no exception. -->
                            <input class="batch-fee-yuan" type="number" step="0.01" value="${PRODUCT_TYPES.productTypeFee(draft.productType, extractorConfig)}">
                        </div>
                        <div class="alphacode-field alphacode-readonly-item">
                            <span>الإجمالي بالريال السعودي</span>
                            <strong class="batch-price-sar-preview">—</strong>
                        </div>
                        <div class="alphacode-field alphacode-wide-field"><label>المقاسات</label><input class="batch-sizes" dir="ltr" value="${escapeHtml(draft.sizes.join(', '))}"></div>
                    </div>
                    ${PRODUCT_TYPES.getProfile(draft.productType).hasColorVariantEditor ? `
                    <div class="alphacode-field alphacode-wide-field">
                        <label>الألوان والأسعار المستخرجة (سطر لكل لون: اللون : السعر - عدّل أو أضف يدوياً)</label>
                        <textarea class="batch-variants" dir="rtl" rows="4" placeholder="أبيض : 199.99&#10;أسود : 249.99">${escapeHtml((draft.variants || []).map(v => `${v.color} : ${v.price}`).join('\n'))}</textarea>
                    </div>` : ''}
                    <div class="alphacode-readonly-group">
                        <div class="alphacode-readonly-item"><span>Style Code</span><input class="batch-style-code" type="text" placeholder="ادخل/عدّل كود الستايل" value="${escapeHtml(draft.styleCode || '')}"></div>
                        <div class="alphacode-readonly-item"><span>Search Code</span><strong>${escapeHtml(draft.searchCode || '-')}</strong></div>
                        <div class="alphacode-readonly-item"><span>الصور المكتشفة</span><strong>${draft.images.length}</strong></div>
                        ${draft.specs?.length ? `<div class="alphacode-readonly-item"><span>Specs (من المصدر)</span><strong>${escapeHtml(draft.specs.join(', '))}</strong></div>` : ''}
                    </div>
                    ${draft.allPrices?.length > 1 ? `
                    <div class="alphacode-batch-price-warning">
                        ⚠️ لُقيت أكثر من سعر على منشور المصدر: <strong>${draft.allPrices.map(p => escapeHtml(String(p))).join(' / ')}</strong> يوان.
                        غالباً يعني هذا إن للمنتج نسخ/ألوان بأسعار مختلفة - راجعها يدوياً واختر السعر الصحيح في حقل "السعر باليوان" أعلاه قبل الإضافة.
                    </div>` : ''}
                    ${draft.prepError ? `<span class="alphacode-inline-error">${escapeHtml(draft.prepError)}</span>` : ''}
                </section>`).join('')}
        </div>
        <div class="alphacode-batch-navigation">
            <button id="alphacodeBatchPrev" type="button">السابق</button>
            <div class="alphacode-batch-dots">${drafts.map((_, index) => `<button type="button" data-slide="${index}"></button>`).join('')}</div>
            <button id="alphacodeBatchNext" type="button">التالي</button>
        </div>
        <div class="alphacode-actions">
            <button class="alphacode-btn-submit" id="alphacodeStartBatch" type="button">بدء التجهيز والإضافة المتتابعة</button>
            <button class="alphacode-btn-dry-run" id="alphacodeStartDryRun" type="button">🧪 تجريبي (Dry Run)</button>
            <button class="alphacode-btn-cancel" id="alphacodeCancelBatchReview" type="button">إلغاء</button>
        </div>`;

    drafts.forEach((draft, index) => {
        const slide = content.querySelector(`.alphacode-batch-slide[data-index="${index}"]`);
        initializeBatchDraftImageSelector(slide, draft);
        bindExternalCopyTemplateControls({
            root: slide,
            textarea: slide.querySelector('.batch-copy-json'),
            applyButton: slide.querySelector('.batch-apply-json'),
            copyEmptyButton: slide.querySelector('.batch-copy-empty-json'),
            copyOriginalButton: slide.querySelector('.batch-copy-original-name'),
            statusElement: slide.querySelector('.batch-json-status'),
            fields: {
                nameEN: slide.querySelector('.batch-name-en'),
                descEN: slide.querySelector('.batch-desc-en'),
                nameAR: slide.querySelector('.batch-name-ar'),
                descAR: slide.querySelector('.batch-desc-ar'),
            },
            originalProductName: draft.originalProductName || draft.sourceText,
        });
        slide.querySelector('.batch-brand').value = draft.brandName;
        slide.querySelector('.batch-brand').addEventListener('change', event => {
            draft.brandName = canonicalBrandName(event.target.value);
            draft.brandId = resolveBrandId(draft.brandName);
        });
    });

    let currentIndex = 0;
    const slides = Array.from(content.querySelectorAll('.alphacode-batch-slide'));
    const dots = Array.from(content.querySelectorAll('.alphacode-batch-dots button'));
    const showSlide = index => {
        currentIndex = Math.max(0, Math.min(index, slides.length - 1));
        slides.forEach((slide, slideIndex) => slide.classList.toggle('active', slideIndex === currentIndex));
        dots.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex === currentIndex));
        content.querySelector('#alphacodeBatchSlideCounter').textContent = `${currentIndex + 1} / ${slides.length}`;
        content.querySelector('#alphacodeBatchPrev').disabled = currentIndex === 0;
        content.querySelector('#alphacodeBatchNext').disabled = currentIndex === slides.length - 1;
    };
    content.querySelector('#alphacodeBatchPrev').onclick = () => showSlide(currentIndex - 1);
    content.querySelector('#alphacodeBatchNext').onclick = () => showSlide(currentIndex + 1);
    dots.forEach(dot => { dot.onclick = () => showSlide(Number(dot.dataset.slide)); });
    showSlide(0);

    const copyAllNamesButton = content.querySelector('#alphacodeCopyAllOriginalNames');
    const copyAllNamesStatus = content.querySelector('#alphacodeCopyAllOriginalNamesStatus');
    copyAllNamesButton.onclick = async () => {
        const text = buildBatchOriginalNamesText(drafts);
        if (!text) {
            copyAllNamesStatus.textContent = 'لا توجد أسماء أصلية قابلة للنسخ في هذه الدفعة.';
            copyAllNamesStatus.classList.add('error');
            return;
        }
        const copied = await copyTextToClipboard(text);
        copyAllNamesStatus.textContent = copied
            ? `تم نسخ ${drafts.length} اسم أصلي (كل اسم بسطر، مفصولة بـ +).`
            : 'تعذر النسخ إلى الحافظة.';
        copyAllNamesStatus.classList.toggle('error', !copied);
        copyAllNamesStatus.classList.toggle('success', copied);
    };

    content.querySelector('#alphacodeCancelBatchReview').onclick = () => activeBatchReviewOverlay?.remove();

    const collectDraftsFromSlides = () => {
        const included = [];
        drafts.forEach((draft, index) => {
            const slide = slides[index];
            draft.include = slide.querySelector('.batch-include').checked;
            draft.nameEN = slide.querySelector('.batch-name-en').value.trim();
            draft.descriptionEN = slide.querySelector('.batch-desc-en').value.trim();
            draft.nameAR = slide.querySelector('.batch-name-ar').value.trim();
            draft.descriptionAR = slide.querySelector('.batch-desc-ar').value.trim();
            draft.brandName = canonicalBrandName(slide.querySelector('.batch-brand').value);
            draft.brandId = resolveBrandId(draft.brandName);
            draft.originalPrice = Number(slide.querySelector('.batch-price').value || 0);
            draft.feeYuan = Number(slide.querySelector('.batch-fee-yuan')?.value || 0);
            draft.productType = slide.querySelector('.batch-type-btn.active')?.dataset.type || draft.productType;
            draft.sizes = uniqueSizes(slide.querySelector('.batch-sizes').value.split(/[,،\s]+/).filter(Boolean));
            draft.styleCode = (slide.querySelector('.batch-style-code')?.value || '').trim();
            const variantsField = slide.querySelector('.batch-variants');
            if (variantsField) {
                draft.variants = variantsField.value.split('\n')
                    .map(line => {
                        const [color, price] = line.split(':').map(part => (part || '').trim());
                        return { color, price: Number(price) };
                    })
                    .filter(item => item.color && item.price > 0);
            }
            if (draft.include) included.push(draft);
        });
        return included;
    };

    // Arabic: Dry Run - يرسل كل مسودة لـ/api/dry-run ويعرض تقريراً شاملاً بدون رفع أي شيء.
    // English: Dry Run - sends every draft to /api/dry-run and shows a comprehensive report
    //          without uploading anything.
    content.querySelector('#alphacodeStartDryRun').onclick = async event => {
        const includedDrafts = collectDraftsFromSlides();
        if (!includedDrafts.length) { alert('لم يتم اختيار أي منتج.'); return; }
        event.currentTarget.disabled = true;
        event.currentTarget.textContent = '⏳ جارٍ التجريب...';
        const reports = [];
        for (const draft of includedDrafts) {
            try {
                const res = await fetch(`${API_BASE_URL}/api/dry-run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        NameEN: draft.nameEN, DescriptionEN: draft.descriptionEN,
                        StyleCode: draft.styleCode, SearchCode: draft.searchCode,
                        ProductType: draft.productType, OriginalPrice: draft.originalPrice,
                        Sizes: draft.sizes, Variants: draft.variants || [],
                        Images: draft.imageSelection?.selectedIndexes?.map(i => draft.images[i]).filter(Boolean) || [],
                    }),
                });
                const data = await res.json();
                reports.push({ draft_key: draft.key, style: draft.styleCode, ...data });
            } catch (err) {
                reports.push({ draft_key: draft.key, style: draft.styleCode, success: false, error: String(err) });
            }
        }
        const blob = new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `alphacode_dry_run_${Date.now()}.json`; a.click();
        URL.revokeObjectURL(url);
        acLog('ok', 'Dry run complete', reports);
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = '🧪 تجريبي (Dry Run)';
    };

    // Arabic: تفعيل حارس السعر فور رسم الشرائح.
    // English: Arm the price gate as soon as the slides are rendered.
    refreshBatchStartGate(content);

    content.querySelector('#alphacodeStartBatch').onclick = async event => {
        const includedDrafts = collectDraftsFromSlides();

        if (!includedDrafts.length) {
            alert('لم يتم اختيار أي منتج داخل شاشة المراجعة.');
            return;
        }

        // Arabic: لا ننتقل للمنتج التالي ولا نبدأ الدفعة أصلاً وفيها منتج سعره غير مؤكَّد.
        // English: Never start the batch while any included product still has an unconfirmed price.
        const unconfirmed = includedDrafts.filter(draft => draft.priceConfirmed === false);
        if (unconfirmed.length) {
            alert(
                `تعذّر التأكد من السعر باليوان لـ${unconfirmed.length} منتج داخل الدفعة.
`
                + 'افتح كل منتج منها، اكتب السعر الصحيح باليوان، وأكّد الخانة، أو ألغِ تحديده.',
            );
            return;
        }

        event.currentTarget.disabled = true;
        event.currentTarget.textContent = 'جارٍ بدء طابور الدفعة...';
        activeBatchReviewOverlay?.remove();
        try {
            await startBatchPipeline(includedDrafts);
        } catch (error) {
            alert(`تعذر بدء الدفعة: ${error.message}`);
            await logExtractorEvent('ERROR', 'batch_start_failed', error.message, { stack: error.stack || '' });
        }
    };
}

async function openBatchReviewModal() {
    // Arabic: نفس بوابة الجلسة قبل تجهيز الدفعة - أرخص بكثير من اكتشاف الانتهاء بعد 25 منتجاً.
    // English: The same session gate before preparing a batch - far cheaper than discovering
    //          the session expired after 25 products.
    if (!(await ensureStoreSession())) return;

    const entries = Array.from(selectedBatchProducts.values())
        .sort((left, right) => Number(left.selectedAt || 0) - Number(right.selectedAt || 0));
    if (entries.length < 2) {
        alert('حدد منتجين أو أكثر أولاً.');
        return;
    }

    const { overlay, modalBox } = createModalShell();
    activeBatchReviewOverlay = overlay;
    modalBox.classList.add('alphacode-batch-modal-box');
    modalBox.querySelector('.alphacode-modal-title span').textContent = `مراجعة دفعة AlphaCode — ${entries.length} منتجات`;
    modalBox.querySelector('.alphacode-close-btn').onclick = () => overlay.remove();
    const content = modalBox.querySelector('#modal-content-area');
    const concurrency = Math.max(1, Math.min(Number(extractorConfig.BatchPreparationConcurrency || 1), 3));
    let completed = 0;
    const updateProgress = message => {
        if (!content?.isConnected) return;
        content.innerHTML = `<span class="alphacode-spinner"></span><div>${escapeHtml(message)}</div><small>تم تجهيز المسودة ${completed} من ${entries.length}</small>`;
    };
    updateProgress('جارٍ قراءة المنتجات وإنشاء مسودات المراجعة...');

    const results = await mapWithConcurrency(entries, concurrency, async (entry, index) => {
        const draft = await buildBatchDraft(entry, index, entries.length, updateProgress);
        completed += 1;
        updateProgress(`اكتملت مسودة المنتج ${index + 1}.`);
        return draft;
    });

    if (!overlay.isConnected) return;
    const drafts = results.filter(result => result && !result.error);
    const failures = results.filter(result => result?.error);
    if (!drafts.length) {
        content.className = 'alphacode-error-box';
        content.textContent = failures[0]?.error?.message || 'تعذر تجهيز منتجات الدفعة.';
        return;
    }

    renderBatchReviewSlides(modalBox, drafts);
}

async function prepareBatchDraftForStore(draft, batchId, batchIndex, batchTotal, seenProductIdsInBatch = new Set()) {
    let pendingProduct = null;
    let productId = Number(draft.archiveData?.id || 0);
    let isDuplicateInBatch = false;

    if (draft.archiveData?.exists && productId) {
        const pendingResponse = await fetch(`${API_BASE_URL}/api/pending/${productId}`, { cache: 'no-store' });
        const pendingData = await pendingResponse.json();
        if (!pendingResponse.ok || !pendingData.success) throw new Error(pendingData.error || 'تعذر جلب المنتج المؤرشف.');
        pendingProduct = pendingData.pending_product;
    } else {
        // Arabic: شاشة المراجعة تسمح بتعديل الرسم يدوياً بحقل "رسوم ثابتة إضافية (يوان)"،
        //         وكانت القيمة تُلتقط بـ`draft.feeYuan` ثم تُهمَل تماماً هنا - أي تعديل
        //         المستخدم لا يصل للمتجر إطلاقاً. الآن يُحترم التعديل اليدوي عبر تمريره
        //         كرسم النوع، فتتطابق المعاينة مع المُرسَل فعلياً في كل الحالات.
        // English: The review screen lets the operator override the fee in the "additional
        //          flat fee (CNY)" field, and that value was captured into `draft.feeYuan`
        //          and then completely ignored here - the operator's edit never reached the
        //          store. The manual override is now honoured as the type's fee, so the
        //          preview matches what is actually submitted in every case.
        const typeFeeKey = PRODUCT_TYPES.getProfile(draft.productType).feeSettingKey;
        const feeOverride = Number(draft.feeYuan);
        const priceSettings = Number.isFinite(feeOverride)
            ? { ...extractorConfig, [typeFeeKey]: feeOverride }
            : extractorConfig;
        const { priceAfterFee, priceSAR } = computeFeeAndPrice(
            draft.originalPrice,
            draft.productType,
            priceSettings,
        );
        const imageSelection = draft.imageSelection || defaultBatchImageSelection(draft.images);
        if (!imageSelection.selectedIndexes?.length) {
            throw new Error('اختر صورة واحدة على الأقل لهذا المنتج.');
        }
        const batchSettings = {
            // Arabic: نفس الإعدادات المستخدمة بحساب السعر أعلاه (متضمّنة أي رسم يدوي)،
            //         حتى لا يعيد الباك اند حساب رسم مختلف عن المعروض بالمعاينة.
            // English: The same settings used for the price computation above (including any
            //          manual fee), so the backend never recomputes a fee different from the
            //          one shown in the preview.
            ...priceSettings,
            // Arabic: استبدال ProductType الموروث من الإعدادات العامة (قد يكون محفوظاً على
            //         "watches" من جلسة سابقة) بالنوع المكتشف فعلياً لهذا المنتج بالذات.
            //         الباك اند يقرأ ProductType من جوا Settings حصراً - وضعها بالمستوى
            //         الأعلى للـ payload وحده (كما فعلنا سابقاً) لا يكفي ولا يُقرأ إطلاقاً.
            // English: Override the ProductType inherited from the global settings (which
            //          may be stuck on "watches" from an earlier session) with this specific
            //          product's actually-detected type. The backend reads ProductType only
            //          from inside Settings - setting it at the payload's top level alone (as
            //          done previously) is never actually read.
            ProductType: PRODUCT_TYPES.resolveProductType(draft.productType),
            AutoSubmitDelaySeconds: 0,
            FastAutofillMode: true,
            DownloadSelectedImagesOnly: Boolean(extractorConfig.BatchDownloadSelectedImagesOnly),
        };
        const payload = {
            Name: draft.nameEN,
            Description: draft.descriptionEN,
            NameEN: draft.nameEN,
            DescriptionEN: draft.descriptionEN,
            NameAR: draft.nameAR,
            DescriptionAR: draft.descriptionAR,
            BrandName: draft.brandName,
            BrandId: draft.brandId,
            ProductType: PRODUCT_TYPES.resolveProductType(draft.productType),
            Sizes: draft.sizes,
            OriginalPrice: draft.originalPrice,
            Variants: draft.variants || [],
            PriceAfterFee: priceAfterFee,
            PriceSAR: priceSAR,
            SearchCode: draft.searchCode || 'NONE',
            StyleCode: draft.styleCode,
            Images: draft.images,
            SelectedImageIndexes: imageSelection.selectedIndexes,
            MainImageIndex: imageSelection.mainIndex,
            StoreImageLimit: imageSelection.limit,
            DownloadSelectedImagesOnly: Boolean(extractorConfig.BatchDownloadSelectedImagesOnly),
            SourceUrl: window.location.href,
            SupplierStoreName: extractorConfig.SupplierStoreName || '',
            SupplierStoreId: resolveSupplierStoreId(),
            Settings: batchSettings,
        };
        const response = await fetch(`${API_BASE_URL}/api/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.status === 409 && result.exists) {
            productId = Number(result.id || 0);
            const pendingResponse = await fetch(`${API_BASE_URL}/api/pending/${productId}`, { cache: 'no-store' });
            const pendingData = await pendingResponse.json();
            if (!pendingResponse.ok || !pendingData.success) throw new Error(pendingData.error || 'تعذر استعادة المنتج المكرر.');
            pendingProduct = pendingData.pending_product;
        } else if (!response.ok || !result.success) {
            throw new Error(result.error || `Save request failed (${response.status})`);
        } else {
            productId = Number(result.id || 0);
            pendingProduct = result.pending_product;
        }
    }

    // Arabic: نفس المنتج (نفس id) ظهر بأكثر من بطاقة بهذي الدفعة - عادة يصير هذا لما
    // المورد يعرض عدة صور/ألوان لنفس رقم الصنف كبطاقات منفصلة. لا نعيد إرساله للمتجر
    // ثانية، ونعرض حالة واضحة "مكرر ضمن الدفعة - تم تجاهله" بدل تلوينه أخضر كنجاح جديد.
    // English: The same product (same id) showed up on more than one card in this batch -
    // this usually happens when the supplier lists several photos/colors under one item
    // number as separate cards. Don't resubmit it to the store again, and show a clear
    // "duplicate within batch - skipped" state instead of coloring it green as a fresh
    // success.
    if (productId && seenProductIdsInBatch.has(productId)) {
        isDuplicateInBatch = true;
    } else if (productId) {
        seenProductIdsInBatch.add(productId);
    }

    if (isDuplicateInBatch) {
        if (
            draft.button?.isConnected
            && draft.card?.isConnected
            && getBatchCardKey(draft.card) === draft.key
        ) {
            draft.button.classList.remove('alphacode-btn-red', 'alphacode-btn-green');
            draft.button.classList.add('alphacode-btn-yellow');
            draft.button.innerHTML = `⚠ مكرر ضمن الدفعة - تم تجاهله (ID: ${productId})`;
        }
        return pendingProduct;
    }

    pendingProduct = {
        ...pendingProduct,
        batch_id: batchId,
        batch_index: batchIndex,
        batch_total: batchTotal,
        settings: {
            ...(pendingProduct.settings || {}),
            AutoSubmitDelaySeconds: 0,
            FastAutofillMode: true,
        },
    };

    const queued = await safeRuntimeMessage({
        action: 'ENQUEUE_BATCH_PRODUCT',
        batchId,
        product: pendingProduct,
        searchCode: draft.searchCode || '',
        styleCode: draft.styleCode || '',
        addUrl: extractorConfig.SooqifyAddUrl,
    });
    if (!queued?.success) throw new Error(queued?.error || 'تعذر إضافة المنتج إلى طابور الإرسال.');

    if (
        draft.button?.isConnected
        && draft.card?.isConnected
        && getBatchCardKey(draft.card) === draft.key
    ) {
        updateButtonAsAdded(draft.button, productId, 'prepared');
    }
    return pendingProduct;
}

async function startBatchPipeline(drafts) {
    // Arabic: مزامنة خفيفة عند بدء الدفعة — pull فقط (لا reconcile كامل) لضمان أن
    //         قاعدة بيانات الـIDs محدّثة قبل حجز IDs جديدة. لا تنتظر إذا فشلت.
    // English: Light sync at batch start — pull only (not full reconcile) to ensure
    //          the ID database is current before reserving new IDs. Failure is silent.
    fetch(`${API_BASE_URL}/api/sync/pull`, { method: 'POST' }).catch(() => {});

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startResponse = await safeRuntimeMessage({
        action: 'START_BATCH_QUEUE',
        batchId,
        totalPlanned: drafts.length,
        addUrl: extractorConfig.SooqifyAddUrl,
        continueOnFailure: extractorConfig.BatchContinueOnFailure !== false,
        notifyEachProduct: extractorConfig.BatchNotifyEachProduct !== false,
        maxRetries: Number(extractorConfig.BatchMaxRetries || 0),
        reuseStoreTab: extractorConfig.BatchReuseStoreTab !== false,
    });
    if (!startResponse?.success) throw new Error(startResponse?.error || 'تعذر بدء طابور الدفعة.');

    latestBatchQueueState = startResponse.state;
    renderBatchProgressPanel(latestBatchQueueState);
    const concurrency = Math.max(1, Math.min(Number(extractorConfig.BatchPreparationConcurrency || 1), 3));

    // Arabic: تتبع أي id اتشاف بنفس الدفعة - لو نفس المنتج (بنفس SearchCode/StyleCode)
    // ظهر بأكثر من بطاقة بنفس الدفعة (مثلاً عدة ألوان لنفس رقم الصنف)، نمنع إعادة إرساله
    // للمتجر أكثر من مرة، ونعرض حالة "مكرر ضمن الدفعة" بدل ما نلوّنه أخضر كنجاح مستقل.
    // English: Track ids seen within this same batch - if the same product (same
    // SearchCode/StyleCode) shows up on more than one card in this batch (e.g. several
    // colorway photos under one item number), stop re-submitting it to the store more
    // than once, and show a distinct "duplicate within batch" state instead of a fresh
    // green success per card.
    const seenProductIdsInBatch = new Set();

    await mapWithConcurrency(drafts, concurrency, async (draft, index) => {
        const maximumAttempts = 1 + Math.max(0, Math.min(Number(extractorConfig.BatchMaxRetries || 0), 2));
        let lastError = null;

        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            try {
                return await prepareBatchDraftForStore(draft, batchId, index + 1, drafts.length, seenProductIdsInBatch);
            } catch (error) {
                lastError = error;
                await logExtractorEvent(
                    attempt < maximumAttempts ? 'WARNING' : 'ERROR',
                    'batch_product_preparation_attempt',
                    error.message,
                    {
                        batch_id: batchId,
                        batch_index: index + 1,
                        attempt,
                        maximum_attempts: maximumAttempts,
                        style_code: draft.styleCode || '',
                        search_code: draft.searchCode || '',
                    },
                );

                if (attempt < maximumAttempts) {
                    await sleep(500);
                }
            }
        }

        await safeRuntimeMessage({
            action: 'REPORT_BATCH_PREPARATION_FAILURE',
            batchId,
            index: index + 1,
            name: draft.nameEN || draft.originalProductName,
            searchCode: draft.searchCode || '',
            styleCode: draft.styleCode || '',
            error: lastError?.message || 'تعذر تجهيز المنتج.',
        });
        return { error: lastError || new Error('تعذر تجهيز المنتج.') };
    });

    await safeRuntimeMessage({ action: 'FINALIZE_BATCH_QUEUE', batchId });
    for (const item of selectedBatchProducts.values()) {
        if (item.checkbox?.isConnected) item.checkbox.checked = false;
        if (item.card?.isConnected) item.card.classList.remove('alphacode-batch-selected-card');
    }
    selectedBatchProducts.clear();
    persistBatchSelections();
    updateBatchToolbar();
}

function renderBatchProgressPanel(state) {
    if (!state?.batchId) return;
    latestBatchQueueState = state;
    let panel = document.getElementById('alphacode-batch-progress-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'alphacode-batch-progress-panel';
        panel.innerHTML = `
            <div class="batch-progress-header"><strong>طابور AlphaCode</strong><button type="button" class="batch-progress-close">×</button></div>
            <div class="batch-progress-summary"></div>
            <div class="batch-progress-current"></div>
            <div class="batch-progress-timer"></div>
            <div class="batch-progress-bar"><span></span></div>
            <div class="batch-progress-actions">
                <button class="batch-pause" type="button">إيقاف مؤقت</button>
                <button class="batch-resume" type="button">استكمال</button>
                <button class="batch-retry" type="button">إعادة الفاشل</button>
                <button class="batch-cancel" type="button">إلغاء</button>
            </div>`;
        document.body.appendChild(panel);
        panel.querySelector('.batch-progress-close').onclick = () => panel.remove();
        panel.querySelector('.batch-pause').onclick = () => safeRuntimeMessage({ action: 'PAUSE_BATCH_QUEUE', batchId: latestBatchQueueState?.batchId });
        panel.querySelector('.batch-resume').onclick = () => safeRuntimeMessage({ action: 'RESUME_BATCH_QUEUE', batchId: latestBatchQueueState?.batchId });
        panel.querySelector('.batch-retry').onclick = () => safeRuntimeMessage({ action: 'RETRY_FAILED_BATCH', batchId: latestBatchQueueState?.batchId });
        panel.querySelector('.batch-cancel').onclick = () => {
            if (confirm('هل تريد إلغاء بقية منتجات الدفعة؟')) safeRuntimeMessage({ action: 'CANCEL_BATCH_QUEUE', batchId: latestBatchQueueState?.batchId });
        };
        // Arabic: عداد تنازلي محلي (كل ثانية) لعرض الوقت المتبقي قبل اعتبار المنتج الحالي معلقاً (مهلة دقيقتين).
        // English: Local one-second countdown showing time left before the current product is treated as hung (2-minute timeout).
        setInterval(() => {
            const timerEl = panel.querySelector('.batch-progress-timer');
            if (!timerEl) return;
            const current = latestBatchQueueState?.current;
            const startedAt = Number(current?.startedAt || 0);
            const timeoutMs = Number(current?.timeoutMs || 0);
            if (latestBatchQueueState?.status !== 'running' || !startedAt || !timeoutMs) {
                timerEl.textContent = '';
                return;
            }
            const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
            const totalSeconds = Math.ceil(remainingMs / 1000);
            const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
            const seconds = String(totalSeconds % 60).padStart(2, '0');
            timerEl.textContent = remainingMs > 0
                ? `⏱ ${minutes}:${seconds} قبل اعتبار المنتج الحالي معلقاً وتخطّيه`
                : '⏱ جارٍ اعتبار المنتج معلقاً وتخطّيه...';
        }, 1000);
    }

    const succeeded = (state.results || []).filter(item => item.success).length;
    const retryableFailed = (state.results || []).filter(item => !item.success && item.product).length;
    const failed = (state.results || []).filter(item => !item.success).length + (state.preparationFailures || []).length;
    const completed = succeeded + failed;
    const total = Number(state.totalPlanned || 0);
    const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    panel.querySelector('.batch-progress-summary').textContent = `الحالة: ${state.status} | اكتمل ${completed}/${total} | نجح ${succeeded} | فشل ${failed}`;
    panel.querySelector('.batch-progress-current').textContent = state.current
        ? `جارٍ إضافة: ${state.current.product?.name_en || `ID ${state.current.product?.local_id || ''}`}`
        : (state.pending?.length ? `${state.pending.length} منتجات جاهزة في الانتظار` : 'بانتظار تجهيز المنتج التالي');
    panel.querySelector('.batch-progress-bar span').style.width = `${percent}%`;
    panel.querySelector('.batch-pause').style.display = state.status === 'running' ? '' : 'none';
    panel.querySelector('.batch-resume').style.display = state.status === 'paused' ? '' : 'none';
    panel.querySelector('.batch-retry').style.display = state.status === 'completed' && retryableFailed > 0 ? '' : 'none';
    panel.querySelector('.batch-cancel').disabled = ['completed', 'cancelled'].includes(state.status);
    panel.classList.toggle('completed', state.status === 'completed');
    panel.classList.toggle('failed', state.status === 'cancelled');
}

async function restoreBatchQueueState() {
    const response = await safeRuntimeMessage({ action: 'GET_BATCH_QUEUE_STATE' });
    if (response?.success && response.state?.batchId && !['completed', 'cancelled'].includes(response.state.status)) {
        renderBatchProgressPanel(response.state);
    }
}

// Arabic: استقبال نتيجة تبويب إعادة المحاولة بعد أن يغلقه Service Worker.
// English: Receive the temporary retry-tab result after the service worker closes it.
function installSubmissionResultListener() {
    if (!isExtensionContextAvailable()) return;

    chrome.runtime.onMessage.addListener(message => {
        if (message?.action === 'ALPHACODE_BATCH_UPDATE') {
            renderBatchProgressPanel(message.state || {});
            return false;
        }

        if (
            message?.action
            !== 'ALPHACODE_SUBMISSION_RESULT'
        ) {
            return false;
        }

        const result = message.result || {
            success: false,
            error: 'لم تصل نتيجة صالحة من تبويب الإضافة.',
        };

        const productId = Number(result.productId || 0);
        const context = (
            automaticSubmissionContexts.get(productId)
            || {}
        );

        automaticSubmissionContexts.delete(productId);

        renderAutomaticSubmissionResult(
            result,
            context,
        );

        return false;
    });

    chrome.storage.onChanged.addListener(
        (changes, areaName) => {
            if (areaName === 'local' && changes.alphacodeBatchQueueState?.newValue) {
                renderBatchProgressPanel(changes.alphacodeBatchQueueState.newValue);
            }

            if (
                areaName !== 'local'
                || !changes.alphacodeSubmissionResult?.newValue
            ) {
                return;
            }

            const result = (
                changes.alphacodeSubmissionResult.newValue
            );

            const productId = Number(
                result.productId || 0,
            );

            const context = (
                automaticSubmissionContexts.get(productId)
                || {}
            );

            automaticSubmissionContexts.delete(productId);

            renderAutomaticSubmissionResult(
                result,
                context,
            );

            safeStorageRemove([
                'alphacodeSubmissionResult',
            ]);
        },
    );
}

// Arabic: استعادة نتيجة احتياطية حُفظت إذا كانت صفحة المورد غير جاهزة وقت الإرسال.
// English: Restore a fallback result saved while the supplier page was not ready.
async function restoreStoredSubmissionResult() {
    const stored = await safeStorageGet([
        'alphacodeSubmissionResult',
    ]);

    if (!stored.alphacodeSubmissionResult) {
        return false;
    }

    await renderAutomaticSubmissionResult(
        stored.alphacodeSubmissionResult,
    );

    await safeStorageRemove([
        'alphacodeSubmissionResult',
    ]);

    return true;
}

// Arabic: تسجيل أخطاء JavaScript غير المعالجة في سجل Python.
// English: Record unhandled JavaScript errors in the Python log.
function installExtractorErrorLogging() {
    window.addEventListener('error', event => {
        logExtractorEvent('ERROR', 'extractor_window_error', event.message || 'Unknown window error', {
            filename: event.filename,
            line: event.lineno,
            column: event.colno,
            stack: event.error?.stack || ''
        });
    });
    window.addEventListener('unhandledrejection', event => {
        const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || 'Unhandled rejection'));
        logExtractorEvent('ERROR', 'extractor_unhandled_rejection', reason.message, { stack: reason.stack || '' });
    });
}

// Arabic: دالة initializeExtractor جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: initializeExtractor is part of the extraction flow and can be adapted for another store.
async function initializeExtractor() {
    installExtractorErrorLogging();
    installSubmissionResultListener();
    await loadConfiguration();
    restoreBatchSelections();
    await restoreStoredSubmissionResult();
    await restoreBatchQueueState();
    injectExtractionButtons();

    const observer = new MutationObserver(() => {
        if (observerTimer) return;
        observerTimer = setTimeout(() => {
            injectExtractionButtons();
            observerTimer = null;
        }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    fetchBrandsFromServer().catch(() => {});
    loadPricePatterns().catch(() => {});
}

initializeExtractor().catch(async error => {
    acLog('error', 'AlphaCode Extractor initialization failed:', error);
    await logExtractorEvent('ERROR', 'extractor_initialization_failed', error.message, { stack: error.stack || '' });
});