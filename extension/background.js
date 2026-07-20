// =========================================================
// AlphaCode Extractor - Background Service Worker
// Arabic: يدير رفع الصور، الإضافة الخلفية إلى Sooqify، ومسار إعادة المحاولة في تبويب مؤقت.
// English: Manages image fetching, background Sooqify submission, and temporary-tab retry flow.
// =========================================================

'use strict';

const LOCAL_API_BASE = 'http://127.0.0.1:5000';
const DEFAULT_SOOQIFY_ADD_URL = 'https://admin.sooqifyonline.com/admin/item/add-new';
const FALLBACK_JOBS_KEY = 'alphacodeFallbackSubmissionJobs';

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

    const sourceTabId = sender.tab?.id;
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

// Arabic: استلام نتيجة التبويب المؤقت ثم إغلاقه وإبلاغ صفحة المورد.
// English: Receive the temporary-tab result, close it, and notify the supplier page.
async function completeFallbackSubmission(message, sender) {
    const retryTabId = sender.tab?.id;
    if (!Number.isInteger(retryTabId)) {
        throw new Error('تعذر تحديد تبويب إعادة المحاولة.');
    }

    const jobs = await readFallbackJobs();
    const job = jobs[String(retryTabId)] || {};
    delete jobs[String(retryTabId)];
    await writeFallbackJobs(jobs);

    const result = {
        success: Boolean(message.success),
        productId: Number(
            message.productId
            || job.productId
            || 0,
        ),
        searchCode: normalizeText(
            message.searchCode
            || job.searchCode,
        ),
        styleCode: normalizeText(
            message.styleCode
            || job.styleCode,
        ),
        error: normalizeText(message.error),
        mode: normalizeText(job.mode) || 'fallback_tab',
    };

    if (Number.isInteger(job.sourceTabId)) {
        try {
            await chrome.tabs.sendMessage(
                job.sourceTabId,
                {
                    action: 'ALPHACODE_SUBMISSION_RESULT',
                    result,
                },
            );
        } catch (_) {
            await chrome.storage.local.set({
                alphacodeSubmissionResult: result,
            });
        }
    }

    setTimeout(() => {
        chrome.tabs.remove(retryTabId).catch(() => {});
    }, 350);

    return {
        success: true,
        result,
    };
}

// Arabic: اكتشاف تحويل التبويب الآلي إلى تسجيل الدخول وإرجاع خطأ واضح بدلاً من الانتظار.
// English: Detect automated tabs redirected to login and return a clear error instead of hanging.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;

    const jobs = await readFallbackJobs();
    const job = jobs[String(tabId)];
    if (!job) return;

    const currentUrl = String(
        changeInfo.url || tab?.url || '',
    );

    if (!/\/login(?:\?|$)|\/auth\/login(?:\?|$)/i.test(currentUrl)) {
        return;
    }

    delete jobs[String(tabId)];
    await writeFallbackJobs(jobs);

    const result = {
        success: false,
        productId: job.productId,
        searchCode: job.searchCode,
        styleCode: job.styleCode,
        error: 'انتهت جلسة Sooqify. سجّل الدخول إلى لوحة المتجر ثم أعد المحاولة.',
        mode: normalizeText(job.mode) || 'background_tab',
    };

    if (Number.isInteger(job.sourceTabId)) {
        try {
            await chrome.tabs.sendMessage(
                job.sourceTabId,
                {
                    action: 'ALPHACODE_SUBMISSION_RESULT',
                    result,
                },
            );
        } catch (_) {
            await chrome.storage.local.set({
                alphacodeSubmissionResult: result,
            });
        }
    }

    chrome.tabs.remove(tabId).catch(() => {});
});

// Arabic: تنظيف المهمة إذا أغلق المستخدم تبويب إعادة المحاولة يدوياً.
// English: Clean up and notify the source if the user manually closes the retry tab.
chrome.tabs.onRemoved.addListener(async tabId => {
    const jobs = await readFallbackJobs();
    const job = jobs[String(tabId)];
    if (!job) return;

    delete jobs[String(tabId)];
    await writeFallbackJobs(jobs);

    if (!Number.isInteger(job.sourceTabId)) return;

    const result = {
        success: false,
        productId: job.productId,
        searchCode: job.searchCode,
        styleCode: job.styleCode,
        error: job.mode === 'background_tab'
            ? 'تم إغلاق تبويب الإضافة الخلفية قبل اكتمال العملية.'
            : 'تم إغلاق تبويب إعادة المحاولة قبل اكتمال الإضافة.',
        mode: normalizeText(job.mode) || 'fallback_tab',
    };

    try {
        await chrome.tabs.sendMessage(
            job.sourceTabId,
            {
                action: 'ALPHACODE_SUBMISSION_RESULT',
                result,
            },
        );
    } catch (_) {
        await chrome.storage.local.set({
            alphacodeSubmissionResult: result,
        });
    }
});

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
