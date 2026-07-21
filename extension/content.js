// =========================================================
// AlphaCode Extractor Pro - Full Gallery, AI Copy, and Shared Settings
// =========================================================

'use strict';

const API_BASE_URL = 'http://127.0.0.1:5000';
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
    BrandName: 'Air Jordan', BrandId: 6, BrandMapJson: '{"Air Jordan":6}',
    SizeAttributeId: 1, SizeChoiceNo: 1, SizeactualChoiceNo: 1, SizeTitle: 'الحجم', DefaultLanguage: 'en',
    SooqifyAddUrl: 'https://admin.sooqifyonline.com/admin/item/add-new',
    StoreProfileName: 'Sooqify Online', StoreDomain: 'admin.sooqifyonline.com',
    SupplierStoreName: 'BRANDKINGDOM', SupplierStoreId: '',
    ImageMaxDimension: 1200, ImageQuality: 60, ImageFormat: 'jpeg',
    OptimizeImageAtSource: true, RequireAllImages: true, MaxImages: 30, StoreImageLimit: 6,
    AIAutoGenerate: true, AIProvider: 'groq', AIModel: 'openai/gpt-oss-120b',
    AIBaseUrl: '', AIKeyEnv: 'GROQ_API_KEY', AIJsonRepairEnabled: true,
    ArabicCopyStyle: 'sales-natural', OfficialResearchOnRegenerate: true,
    AutoAddProduct: false, AutoSubmitDelaySeconds: 0, FastAutofillMode: true,
    BatchModeEnabled: true, BatchPreparationConcurrency: 1, BatchMaximumProducts: 25,
    BatchContinueOnFailure: true, BatchNotifyEachProduct: true, BatchMaxRetries: 1,
    BatchDownloadSelectedImagesOnly: true, BatchReuseStoreTab: true,
    BatchSelectionPersistence: true, AdminPanelPosition: 'middle-left'
};

let extractorConfig = { ...DEFAULT_CONFIG };
let lastAddedSearchCodeGlobal = null;
let observerTimer = null;
let activeAutomaticResultOverlay = null;
const automaticSubmissionContexts = new Map();
const selectedBatchProducts = new Map();
let activeBatchReviewOverlay = null;
let latestBatchQueueState = null;
let batchAiCooldownUntil = 0;

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
    } catch (_) {}
    try {
        await fetch(`${API_BASE_URL}/api/log/client`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.warn('AlphaCode log forwarding failed:', error);
    }
}

// Arabic: تحميل الإعدادات أو القيم الافتراضية عند إعادة تحميل الإضافة.
// English: Load saved configuration or defaults after an extension reload.
async function loadConfiguration() {
    const result = await safeStorageGet(['extractorConfig']);
    extractorConfig = { ...DEFAULT_CONFIG, ...(result.extractorConfig || {}) };
    if (extractorConfig.StoreProfileName === 'BRANDKINGDOM') {
        extractorConfig.StoreProfileName = 'Sooqify Online';
    }
    if (!extractorConfig.SupplierStoreName) {
        extractorConfig.SupplierStoreName = 'BRANDKINGDOM';
    }
    return extractorConfig;
}

if (isExtensionContextAvailable()) {
    try {
        chrome.runtime.onMessage.addListener(message => {
            if (message && message.action === 'UPDATE_CONFIG' && message.config) {
                extractorConfig = { ...DEFAULT_CONFIG, ...message.config };
            }
        });
    } catch (_) {}
}

// Arabic: دالة normalizeText جزء من تدفق الاستخراج ويمكن تخصيصها عند نقل الأداة.
// English: normalizeText is part of the extraction flow and can be adapted for another store.
function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

// Arabic: تقليص نص المورد قبل إرساله للذكاء الاصطناعي وحذف الروابط والرموز الطويلة غير المفيدة.
// English: Compact supplier text before AI requests and remove long URLs or opaque tokens.
function compactAiSourceText(value, maximumLength = 3200) {
    const normalized = normalizeText(value)
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, ' ')
        .replace(/\b[A-Za-z0-9_-]{180,}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const safeLength = Math.max(
        300,
        Math.min(Number(maximumLength) || 3200, 5000),
    );

    return normalized.slice(0, safeLength);
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
    }

    const clipboardCandidates = productBox.querySelectorAll('[data-clipboard-text]');
    for (const candidate of clipboardCandidates) {
        const parentText = normalizeText(candidate.parentElement && candidate.parentElement.textContent).toLowerCase();
        if (!acceptedLabels.some(label => parentText.includes(label))) continue;
        const value = normalizeText(candidate.getAttribute('data-clipboard-text'));
        const match = value.match(/[A-Za-z0-9_-]{3,}/);
        if (match) return match[0];
    }

    const fallbackMatch = normalizeText(productBox.innerText).match(
        /(?:Search\s*Code|搜索码|搜索代码|检索码)\s*[:：#]?\s*([A-Za-z0-9_-]{3,})/i
    );
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
    const patterns = [
        /(?:Item\s*(?:No\.?|Number)|Item\s*#)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i,
        /Style\s*Code\s*[:：#]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i,
        /(?:货号|款号|型号|商品编号)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i,
        /(?:Model\s*(?:No\.?|Number)?)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i
    ];

    for (const pattern of patterns) {
        const match = sourceText.match(pattern);
        if (match) return match[1].replace(/[.,;:]+$/g, '').trim();
    }
    return 'غير محدد';
}

// Arabic: منطق السعر محفوظ كما كان، حسب طلب المستخدم.
// English: Price extraction intentionally remains unchanged.
function extractOriginalPrice(sourceText) {
    let originalPrice = 0;
    const yuanMatch = sourceText.match(/(?:💰|¥|Y|يوان)\s*(\d+)/i);
    if (yuanMatch) {
        originalPrice = parseInt(yuanMatch[1], 10);
    } else {
        const possiblePrices = sourceText.match(/\b\d{2,4}\b/g);
        if (possiblePrices && possiblePrices.length > 0) {
            originalPrice = parseInt(possiblePrices[0], 10);
        }
    }
    return originalPrice;
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

// Arabic: قراءة خريطة البراندات من لوحة الإعدادات دون تعطيل الأداة عند JSON غير صالح.
// English: Parse the configurable brand map without breaking extraction on invalid JSON.
function parseBrandMap() {
    try {
        const parsed = JSON.parse(extractorConfig.BrandMapJson || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const cleaned = {};
        for (const [rawName, rawId] of Object.entries(parsed)) {
            const name = canonicalBrandAlias(rawName);
            const id = Number(rawId || 0);
            if (name && Number.isFinite(id) && id > 0) cleaned[name] = id;
        }
        return cleaned;
    } catch (_) {
        return {};
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

// Arabic: إنشاء اسم إنجليزي محلي قوي عند تعذر Groq.
// English: Build a stronger local English name when Groq is unavailable.
function buildFallbackEnglishName(sourceText, styleCode) {
    let text = normalizeText(sourceText)
        .replace(/^(?:💰|¥|Y|يوان)\s*\d+\s*/i, '')
        .replace(/【[^】]*】/g, ' ')
        .replace(/\b(?:Authentic|Genuine|Original|OG)\b/gi, ' ')
        .replace(/(?:Search\s*Code|搜索码|搜索代码|检索码)\s*[:：#]?\s*[A-Za-z0-9_-]+/gi, ' ')
        .replace(/(?:Item\s*(?:No\.?|Number)|Style\s*Code|货号|款号|型号)\s*[:：#]?\s*[A-Z0-9._/-]+/gi, ' ')
        .replace(/（[^）]*）|\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    text = text.replace(/^(?:Nike\s+)?Jordan\s*(\d+)/i, 'Air Jordan $1').replace(/^AJ\s*(\d+)/i, 'Air Jordan $1');
    if (/\b(?:Air\s+Jordan|Jordan\s*\d+|AJ\s*\d+)\b/i.test(sourceText) && !/^Air Jordan\b/i.test(text)) {
        const model = sourceText.match(/\b(?:Air\s+Jordan|Jordan|AJ)\s*(\d+)(?:\s+(Low|Mid|High))?/i);
        if (model) text = `Air Jordan ${model[1]}${model[2] ? ` ${model[2]}` : ''} ${text}`;
    }
    if (isValidCode(styleCode)) {
        const escapedStyleCode = styleCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`\\s*[-–—|]?\\s*${escapedStyleCode}`, 'ig'), ' ').trim();
    }
    if (!text || containsCjk(text)) text = canonicalBrandName(extractorConfig.BrandName) + ' Lifestyle Sneakers';
    if (!/\b(?:shoe|shoes|sneaker|sneakers|trainer|trainers|footwear|low-top|mid-top|high-top)\b/i.test(text)) {
        if (/\bLow\b/i.test(text)) text += ' Lifestyle Sneakers';
        else if (/\bMid\b/i.test(text)) text += ' Mid-Top Sneakers';
        else if (/\bHigh\b/i.test(text)) text += ' High-Top Sneakers';
        else text += ' Lifestyle Sneakers';
    }
    text = text.replace(/\bLow\s+Low-Top\b/i, 'Low-Top')
        .replace(/\bMid\s+Mid-Top\b/i, 'Mid-Top')
        .replace(/\bHigh\s+High-Top\b/i, 'High-Top');
    text = text.slice(0, 145).trim();
    if (isValidCode(styleCode) && !text.toUpperCase().includes(styleCode.toUpperCase())) text += ` - ${styleCode}`;
    return text;
}

// Arabic: إنشاء وصف إنجليزي محلي قابل للتحرير عند تعذر الذكاء الاصطناعي.
// English: Build an editable local English description when AI is unavailable.
function buildFallbackEnglishDescription(sourceText, styleCode) {
    const sizes = extractSizes(sourceText);
    let description = normalizeText(sourceText)
        .replace(/^(?:💰|¥|Y|يوان)\s*\d+\s*/i, '')
        .replace(/【[^】]*】/g, ' ')
        .replace(/\b(?:Authentic|Genuine|Original|OG)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!description || containsCjk(description)) {
        description = `${buildFallbackEnglishName(sourceText, styleCode)} features a refined sportswear silhouette prepared for an online store listing.`;
    }
    if (sizes.length && !/available in sizes/i.test(description)) description += ` Available in sizes ${sizes.join(', ')}.`;
    return description.slice(0, 1400);
}


// Arabic: إنشاء اسم عربي احتياطي مع إبقاء الموديل والكود واضحين.
// English: Build an Arabic fallback name while preserving model and style code.
function buildFallbackArabicName(sourceText, styleCode) {
    const englishName = buildFallbackEnglishName(sourceText, styleCode)
        .replace(/Air\s+Jordan/gi, 'إير جوردن')
        .replace(/Low-Top Sneakers/gi, 'سنيكرز منخفض')
        .replace(/Mid-Top Sneakers/gi, 'سنيكرز متوسط الارتفاع')
        .replace(/High-Top Sneakers/gi, 'سنيكرز مرتفع')
        .replace(/Lifestyle Sneakers/gi, 'سنيكرز كاجوال');
    return `حذاء ${englishName}`.replace(/\s+/g, ' ').trim().slice(0, 190);
}

// Arabic: إنشاء وصف عربي احتياطي بسيط وقابل للتعديل.
// English: Build a simple editable Arabic fallback description.
function buildFallbackArabicDescription(sourceText, styleCode) {
    const sizes = extractSizes(sourceText);
    const sizeText = sizes.length ? ` ويتوفر بالمقاسات: ${sizes.join('، ')}.` : '';
    return `${buildFallbackArabicName(sourceText, styleCode)} بتصميم رياضي مناسب للعرض في المتجر الإلكتروني.${sizeText}`;
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
async function extractAllImages(productBox, searchCode, styleCode) {
    const visibleImages = extractDomImages(productBox);
    const bridgeImages = await requestBridgeImages(productBox, searchCode, styleCode, visibleImages);
    const combined = new Map();
    visibleImages.forEach(url => addUniqueImage(combined, url));
    bridgeImages.forEach(url => addUniqueImage(combined, url));
    return Array.from(combined.values()).slice(0, Number(extractorConfig.MaxImages || 30));
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
                .catch(() => {});
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
        .catch(() => {});

    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openExtractionModal(parentCard, button);
    });

    container.insertBefore(button, container.firstChild);
    ensureBatchSelectionControl(container, parentCard, button);
    ensureBatchToolbar();
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

    overlay.appendChild(modalBox);
    document.body.appendChild(overlay);
    modalBox.querySelector('.alphacode-close-btn').onclick = () => overlay.remove();
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
    const originalPrice = extractOriginalPrice(sourceText);

    try {
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
        images,
    } = context;

    const addedFee = Number(extractorConfig.AddedFeeYuan || 0);
    const exchangeRate = Number(extractorConfig.ExchangeRate || 0);
    const priceAfterFee = originalPrice + addedFee;
    const priceSAR = Math.round(priceAfterFee * exchangeRate);
    const sizes = extractSizes(sourceText);
    const fallbackNameEN = buildFallbackEnglishName(sourceText, styleCode);
    const fallbackDescriptionEN = buildFallbackEnglishDescription(sourceText, styleCode);
    const fallbackNameAR = buildFallbackArabicName(sourceText, styleCode);
    const fallbackDescriptionAR = buildFallbackArabicDescription(sourceText, styleCode);
    const fallbackBrand = canonicalBrandName(sourceText);

    const contentArea = modalBox.querySelector('#modal-content-area');
    contentArea.className = '';
    contentArea.innerHTML = `
        <div class="alphacode-ai-toolbar">
            <button class="alphacode-ai-btn" id="generateAiBtn" type="button">✨ إنشاء المحتوى العربي والإنجليزي</button>
            <span id="aiStatus" class="alphacode-ai-status">جاهز</span>
        </div>
        <section class="alphacode-json-template-section">
            <div class="alphacode-json-template-heading">
                <div><strong>قالب محتوى JSON خارجي</strong><small>ألصق نتيجة أي ذكاء اصطناعي ثم اضغط قبول القالب.</small></div>
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
        <div class="alphacode-price-row">
            <div class="alphacode-field"><label>السعر الأساسي (يوان):</label><input type="number" id="modPrice"></div>
            <div class="alphacode-field"><label>بعد إضافة ${addedFee} يوان:</label><input type="number" id="modPriceFee" disabled></div>
        </div>
        <div class="alphacode-readonly-group">
            <div class="alphacode-readonly-item"><span>السعر بعد المصارفة:</span><strong id="displaySAR" class="alphacode-success-text"></strong></div>
            <div class="alphacode-readonly-item"><span>Category / SubCategory:</span><strong>${extractorConfig.CategoryId} / ${extractorConfig.SubCategoryId}</strong></div>
            <div class="alphacode-readonly-item"><span>صور المعرض الكامل:</span><strong class="alphacode-image-count">${images.length} صور</strong></div>
            <div class="alphacode-readonly-item"><span>متجر المورد:</span><strong>${normalizeText(extractorConfig.SupplierStoreName) || 'غير محدد'} / ${resolveSupplierStoreId() || 'لا يوجد ID'}</strong></div>
            <div class="alphacode-readonly-item"><span>Search Code:</span><strong>${searchCode || 'غير موجود'}</strong></div>
            <div class="alphacode-readonly-item alphacode-code-row"><span>Style Code / Item No.:</span><div><button class="alphacode-copy-btn" id="copyStyleBtn" type="button">📋 نسخ</button><strong>${styleCode}</strong></div></div>
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
        const copied = await copyTextToClipboard(styleCode);
        event.currentTarget.textContent = copied ? '✔ تم النسخ' : 'تعذر النسخ';
    };

    modalBox.querySelector('#cancelBtn').onclick = () => overlay.remove();

    let successfulAiGenerations = 0;

    const runAiGeneration = async () => {
        const officialResearch = successfulAiGenerations > 0
            && extractorConfig.OfficialResearchOnRegenerate !== false;
        const generated = await generateProductCopy({
            modalBox,
            sourceText,
            originalProductName,
            searchCode,
            styleCode,
            fields,
            officialResearch,
        });

        if (generated) {
            successfulAiGenerations += 1;
            modalBox.querySelector('#generateAiBtn').textContent = (
                '🔎 البحث الرسمي وإعادة إنشاء المحتوى'
            );
        }
    };

    modalBox.querySelector('#generateAiBtn').onclick = runAiGeneration;

    // Arabic: التشغيل التلقائي الأول يستخدم التوليد العادي فقط دون بحث رسمي.
    // English: The first automatic generation uses normal AI without official-store research.
    if (extractorConfig.AIAutoGenerate) {
        runAiGeneration();
    }

    modalBox.querySelector('#confirmExtractBtn').onclick = () => submitProduct({
        overlay,
        modalBox,
        buttonElement,
        sourceText,
        originalProductName,
        searchCode,
        styleCode,
        images,
        fields,
        imageSelection,
    });
}

// Arabic: التوليد الأول عادي، والضغطات التالية تبحث عن المنتج نفسه في الموقع الرسمي فقط.
// English: The first generation is normal; later clicks research only this product on the official site.
async function generateProductCopy(context) {
    const {
        modalBox,
        sourceText,
        originalProductName,
        searchCode,
        styleCode,
        fields,
        officialResearch = false,
    } = context;

    const aiButton = modalBox.querySelector(
        '#generateAiBtn',
    );

    const aiStatus = modalBox.querySelector(
        '#aiStatus',
    );

    aiButton.disabled = true;
    aiButton.textContent = officialResearch
        ? '⏳ بحث رسمي لهذا المنتج فقط...'
        : '⏳ إنشاء المحتوى...';

    aiStatus.className = (
        'alphacode-ai-status alphacode-ai-working'
    );

    aiStatus.textContent = officialResearch
        ? 'جارٍ البحث بالـ Style Code في الموقع الرسمي للشركة'
        : 'جارٍ إنشاء الاسم والوصف بالطريقة العادية';

    try {
        const sizes = uniqueSizes(
            fields.sizes.value
                .split(/[,،\s]+/)
                .filter(Boolean),
        );

        const response = await fetch(
            `${API_BASE_URL}/api/ai/generate`,
            {
                method: 'POST',
                cache: 'no-store',
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                },
                body: JSON.stringify({
                    // Arabic: البحث الرسمي يحتاج بيانات مختصرة فقط لتجنب خطأ 413.
                    // English: Official research receives compact data to avoid HTTP 413.
                    SourceText: compactAiSourceText(
                        sourceText,
                        officialResearch ? 1600 : 3600,
                    ),
                    OriginalProductName: compactAiSourceText(
                        originalProductName || '',
                        320,
                    ),
                    SearchCode: String(
                        searchCode || 'NONE',
                    ).slice(0, 80),
                    StyleCode: String(
                        styleCode || '',
                    ).slice(0, 80),
                    Sizes: sizes.slice(0, 40),
                    BrandName: String(
                        fields.brandName.value || '',
                    ).slice(0, 100),
                    AIProvider: extractorConfig.AIProvider || 'groq',
                    AIModel: extractorConfig.AIModel,
                    AIBaseUrl: extractorConfig.AIBaseUrl || '',
                    AIKeyEnv: extractorConfig.AIKeyEnv || 'GROQ_API_KEY',
                    AIJsonRepairEnabled: extractorConfig.AIJsonRepairEnabled !== false,
                    ArabicCopyStyle: extractorConfig.ArabicCopyStyle || 'sales-natural',
                    AllowedBrands: getAllowedBrandNames(),
                    ResearchOfficial:
                        Boolean(officialResearch),
                    RegenerateNonce:
                        `${Date.now()}_${Math.random()}`,
                    UseCache: false,
                }),
            },
        );

        const data = await response.json();

        if (!response.ok || !data.success) {
            if (
                response.status === 429
                && Number(data.retry_after_seconds) > 0
            ) {
                throw new Error(
                    `تم بلوغ حد Groq. أعد المحاولة بعد ${data.retry_after_seconds} ثانية.`,
                );
            }

            if (
                response.status === 413
                || data.request_too_large
            ) {
                throw new Error(
                    'بيانات البحث كانت أكبر من الحد المسموح. تم تقليص الطلب في النسخة الجديدة؛ أعد تشغيل خادم Python ثم جرّب مرة أخرى.',
                );
            }

            throw new Error(
                data.error
                || `فشل طلب الذكاء الاصطناعي (${response.status})`,
            );
        }

        fields.nameEN.value = data.name_en;
        fields.descEN.value = data.description_en;
        fields.nameAR.value = data.name_ar;
        fields.descAR.value = data.description_ar;
        fields.brandName.value = canonicalBrandName(
            data.brand_name,
        );
        fields.brandId.value = resolveBrandId(
            fields.brandName.value,
        );

        aiStatus.className = (
            'alphacode-ai-status alphacode-ai-success'
        );

        aiStatus.textContent = officialResearch
            ? `تم التحقق من هذا المنتج في ${data.official_domain || 'الموقع الرسمي'} وصياغة محتوى عربي تسويقي جديد`
            : 'تم إنشاء المحتوى بالطريقة العادية. اضغط الزر مرة أخرى للبحث الرسمي إذا لم تعجبك النتيجة.';

        return true;

    } catch (error) {
        aiStatus.className = (
            'alphacode-ai-status alphacode-ai-error'
        );

        aiStatus.textContent = (
            `${error.message} — تم الاحتفاظ بالنص الحالي القابل للتعديل.`
        );

        return false;

    } finally {
        aiButton.disabled = false;
        aiButton.textContent = officialResearch
            ? '🔎 البحث الرسمي وإعادة إنشاء المحتوى'
            : '✨ إنشاء المحتوى العربي والإنجليزي';
    }
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
    } = context;

    const submitButton = modalBox.querySelector('#confirmExtractBtn');
    submitButton.textContent = `⏳ تنزيل ${images.length} صور وحفظ المنتج...`;
    submitButton.disabled = true;

    const originalPrice = parseFloat(fields.price.value) || 0;
    const finalFeePrice = originalPrice + Number(extractorConfig.AddedFeeYuan || 0);
    const finalSar = Math.round(finalFeePrice * Number(extractorConfig.ExchangeRate || 0));
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
        Settings: extractorConfig,
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
    } catch (_) {}
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
    } catch (_) {}
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
        originalPrice: extractOriginalPrice(sourceText),
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

    if (selectionLocked) {
        if (selectFirstButton) selectFirstButton.disabled = true;
        if (clearButton) clearButton.disabled = true;
    }

    selectFirstButton?.addEventListener('click', () => {
        if (selectionLocked) return;
        selected.clear();
        for (let index = 0; index < Math.min(limit, draft.images.length); index += 1) selected.add(index);
        mainIndex = Array.from(selected)[0] ?? 0;
        refresh();
    });

    clearButton?.addEventListener('click', () => {
        if (selectionLocked) return;
        selected.clear();
        if (draft.images.length) selected.add(mainIndex >= 0 && mainIndex < draft.images.length ? mainIndex : 0);
        mainIndex = Array.from(selected)[0] ?? 0;
        refresh();
    });

    refresh();
}

async function requestBatchAiCopy(draft, officialResearch = false) {
    const response = await fetch(`${API_BASE_URL}/api/ai/generate`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
            SourceText: compactAiSourceText(draft.sourceText, officialResearch ? 1400 : 3000),
            OriginalProductName: compactAiSourceText(draft.originalProductName, 320),
            SearchCode: String(draft.searchCode || 'NONE').slice(0, 80),
            StyleCode: String(draft.styleCode || '').slice(0, 80),
            Sizes: draft.sizes.slice(0, 40),
            BrandName: draft.brandName,
            AllowedBrands: getAllowedBrandNames(),
            AIProvider: extractorConfig.AIProvider || 'groq',
            AIModel: extractorConfig.AIModel,
            AIBaseUrl: extractorConfig.AIBaseUrl || '',
            AIKeyEnv: extractorConfig.AIKeyEnv || 'GROQ_API_KEY',
            AIJsonRepairEnabled: extractorConfig.AIJsonRepairEnabled !== false,
            ArabicCopyStyle: extractorConfig.ArabicCopyStyle || 'sales-natural',
            ResearchOfficial: Boolean(officialResearch),
            UseCache: false,
            RegenerateNonce: `${Date.now()}_${Math.random()}`,
        }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
        const retry = Number(data.retry_after_seconds || 0);
        const error = new Error(
            retry > 0
                ? `تم بلوغ حد الذكاء الاصطناعي. أعد المحاولة بعد ${retry} ثانية.`
                : (data.error || `AI request failed (${response.status})`),
        );
        error.retryAfterSeconds = retry;
        if (retry > 0) {
            batchAiCooldownUntil = Date.now() + (retry * 1000);
        }
        throw error;
    }

    return data;
}

async function buildBatchDraft(entry, index, total, updateProgress) {
    const card = entry.card?.isConnected ? entry.card : null;
    const sourceText = entry.sourceText || (card ? extractSourceDescription(card) : '');
    const originalProductName = entry.originalProductName || (card ? extractOriginalProductName(card) : sourceText);
    const searchCode = entry.searchCode || (card ? extractSearchCode(card) : '');
    const styleCode = entry.styleCode || extractStyleCode(sourceText);
    const originalPrice = Number(entry.originalPrice || extractOriginalPrice(sourceText));
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
        sizes,
        images,
        imageSelection: defaultBatchImageSelection(images),
        nameEN: buildFallbackEnglishName(sourceText, styleCode),
        descriptionEN: buildFallbackEnglishDescription(sourceText, styleCode),
        nameAR: buildFallbackArabicName(sourceText, styleCode),
        descriptionAR: buildFallbackArabicDescription(sourceText, styleCode),
        brandName: canonicalBrandName(sourceText),
        brandId: 0,
        aiStatus: archiveData.exists ? 'archived' : 'fallback',
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
            }
        } catch (_) {}
    }

    if (
        !archiveData.exists
        && extractorConfig.AIAutoGenerate
        && Date.now() >= batchAiCooldownUntil
    ) {
        updateProgress?.(`إنشاء محتوى المنتج ${index + 1} من ${total}...`);
        try {
            const generated = await requestBatchAiCopy(draft, false);
            draft.nameEN = generated.name_en;
            draft.descriptionEN = generated.description_en;
            draft.nameAR = generated.name_ar;
            draft.descriptionAR = generated.description_ar;
            draft.brandName = canonicalBrandName(generated.brand_name);
            draft.brandId = resolveBrandId(draft.brandName);
            draft.aiStatus = 'generated';
        } catch (error) {
            draft.aiStatus = 'fallback';
            draft.aiError = error.message;
        }
    } else if (!archiveData.exists && Date.now() < batchAiCooldownUntil) {
        const seconds = Math.max(1, Math.ceil((batchAiCooldownUntil - Date.now()) / 1000));
        draft.aiError = `تم إيقاف طلبات الذكاء الاصطناعي لبقية الدفعة مؤقتاً بسبب Rate Limit لمدة ${seconds} ثانية.`;
    }

    return draft;
}

function renderBatchReviewSlides(modalBox, drafts) {
    const content = modalBox.querySelector('#modal-content-area');
    const brandOptions = getAllowedBrandNames()
        .map(brand => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`)
        .join('');

    content.className = '';
    content.innerHTML = `
        <div class="alphacode-batch-review-header">
            <strong>مراجعة دفعة من ${drafts.length} منتجات</strong>
            <span id="alphacodeBatchSlideCounter"></span>
        </div>
        <div class="alphacode-batch-slide-list">
            ${drafts.map((draft, index) => `
                <section class="alphacode-batch-slide" data-index="${index}">
                    <div class="alphacode-batch-slide-top">
                        <label><input class="batch-include" type="checkbox" ${draft.include ? 'checked' : ''} ${draft.archiveData.workflow_status === 'submitted' ? 'disabled' : ''}> ${draft.archiveData.workflow_status === 'submitted' ? 'مضاف سابقاً للمتجر' : 'إضافة هذا المنتج'}</label>
                        <span class="batch-draft-status ${draft.aiStatus}">${draft.archiveData.exists ? `مؤرشف ID ${draft.archiveData.id}` : (draft.aiStatus === 'generated' ? 'تم إنشاء المحتوى' : 'صياغة محلية احتياطية')}</span>
                    </div>
                    <section class="batch-image-selector-section">
                        <div class="batch-image-selector-heading">
                            <div><strong>اختيار صور هذا المنتج</strong><small>حدد حتى ${Math.min(Number(extractorConfig.StoreImageLimit || 6), 6)} صور واختر الرئيسية.</small></div>
                            <span class="batch-image-counter"></span>
                        </div>
                        <div class="batch-image-selector-actions">
                            <button class="batch-select-first-images" type="button">اختيار أول 6</button>
                            <button class="batch-clear-images" type="button">الإبقاء على الرئيسية فقط</button>
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
                        <div class="alphacode-field"><label>السعر باليوان</label><input class="batch-price" type="number" value="${Number(draft.originalPrice || 0)}"></div>
                        <div class="alphacode-field alphacode-wide-field"><label>المقاسات</label><input class="batch-sizes" dir="ltr" value="${escapeHtml(draft.sizes.join(', '))}"></div>
                    </div>
                    <div class="alphacode-readonly-group">
                        <div class="alphacode-readonly-item"><span>Style Code</span><strong>${escapeHtml(draft.styleCode)}</strong></div>
                        <div class="alphacode-readonly-item"><span>Search Code</span><strong>${escapeHtml(draft.searchCode || '-')}</strong></div>
                        <div class="alphacode-readonly-item"><span>الصور المكتشفة</span><strong>${draft.images.length}</strong></div>
                    </div>
                    <button class="alphacode-ai-btn batch-official-regenerate" type="button" ${draft.archiveData.exists ? 'disabled' : ''}>🔎 بحث رسمي وإعادة صياغة هذا المنتج</button>
                    <span class="alphacode-ai-status batch-ai-status">${escapeHtml(draft.aiError || '')}</span>
                </section>`).join('')}
        </div>
        <div class="alphacode-batch-navigation">
            <button id="alphacodeBatchPrev" type="button">السابق</button>
            <div class="alphacode-batch-dots">${drafts.map((_, index) => `<button type="button" data-slide="${index}"></button>`).join('')}</div>
            <button id="alphacodeBatchNext" type="button">التالي</button>
        </div>
        <div class="alphacode-actions">
            <button class="alphacode-btn-submit" id="alphacodeStartBatch" type="button">بدء التجهيز والإضافة المتتابعة</button>
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
        slide.querySelector('.batch-official-regenerate').onclick = async event => {
            const status = slide.querySelector('.batch-ai-status');
            event.currentTarget.disabled = true;
            status.textContent = 'جارٍ البحث في الموقع الرسمي فقط...';
            try {
                const generated = await requestBatchAiCopy(draft, true);
                slide.querySelector('.batch-name-en').value = generated.name_en;
                slide.querySelector('.batch-desc-en').value = generated.description_en;
                slide.querySelector('.batch-name-ar').value = generated.name_ar;
                slide.querySelector('.batch-desc-ar').value = generated.description_ar;
                draft.brandName = canonicalBrandName(generated.brand_name);
                draft.brandId = resolveBrandId(draft.brandName);
                slide.querySelector('.batch-brand').value = draft.brandName;
                status.textContent = `تم البحث في ${generated.official_domain || 'الموقع الرسمي'}.`;
            } catch (error) {
                status.textContent = error.message;
            } finally {
                event.currentTarget.disabled = false;
            }
        };
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

    content.querySelector('#alphacodeCancelBatchReview').onclick = () => activeBatchReviewOverlay?.remove();
    content.querySelector('#alphacodeStartBatch').onclick = async event => {
        const includedDrafts = [];
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
            draft.sizes = uniqueSizes(slide.querySelector('.batch-sizes').value.split(/[,،\s]+/).filter(Boolean));
            if (draft.include) includedDrafts.push(draft);
        });

        if (!includedDrafts.length) {
            alert('لم يتم اختيار أي منتج داخل شاشة المراجعة.');
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

async function prepareBatchDraftForStore(draft, batchId, batchIndex, batchTotal) {
    let pendingProduct = null;
    let productId = Number(draft.archiveData?.id || 0);

    if (draft.archiveData?.exists && productId) {
        const pendingResponse = await fetch(`${API_BASE_URL}/api/pending/${productId}`, { cache: 'no-store' });
        const pendingData = await pendingResponse.json();
        if (!pendingResponse.ok || !pendingData.success) throw new Error(pendingData.error || 'تعذر جلب المنتج المؤرشف.');
        pendingProduct = pendingData.pending_product;
    } else {
        const addedFee = Number(extractorConfig.AddedFeeYuan || 0);
        const exchangeRate = Number(extractorConfig.ExchangeRate || 0);
        const priceAfterFee = draft.originalPrice + addedFee;
        const priceSAR = Math.round(priceAfterFee * exchangeRate);
        const imageSelection = draft.imageSelection || defaultBatchImageSelection(draft.images);
        if (!imageSelection.selectedIndexes?.length) {
            throw new Error('اختر صورة واحدة على الأقل لهذا المنتج.');
        }
        const batchSettings = {
            ...extractorConfig,
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
            Sizes: draft.sizes,
            OriginalPrice: draft.originalPrice,
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

    await mapWithConcurrency(drafts, concurrency, async (draft, index) => {
        const maximumAttempts = 1 + Math.max(0, Math.min(Number(extractorConfig.BatchMaxRetries || 0), 2));
        let lastError = null;

        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            try {
                return await prepareBatchDraftForStore(draft, batchId, index + 1, drafts.length);
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
}

initializeExtractor().catch(async error => {
    console.error('AlphaCode Extractor initialization failed:', error);
    await logExtractorEvent('ERROR', 'extractor_initialization_failed', error.message, { stack: error.stack || '' });
});
