// =========================================================
// AlphaCode Extractor - Background Service Worker
// Arabic: يدير رفع الصور، الإضافة الخلفية إلى Sooqify، ومسار إعادة المحاولة في تبويب مؤقت.
// English: Manages image fetching, background Sooqify submission, and temporary-tab retry flow.
// =========================================================

'use strict';

const LOCAL_API_BASE = 'http://127.0.0.1:5000';
const DEFAULT_SOOQIFY_ADD_URL = 'https://admin.sooqifyonline.com/admin/item/add-new';
const FALLBACK_JOBS_KEY = 'alphacodeFallbackSubmissionJobs';
const BATCH_QUEUE_KEY = 'alphacodeBatchQueueState';
const BATCH_ALARM_NAME = 'alphacodeBatchQueueWake';
let batchLaunchLock = false;

// Arabic: تحويل Uint8Array إلى Base64 على دفعات لتجنب تجاوز مكدس الاستدعاء.
// English: Convert bytes to Base64 in chunks to avoid call-stack overflow.
function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;

    for (
        let offset = 0;
        offset < bytes.length;
        offset += chunkSize
    ) {
        binary += String.fromCharCode(
            ...bytes.subarray(
                offset,
                Math.min(offset + chunkSize, bytes.length),
            ),
        );
    }

    return btoa(binary);
}

// Arabic: تنظيف قيمة نصية قبل استخدامها في الطلب أو السجل.
// English: Normalize a text value before request or log usage.
function normalizeText(value) {
    return String(value ?? '').trim();
}

// Arabic: تحويل قيمة إلى رقم صحيح آمن.
// English: Convert a value to a safe integer.
function safeInteger(value, fallback = 0) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
}

// Arabic: فك أشهر HTML entities دون الاعتماد على DOMParser غير المتاح في Service Worker.
// English: Decode common HTML entities without DOMParser, which is unavailable in service workers.
function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;|&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => (
            String.fromCodePoint(Number.parseInt(hex, 16))
        ))
        .replace(/&#([0-9]+);/g, (_match, decimal) => (
            String.fromCodePoint(Number.parseInt(decimal, 10))
        ));
}

// Arabic: قراءة خصائص وسم HTML بسيط مثل input أو form.
// English: Parse attributes from a simple HTML tag such as input or form.
function parseHtmlAttributes(tagText) {
    const attributes = {};
    const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let match = null;

    while ((match = pattern.exec(tagText))) {
        const name = String(match[1] || '').toLowerCase();
        if (!name) continue;
        attributes[name] = decodeHtmlEntities(
            match[2] ?? match[3] ?? match[4] ?? '',
        );
    }

    return attributes;
}

// Arabic: العثور على نموذج إضافة المنتج الحقيقي داخل HTML صفحة المتجر.
// English: Locate the real product-add form in the store page HTML.
function extractProductForm(html) {
    const forms = String(html || '').match(/<form\b[\s\S]*?<\/form>/gi) || [];
    const formHtml = forms.find(candidate => (
        /name\s*=\s*["']name\[\]["']/i.test(candidate)
        && /name\s*=\s*["']price["']/i.test(candidate)
    ));

    if (!formHtml) {
        throw new Error(
            'لم يتم العثور على نموذج إضافة المنتج في Sooqify. تأكد من تسجيل الدخول إلى لوحة المتجر.',
        );
    }

    const openingTag = formHtml.match(/^<form\b[^>]*>/i)?.[0] || '<form>';
    return {
        html: formHtml,
        attributes: parseHtmlAttributes(openingTag),
    };
}

// Arabic: استخراج الحقول المخفية الأصلية مثل CSRF وأي إعدادات مطلوبة من الخادم.
// English: Extract original hidden fields such as CSRF and server-required defaults.
function appendOriginalHiddenFields(formData, formHtml) {
    const inputs = String(formHtml || '').match(/<input\b[^>]*>/gi) || [];

    for (const inputTag of inputs) {
        const attributes = parseHtmlAttributes(inputTag);
        const type = normalizeText(attributes.type || 'text').toLowerCase();
        const name = normalizeText(attributes.name);

        if (
            !name
            || type !== 'hidden'
            || Object.prototype.hasOwnProperty.call(attributes, 'disabled')
        ) {
            continue;
        }

        formData.append(name, attributes.value || '');
    }
}

// Arabic: استخراج CSRF من meta عند عدم وجوده كحقل مخفي.
// English: Extract CSRF from a meta tag when it is not available as a hidden field.
function extractCsrfToken(html) {
    const metaTags = String(html || '').match(/<meta\b[^>]*>/gi) || [];

    for (const metaTag of metaTags) {
        const attributes = parseHtmlAttributes(metaTag);
        const name = normalizeText(attributes.name).toLowerCase();

        if (name === 'csrf-token' && attributes.content) {
            return attributes.content;
        }
    }

    const tokenMatch = String(html || '').match(
        /name\s*=\s*["']_token["'][^>]*value\s*=\s*["']([^"']+)["']/i,
    );

    return decodeHtmlEntities(tokenMatch?.[1] || '');
}

// Arabic: حذف كل القيم السابقة ثم إضافة قيمة مفردة.
// English: Remove previous values and append one value.
function setSingleFormValue(formData, name, value) {
    formData.delete(name);
    formData.append(name, String(value ?? ''));
}

// Arabic: حذف القيم السابقة ثم إضافة قائمة قيم متكررة للاسم نفسه.
// English: Replace a repeated form field with a new list of values.
function setRepeatedFormValues(formData, name, values) {
    formData.delete(name);

    for (const value of values || []) {
        formData.append(name, String(value ?? ''));
    }
}

// Arabic: جلب صورة محلية وإعادتها إلى content script بصيغة Base64.
// English: Fetch a local image and return it to the content script as Base64.
async function fetchLocalFile(message) {
    const response = await fetch(message.url, {
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`Image request failed (${response.status})`);
    }

    const bytes = new Uint8Array(
        await response.arrayBuffer(),
    );

    return {
        success: true,
        base64: bytesToBase64(bytes),
        mimeType: response.headers.get('content-type') || 'image/jpeg',
        fileName: message.fileName || 'product.jpg',
    };
}

// Arabic: جلب صورة المنتج كـ Blob لإرسالها مباشرة إلى Sooqify.
// English: Fetch a product image as a Blob for direct Sooqify submission.
async function fetchProductImageBlob(imageInfo) {
    const response = await fetch(imageInfo.url, {
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(
            `تعذر جلب الصورة ${imageInfo.name || ''} (${response.status}).`,
        );
    }

    return {
        blob: await response.blob(),
        fileName: imageInfo.name || 'product.jpg',
    };
}

// Arabic: إرسال حدث الواجهة إلى سجل Flask الخارجي دون تعطيل الأداة عند فشل الخادم.
// English: Send a UI event to the Flask external log without breaking the extension if unavailable.
async function forwardClientLog(message) {
    const response = await fetch(`${LOCAL_API_BASE}/api/log/client`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(message.payload || {}),
    });

    if (!response.ok) {
        throw new Error(`Log request failed (${response.status})`);
    }

    return { success: true };
}

// Arabic: تحديث حالة المنتج في أرشيف Flask من Service Worker.
// English: Update the product workflow status in the Flask archive from the service worker.
async function updateWorkflowStatus(productId, status, details = {}) {
    const response = await fetch(
        `${LOCAL_API_BASE}/api/archive/product/${Number(productId)}/status`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                status,
                details,
            }),
        },
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.success) {
        throw new Error(
            data.error || `Workflow update failed (${response.status})`,
        );
    }

    return data.product;
}

// Arabic: تكوين FormData متوافق مع نموذج Sooqify الحالي.
// English: Build FormData compatible with the current Sooqify product form.
async function buildSooqifyFormData(product, pageHtml, formHtml) {
    const settings = product.settings || {};
    const sizes = Array.from(
        new Set(
            (product.sizes || [])
                .map(value => normalizeText(value))
                .filter(Boolean),
        ),
    );

    const stockPerSize = Math.max(
        0,
        safeInteger(settings.Stock, 100),
    );

    const totalStock = sizes.length
        ? stockPerSize * sizes.length
        : stockPerSize;

    const attributeId = normalizeText(
        settings.SizeAttributeId || 1,
    );

    const choiceNo = normalizeText(
        settings.SizeChoiceNo
        || settings.SizeactualChoiceNo
        || 1,
    );

    const choiceTitle = normalizeText(
        settings.SizeTitle || 'الحجم',
    ) || 'الحجم';

    const defaultLanguage = normalizeText(
        settings.DefaultLanguage || 'en',
    ).toLowerCase();

    const nameEn = normalizeText(product.name_en);
    const nameAr = normalizeText(product.name_ar || nameEn);
    const descriptionEn = normalizeText(product.description_en);
    const descriptionAr = normalizeText(
        product.description_ar || descriptionEn,
    );

    const defaultName = defaultLanguage === 'ar'
        ? nameAr
        : nameEn;

    const defaultDescription = defaultLanguage === 'ar'
        ? descriptionAr
        : descriptionEn;

    const formData = new FormData();
    appendOriginalHiddenFields(formData, formHtml);

    const csrfToken = extractCsrfToken(pageHtml);
    if (csrfToken && !formData.get('_token')) {
        formData.append('_token', csrfToken);
    }

    setRepeatedFormValues(
        formData,
        'lang[]',
        ['default', 'en', 'ar'],
    );

    setRepeatedFormValues(
        formData,
        'name[]',
        [defaultName, nameEn, nameAr],
    );

    setRepeatedFormValues(
        formData,
        'description[]',
        [defaultDescription, descriptionEn, descriptionAr],
    );

    setSingleFormValue(
        formData,
        'store_id',
        settings.StoreId || 3,
    );

    setSingleFormValue(
        formData,
        'category_id',
        settings.CategoryId || 41,
    );

    setSingleFormValue(
        formData,
        'sub_category_id',
        settings.SubCategoryId || 42,
    );

    setSingleFormValue(
        formData,
        'brand_id',
        product.brand_id || 6,
    );

    setSingleFormValue(
        formData,
        'unit',
        settings.UnitId || 1,
    );

    const vegValue = ['1', 'true', 'yes', 'on'].includes(
        normalizeText(settings.Veg).toLowerCase(),
    ) ? '1' : '0';

    setSingleFormValue(
        formData,
        'veg',
        vegValue,
    );

    setSingleFormValue(
        formData,
        'price',
        product.price || 0,
    );

    setSingleFormValue(
        formData,
        'current_stock',
        totalStock,
    );

    setSingleFormValue(
        formData,
        'discount_type',
        settings.DiscountType || 'percent',
    );

    setSingleFormValue(
        formData,
        'discount',
        settings.Discount ?? 0,
    );

    setSingleFormValue(
        formData,
        'maximum_cart_quantity',
        settings.MaximumCartQuantity || '',
    );

    setSingleFormValue(
        formData,
        'available_time_starts',
        settings.AvailableTimeStarts || '00:00',
    );

    setSingleFormValue(
        formData,
        'available_time_ends',
        settings.AvailableTimeEnds || '23:59',
    );

    // Arabic: وضع ID المحلي في حقل العلامات مثل التعبئة المرئية.
    // English: Put the local product ID in the tags field, matching visible autofill.
    setSingleFormValue(
        formData,
        'tags',
        product.local_id || '',
    );

    formData.delete('attribute_id[]');
    formData.delete('choice_no[]');
    formData.delete('choice[]');
    formData.delete(`choice_options_${choiceNo}[]`);

    if (sizes.length) {
        formData.append('attribute_id[]', attributeId);
        formData.append('choice_no[]', choiceNo);
        formData.append('choice[]', choiceTitle);

        for (const size of sizes) {
            formData.append(
                `choice_options_${choiceNo}[]`,
                size,
            );

            setSingleFormValue(
                formData,
                `price_${size}`,
                product.price || 0,
            );

            setSingleFormValue(
                formData,
                `stock_${size}`,
                stockPerSize,
            );
        }
    }

    const imageInfoList = Array.isArray(product.image_files)
        ? product.image_files.slice(0, 6)
        : [];

    if (!imageInfoList.length) {
        throw new Error('لا توجد صور مجهزة لإرسال المنتج في الخلفية.');
    }

    const imageFiles = await Promise.all(
        imageInfoList.map(fetchProductImageBlob),
    );

    formData.delete('image');
    formData.delete('item_images[]');

    formData.append(
        'image',
        imageFiles[0].blob,
        imageFiles[0].fileName,
    );

    for (const galleryImage of imageFiles.slice(1)) {
        formData.append(
            'item_images[]',
            galleryImage.blob,
            galleryImage.fileName,
        );
    }

    return {
        formData,
        sizes,
        totalStock,
        imageCount: imageFiles.length,
    };
}

// Arabic: استخراج رسائل التحقق من HTML عند رفض النموذج.
// English: Extract validation messages from HTML when the form is rejected.
function extractValidationMessage(html) {
    const text = String(html || '');
    const patterns = [
        /<[^>]+class=["'][^"']*(?:alert-danger|invalid-feedback|text-danger)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
        /<li[^>]*>([\s\S]*?)<\/li>/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const message = decodeHtmlEntities(
            match[1].replace(/<[^>]+>/g, ' '),
        ).replace(/\s+/g, ' ').trim();

        if (message) return message;
    }

    return '';
}

// Arabic: استخراج ID المتجر من رابط التحويل أو HTML إن كان متاحاً.
// English: Extract the store product ID from the redirect URL or HTML when available.
function extractStoreProductId(finalUrl, html) {
    const urlMatch = String(finalUrl || '').match(
        /\/admin\/item\/(?:edit\/)?(\d+)(?:\b|\/|\?)/i,
    );

    if (urlMatch) return Number(urlMatch[1]);

    const htmlMatch = String(html || '').match(
        /(?:item_id|product_id|data-id)["'\s:=]+(\d+)/i,
    );

    return htmlMatch ? Number(htmlMatch[1]) : null;
}


// =========================================================
// AlphaCode Batch Queue
// Arabic: طابور دائم منخفض الموارد يرسل منتجاً واحداً فقط إلى Sooqify في كل لحظة.
// English: A persistent low-resource queue that submits exactly one product at a time.
// =========================================================

async function readBatchQueueState() {
    const stored = await chrome.storage.local.get(BATCH_QUEUE_KEY);
    return stored[BATCH_QUEUE_KEY] || null;
}

async function writeBatchQueueState(state) {
    await chrome.storage.local.set({ [BATCH_QUEUE_KEY]: state });
    await broadcastBatchQueueState(state);
    return state;
}

async function broadcastBatchQueueState(state) {
    if (!state) return;
    const sourceTabId = Number(state.sourceTabId);
    if (Number.isInteger(sourceTabId)) {
        try {
            await chrome.tabs.sendMessage(sourceTabId, {
                action: 'ALPHACODE_BATCH_UPDATE',
                state,
            });
        } catch (_) {}
    }
}

async function showBatchNotification(title, message, notificationId = '') {
    try {
        await chrome.notifications.create(
            notificationId || `alphacode_${Date.now()}`,
            {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('icons/icon128.png'),
                title: String(title || 'AlphaCode'),
                message: String(message || ''),
                priority: 1,
            },
        );
    } catch (_) {}
}

function createInitialBatchState(message, sourceTabId) {
    return {
        batchId: normalizeText(message.batchId) || `batch_${Date.now()}`,
        status: 'running',
        sourceTabId: Number(sourceTabId || 0),
        addUrl: message.addUrl || DEFAULT_SOOQIFY_ADD_URL,
        totalPlanned: Math.max(1, safeInteger(message.totalPlanned, 1)),
        continueOnFailure: message.continueOnFailure !== false,
        notifyEachProduct: message.notifyEachProduct !== false,
        maxRetries: Math.max(0, Math.min(safeInteger(message.maxRetries, 0), 3)),
        finalized: false,
        pending: [],
        current: null,
        results: [],
        preparationFailures: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

async function startBatchQueue(message, sender) {
    const sourceTabId = sender.tab?.id;
    if (!Number.isInteger(sourceTabId)) throw new Error('تعذر تحديد تبويب صفحة المورد لبدء الدفعة.');

    const current = await readBatchQueueState();
    if (current && ['running', 'paused'].includes(current.status) && current.batchId !== message.batchId) {
        throw new Error('توجد دفعة أخرى قيد التنفيذ. أكملها أو ألغها أولاً.');
    }

    const state = createInitialBatchState(message, sourceTabId);
    await writeBatchQueueState(state);
    await showBatchNotification('بدأت دفعة AlphaCode', `سيتم تجهيز وإضافة ${state.totalPlanned} منتجات بالتتابع.`, `alphacode_batch_${state.batchId}`);
    return { success: true, state };
}

async function enqueueBatchProduct(message) {
    const state = await readBatchQueueState();
    if (!state || state.batchId !== message.batchId) throw new Error('طابور الدفعة غير موجود أو تغير معرّفه.');
    if (['cancelled', 'completed'].includes(state.status)) throw new Error('انتهى طابور الدفعة ولا يمكن إضافة منتج جديد إليه.');

    const product = message.product;
    if (!product?.local_id) throw new Error('المنتج المجهز لا يحتوي على ID محلي.');
    const productId = Number(product.local_id);
    const alreadyQueued = state.pending.some(item => Number(item.product?.local_id) === productId)
        || Number(state.current?.product?.local_id) === productId
        || state.results.some(item => Number(item.productId) === productId);

    if (!alreadyQueued) {
        state.pending.push({
            product,
            searchCode: normalizeText(message.searchCode),
            styleCode: normalizeText(message.styleCode),
            addUrl: message.addUrl || state.addUrl || DEFAULT_SOOQIFY_ADD_URL,
            attempts: 0,
            queuedAt: Date.now(),
        });
    }
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);
    await processBatchQueue();
    return { success: true, state: await readBatchQueueState() };
}

async function reportBatchPreparationFailure(message) {
    const state = await readBatchQueueState();
    if (!state || state.batchId !== message.batchId) throw new Error('طابور الدفعة غير موجود.');
    state.preparationFailures.push({
        index: safeInteger(message.index, 0),
        name: normalizeText(message.name),
        searchCode: normalizeText(message.searchCode),
        styleCode: normalizeText(message.styleCode),
        error: normalizeText(message.error) || 'تعذر تجهيز المنتج.',
        createdAt: Date.now(),
    });
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);
    if (state.notifyEachProduct) {
        await showBatchNotification('تعذر تجهيز منتج', `${normalizeText(message.name) || 'منتج'} — ${normalizeText(message.error)}`);
    }
    return { success: true, state };
}

async function finalizeBatchQueue(message) {
    const state = await readBatchQueueState();
    if (!state || state.batchId !== message.batchId) throw new Error('طابور الدفعة غير موجود.');
    state.finalized = true;
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);
    await processBatchQueue();
    return { success: true, state: await readBatchQueueState() };
}

async function pauseBatchQueue(message) {
    const state = await readBatchQueueState();
    if (!state || (message.batchId && state.batchId !== message.batchId)) throw new Error('طابور الدفعة غير موجود.');
    if (state.status === 'running') state.status = 'paused';
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);
    return { success: true, state };
}

async function resumeBatchQueue(message) {
    const state = await readBatchQueueState();
    if (!state || (message.batchId && state.batchId !== message.batchId)) throw new Error('طابور الدفعة غير موجود.');
    if (state.status === 'paused') state.status = 'running';
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);
    await processBatchQueue();
    return { success: true, state: await readBatchQueueState() };
}

async function cancelBatchQueue(message) {
    const state = await readBatchQueueState();
    if (!state || (message.batchId && state.batchId !== message.batchId)) throw new Error('طابور الدفعة غير موجود.');

    state.status = 'cancelled';
    state.pending = [];
    state.current = null;
    state.finalized = true;
    state.updatedAt = Date.now();

    const jobs = await readFallbackJobs();
    const tabsToClose = [];
    for (const [tabId, job] of Object.entries(jobs)) {
        if (job.batchId === state.batchId) {
            tabsToClose.push(Number(tabId));
            delete jobs[tabId];
        }
    }
    await writeFallbackJobs(jobs);
    await writeBatchQueueState(state);
    for (const tabId of tabsToClose) chrome.tabs.remove(tabId).catch(() => {});
    await showBatchNotification('تم إلغاء دفعة AlphaCode', 'تم إيقاف المنتجات المتبقية في الطابور.');
    return { success: true, state };
}

async function retryFailedBatchProducts(message) {
    const state = await readBatchQueueState();
    if (!state || (message.batchId && state.batchId !== message.batchId)) throw new Error('طابور الدفعة غير موجود.');
    const failedResults = state.results.filter(item => !item.success && item.product);
    if (!failedResults.length) throw new Error('لا توجد منتجات إرسال فاشلة قابلة لإعادة المحاولة.');

    state.pending = failedResults.map(item => ({
        product: item.product,
        searchCode: item.searchCode,
        styleCode: item.styleCode,
        addUrl: state.addUrl || DEFAULT_SOOQIFY_ADD_URL,
        attempts: 0,
        queuedAt: Date.now(),
    }));
    state.results = state.results.filter(item => item.success);
    state.status = 'running';
    state.finalized = true;
    state.current = null;
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);
    await processBatchQueue();
    return { success: true, state: await readBatchQueueState() };
}

async function maybeCompleteBatchQueue(state) {
    if (!state || !state.finalized || state.current || state.pending.length) return false;
    state.status = 'completed';
    state.completedAt = Date.now();
    state.updatedAt = Date.now();
    await writeBatchQueueState(state);

    const succeeded = state.results.filter(item => item.success).length;
    const failed = state.results.filter(item => !item.success).length + state.preparationFailures.length;
    const elapsedSeconds = Math.max(1, Math.round((state.completedAt - state.createdAt) / 1000));
    await showBatchNotification(
        'اكتملت دفعة AlphaCode',
        `نجح ${succeeded}، فشل ${failed}، المدة ${elapsedSeconds} ثانية.`,
        `alphacode_batch_done_${state.batchId}`,
    );
    return true;
}

async function processBatchQueue() {
    if (batchLaunchLock) return;
    batchLaunchLock = true;
    try {
        const state = await readBatchQueueState();
        if (!state || state.status !== 'running' || state.current) return;
        if (!state.pending.length) {
            await maybeCompleteBatchQueue(state);
            return;
        }

        const next = state.pending.shift();
        state.current = next;
        state.updatedAt = Date.now();
        await writeBatchQueueState(state);

        try {
            const product = {
                ...next.product,
                batch_id: state.batchId,
                settings: {
                    ...(next.product.settings || {}),
                    AutoSubmitDelaySeconds: 0,
                    FastAutofillMode: true,
                },
            };
            next.product = product;
            state.current = next;
            await writeBatchQueueState(state);

            await openFallbackSubmissionTab(
                {
                    product,
                    addUrl: next.addUrl || state.addUrl,
                    searchCode: next.searchCode,
                    styleCode: next.styleCode,
                    active: false,
                    mode: 'background_tab',
                    batchId: state.batchId,
                    sourceTabId: state.sourceTabId,
                },
                { tab: { id: state.sourceTabId, url: '' } },
            );
        } catch (error) {
            state.current = null;
            state.results.push({
                success: false,
                productId: Number(next.product?.local_id || 0),
                product: next.product,
                searchCode: next.searchCode,
                styleCode: next.styleCode,
                error: error.message,
                completedAt: Date.now(),
            });
            if (!state.continueOnFailure) state.status = 'paused';
            await writeBatchQueueState(state);
            if (state.status === 'running') setTimeout(() => processBatchQueue(), 250);
        }
    } finally {
        batchLaunchLock = false;
    }
}

async function recordBatchSubmissionResult(result, job) {
    const state = await readBatchQueueState();
    if (!state || state.batchId !== job.batchId) return false;

    const current = state.current || {};
    const attempt = safeInteger(current.attempts, 0);
    const retryable = !result.success && attempt < state.maxRetries
        && !/انتهت جلسة|تسجيل الدخول|login/i.test(result.error || '');

    if (retryable) {
        state.pending.unshift({ ...current, attempts: attempt + 1, queuedAt: Date.now() });
    } else {
        state.results.push({
            ...result,
            product: current.product,
            attempts: attempt + 1,
            completedAt: Date.now(),
        });
    }

    state.current = null;
    state.updatedAt = Date.now();

    if (!result.success && /انتهت جلسة|تسجيل الدخول|login/i.test(result.error || '')) {
        state.status = 'paused';
    } else if (!result.success && !state.continueOnFailure && !retryable) {
        state.status = 'paused';
    }

    await writeBatchQueueState(state);

    if (state.notifyEachProduct && !retryable) {
        const position = state.results.length + state.preparationFailures.length;
        await showBatchNotification(
            result.success ? 'تمت إضافة المنتج' : 'تعذر إضافة المنتج',
            `${current.product?.name_en || `ID ${result.productId}`} — ${position}/${state.totalPlanned}${result.success ? '' : ` — ${result.error}`}`,
        );
    }

    if (state.status === 'running') setTimeout(() => processBatchQueue(), 300);
    else await maybeCompleteBatchQueue(state);
    return true;
}

async function deliverSingleSubmissionResult(result, job) {
    if (Number.isInteger(job.sourceTabId)) {
        try {
            await chrome.tabs.sendMessage(job.sourceTabId, {
                action: 'ALPHACODE_SUBMISSION_RESULT',
                result,
            });
        } catch (_) {
            await chrome.storage.local.set({ alphacodeSubmissionResult: result });
        }
    }
}

// Arabic: إضافة المنتج في تبويب غير نشط حتى يستخدم المتجر جلسته وJavaScript الحقيقيين دون مغادرة صفحة المورد.
// English: Submit through an inactive store tab so the real session and JavaScript are used without leaving the supplier page.
async function submitProductInBackground(message, sender) {
    return openFallbackSubmissionTab(
        {
            ...message,
            active: false,
            mode: 'background_tab',
        },
        sender,
    );
}

// Arabic: فتح رابط في تبويب جديد من service worker لتجنب حظر النوافذ المنبثقة.
// English: Open a URL in a new tab from the service worker to avoid popup blocking.
async function openExtensionTab(message) {
    if (!message.url) {
        throw new Error('A URL is required.');
    }

    const tab = await chrome.tabs.create({
        url: message.url,
        active: true,
    });

    return {
        success: true,
        tabId: tab.id,
    };
}

// Arabic: قراءة خريطة مهام إعادة المحاولة من storage.session لضمان بقائها مع تعليق Service Worker.
// English: Read retry jobs from storage.session so they survive service-worker suspension.
async function readFallbackJobs() {
    const stored = await chrome.storage.session.get(
        FALLBACK_JOBS_KEY,
    );

    return stored[FALLBACK_JOBS_KEY] || {};
}

// Arabic: حفظ خريطة مهام إعادة المحاولة.
// English: Persist retry-job mappings.
async function writeFallbackJobs(jobs) {
    await chrome.storage.session.set({
        [FALLBACK_JOBS_KEY]: jobs,
    });
}

// Arabic: فتح تبويب آلي؛ يكون مخفياً للمحاولة الأساسية ومرئياً عند إعادة المحاولة.
// English: Open an automated tab; inactive for the primary attempt and visible for manual retry.
async function openFallbackSubmissionTab(message, sender) {
    const product = message.product;

    if (!product?.local_id) {
        throw new Error('بيانات المنتج غير متاحة للإضافة.');
    }

    const sourceTabId = Number.isInteger(message.sourceTabId)
        ? Number(message.sourceTabId)
        : sender.tab?.id;
    if (!Number.isInteger(sourceTabId)) {
        throw new Error('تعذر تحديد تبويب صفحة المورد.');
    }

    const mode = message.mode === 'background_tab'
        ? 'background_tab'
        : 'fallback_tab';

    const active = mode === 'fallback_tab';

    await chrome.storage.local.set({
        pendingSooqifyProduct: product,
        lastAlphaCodeProductId: product.local_id,
    });

    const addUrl = new URL(
        message.addUrl || DEFAULT_SOOQIFY_ADD_URL,
    );

    addUrl.searchParams.set('alphacode_retry', '1');
    addUrl.searchParams.set(
        'alphacode_product_id',
        String(product.local_id),
    );
    addUrl.searchParams.set(
        'alphacode_mode',
        mode,
    );

    // Arabic: إنشاء التبويب على صفحة فارغة أولاً حتى تُحفظ المهمة قبل تحميل Sooqify.
    // English: Create an about:blank tab first so the job is persisted before Sooqify starts loading.
    const automatedTab = await chrome.tabs.create({
        url: 'about:blank',
        active,
    });

    const jobs = await readFallbackJobs();
    jobs[String(automatedTab.id)] = {
        sourceTabId,
        productId: Number(product.local_id),
        searchCode: normalizeText(message.searchCode),
        styleCode: normalizeText(message.styleCode),
        mode,
        active,
        batchId: normalizeText(message.batchId),
        createdAt: Date.now(),
    };
    await writeFallbackJobs(jobs);

    try {
        await chrome.tabs.update(
            automatedTab.id,
            {
                url: addUrl.href,
                active,
            },
        );
    } catch (error) {
        const failedJobs = await readFallbackJobs();
        delete failedJobs[String(automatedTab.id)];
        await writeFallbackJobs(failedJobs);
        chrome.tabs.remove(automatedTab.id).catch(() => {});
        throw new Error(
            `تعذر فتح صفحة Sooqify: ${error.message}`,
        );
    }

    try {
        await forwardClientLog({
            payload: {
                level: 'INFO',
                event: 'automated_store_tab_opened',
                message: mode === 'background_tab'
                    ? 'Opened an inactive Sooqify tab for background submission.'
                    : 'Opened a visible Sooqify tab for fallback submission.',
                details: {
                    product_id: product.local_id,
                    tab_id: automatedTab.id,
                    mode,
                    active,
                },
                page: sender.tab?.url || '',
            },
        });
    } catch (_) {}

    return {
        success: true,
        pending: true,
        tabId: automatedTab.id,
        mode,
    };
}

// Arabic: استلام نتيجة التبويب المؤقت ثم تحديث الطابور أو إبلاغ صفحة المورد.
// English: Receive an automated-tab result and update the batch queue or source page.
async function completeFallbackSubmission(message, sender) {
    const retryTabId = sender.tab?.id;
    if (!Number.isInteger(retryTabId)) throw new Error('تعذر تحديد تبويب الإضافة الآلية.');

    const jobs = await readFallbackJobs();
    const job = jobs[String(retryTabId)] || {};
    delete jobs[String(retryTabId)];
    await writeFallbackJobs(jobs);

    const result = {
        success: Boolean(message.success),
        productId: Number(message.productId || job.productId || 0),
        searchCode: normalizeText(message.searchCode || job.searchCode),
        styleCode: normalizeText(message.styleCode || job.styleCode),
        error: normalizeText(message.error),
        mode: normalizeText(job.mode) || 'fallback_tab',
    };

    if (job.batchId) await recordBatchSubmissionResult(result, job);
    else await deliverSingleSubmissionResult(result, job);

    setTimeout(() => chrome.tabs.remove(retryTabId).catch(() => {}), 250);
    return { success: true, result };
}

async function handleAutomatedTabFailure(tabId, job, error) {
    const result = {
        success: false,
        productId: job.productId,
        searchCode: job.searchCode,
        styleCode: job.styleCode,
        error,
        mode: normalizeText(job.mode) || 'background_tab',
    };
    if (job.batchId) await recordBatchSubmissionResult(result, job);
    else await deliverSingleSubmissionResult(result, job);
    chrome.tabs.remove(tabId).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    const jobs = await readFallbackJobs();
    const job = jobs[String(tabId)];
    if (!job) return;
    const currentUrl = String(changeInfo.url || tab?.url || '');
    if (!/\/login(?:\?|$)|\/auth\/login(?:\?|$)/i.test(currentUrl)) return;
    delete jobs[String(tabId)];
    await writeFallbackJobs(jobs);
    await handleAutomatedTabFailure(tabId, job, 'انتهت جلسة Sooqify. سجّل الدخول إلى لوحة المتجر ثم استكمل الدفعة.');
});

chrome.tabs.onRemoved.addListener(async tabId => {
    const jobs = await readFallbackJobs();
    const job = jobs[String(tabId)];
    if (!job) return;
    delete jobs[String(tabId)];
    await writeFallbackJobs(jobs);
    const error = job.mode === 'background_tab'
        ? 'تم إغلاق تبويب الإضافة الخلفية قبل اكتمال العملية.'
        : 'تم إغلاق تبويب إعادة المحاولة قبل اكتمال الإضافة.';
    const result = {
        success: false,
        productId: job.productId,
        searchCode: job.searchCode,
        styleCode: job.styleCode,
        error,
        mode: normalizeText(job.mode) || 'fallback_tab',
    };
    if (job.batchId) await recordBatchSubmissionResult(result, job);
    else await deliverSingleSubmissionResult(result, job);
});

// Arabic: استعادة طابور مستمر بعد إعادة تشغيل المتصفح أو تعليق Service Worker.
// English: Recover a persisted queue after browser restart or service-worker suspension.
async function recoverPersistedBatchQueue() {
    const state = await readBatchQueueState();
    if (!state || state.status !== 'running') return;
    if (state.current) {
        const jobs = await readFallbackJobs();
        const hasLiveJob = Object.values(jobs).some(job => (
            job.batchId === state.batchId
            && Number(job.productId) === Number(state.current?.product?.local_id)
        ));
        if (!hasLiveJob) {
            state.pending.unshift(state.current);
            state.current = null;
            await writeBatchQueueState(state);
        }
    }
    await processBatchQueue();
}

// Arabic: منبه خفيف يعيد إيقاظ Service Worker إذا عُلّق بين منتجين.
// English: A lightweight alarm wakes the service worker if it is suspended between products.
chrome.alarms.create(BATCH_ALARM_NAME, { periodInMinutes: 1 });

chrome.runtime.onStartup.addListener(() => recoverPersistedBatchQueue().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => recoverPersistedBatchQueue().catch(() => {}));
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === BATCH_ALARM_NAME) recoverPersistedBatchQueue().catch(() => {});
});
recoverPersistedBatchQueue().catch(() => {});

// Arabic: توجيه رسائل الإضافة إلى الوظيفة المناسبة.
// English: Route extension messages to the proper background action.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.action) return false;

    (async () => {
        try {
            if (message.action === 'FETCH_LOCAL_FILE') {
                sendResponse(await fetchLocalFile(message));
                return;
            }

            if (message.action === 'LOG_CLIENT_EVENT') {
                sendResponse(await forwardClientLog(message));
                return;
            }

            if (message.action === 'OPEN_TAB') {
                sendResponse(await openExtensionTab(message));
                return;
            }

            if (message.action === 'SUBMIT_PRODUCT_BACKGROUND') {
                sendResponse(
                    await submitProductInBackground(message, sender),
                );
                return;
            }

            if (message.action === 'OPEN_FALLBACK_SUBMISSION_TAB') {
                sendResponse(
                    await openFallbackSubmissionTab(
                        message,
                        sender,
                    ),
                );
                return;
            }

            if (message.action === 'FALLBACK_SUBMISSION_COMPLETE') {
                sendResponse(
                    await completeFallbackSubmission(
                        message,
                        sender,
                    ),
                );
                return;
            }


            if (message.action === 'START_BATCH_QUEUE') {
                sendResponse(await startBatchQueue(message, sender));
                return;
            }

            if (message.action === 'ENQUEUE_BATCH_PRODUCT') {
                sendResponse(await enqueueBatchProduct(message));
                return;
            }

            if (message.action === 'REPORT_BATCH_PREPARATION_FAILURE') {
                sendResponse(await reportBatchPreparationFailure(message));
                return;
            }

            if (message.action === 'FINALIZE_BATCH_QUEUE') {
                sendResponse(await finalizeBatchQueue(message));
                return;
            }

            if (message.action === 'GET_BATCH_QUEUE_STATE') {
                sendResponse({ success: true, state: await readBatchQueueState() });
                return;
            }

            if (message.action === 'PAUSE_BATCH_QUEUE') {
                sendResponse(await pauseBatchQueue(message));
                return;
            }

            if (message.action === 'RESUME_BATCH_QUEUE') {
                sendResponse(await resumeBatchQueue(message));
                return;
            }

            if (message.action === 'CANCEL_BATCH_QUEUE') {
                sendResponse(await cancelBatchQueue(message));
                return;
            }

            if (message.action === 'RETRY_FAILED_BATCH') {
                sendResponse(await retryFailedBatchProducts(message));
                return;
            }

            sendResponse({
                success: false,
                error: `Unknown action: ${message.action}`,
            });
        } catch (error) {
            sendResponse({
                success: false,
                error: error.message,
            });
        }
    })();

    return true;
});
