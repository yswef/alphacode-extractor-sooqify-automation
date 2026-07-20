// =========================================================
// AlphaCode Extractor - Sooqify Admin Form Adapter
// Arabic: ملف مستقل لتعبئة متجر Sooqify ويمكن استبداله عند الانتقال إلى متجر آخر.
// English: Isolated Sooqify adapter that can be replaced for another store platform.
// =========================================================

'use strict';

const ADMIN_DEFAULTS = globalThis.ALPHACODE_DEFAULT_CONFIG || {};
const LOCAL_API_BASE = 'http://127.0.0.1:5000';
const FALLBACK_RETRY_QUERY_KEY = 'alphacode_retry';
const FALLBACK_RETRY_SESSION_KEY = 'alphacodeFallbackRetryContext';
let adminConfig = { ...ADMIN_DEFAULTS };
let adminPanelObserverTimer = null;
let automaticRunStarted = false;

// Arabic: الانتظار بين خطوات واجهة المتجر الديناميكية.
// English: Pause between dynamic store-interface steps.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}


// Arabic: قراءة سياق إعادة المحاولة من الرابط أو sessionStorage ليستمر بعد تحويل المتجر.
// English: Read retry context from the URL or sessionStorage so it survives store navigation.
function getFallbackRetryContext() {
    try {
        const params = new URLSearchParams(window.location.search);
        const isRetry = params.get(FALLBACK_RETRY_QUERY_KEY) === '1';
        const productId = Number(
            params.get('alphacode_product_id') || 0,
        );

        if (isRetry && productId) {
            const context = {
                isRetry: true,
                productId,
            };

            sessionStorage.setItem(
                FALLBACK_RETRY_SESSION_KEY,
                JSON.stringify(context),
            );

            return context;
        }
    } catch (_) {}

    try {
        const stored = JSON.parse(
            sessionStorage.getItem(
                FALLBACK_RETRY_SESSION_KEY,
            ) || 'null',
        );

        if (stored?.isRetry && Number(stored.productId)) {
            return {
                isRetry: true,
                productId: Number(stored.productId),
            };
        }
    } catch (_) {}

    return null;
}

// Arabic: إبلاغ Service Worker بنتيجة تبويب إعادة المحاولة ليغلقه ويحدث صفحة المورد.
// English: Report the retry-tab result so the service worker can close it and update the supplier page.
async function reportFallbackSubmissionResult({
    success,
    productId,
    searchCode = '',
    styleCode = '',
    error = '',
}) {
    const context = getFallbackRetryContext();
    if (!context?.isRetry) return false;

    const response = await safeRuntimeMessage({
        action: 'FALLBACK_SUBMISSION_COMPLETE',
        success: Boolean(success),
        productId: Number(productId || context.productId),
        searchCode,
        styleCode,
        error: String(error || ''),
    });

    return Boolean(response?.success);
}

// Arabic: التأكد من أن سياق الإضافة الحالي ما زال صالحاً بعد Reload.
// English: Check whether the current extension context is still valid after an extension reload.
function isExtensionContextAvailable() {
    try {
        return Boolean(globalThis.chrome?.runtime?.id);
    } catch (_) {
        return false;
    }
}

// Arabic: إرسال رسالة آمنة إلى service worker مع خطأ واضح عند انتهاء السياق.
// English: Safely message the service worker and provide a clear invalid-context error.
async function safeRuntimeMessage(message) {
    if (!isExtensionContextAvailable()) {
        throw new Error('Extension context was reloaded. Refresh this page once.');
    }
    return chrome.runtime.sendMessage(message);
}

// Arabic: قراءة تخزين Chrome بأمان.
// English: Safely read Chrome extension storage.
async function safeStorageGet(keys) {
    if (!isExtensionContextAvailable()) return {};
    try {
        return await chrome.storage.local.get(keys);
    } catch (_) {
        return {};
    }
}

// Arabic: كتابة تخزين Chrome بأمان دون تعطيل العمل عند إعادة تحميل الإضافة.
// English: Safely write Chrome storage without breaking the workflow after an extension reload.
async function safeStorageSet(values) {
    if (!isExtensionContextAvailable()) return false;
    try {
        await chrome.storage.local.set(values);
        return true;
    } catch (_) {
        return false;
    }
}

// Arabic: التحقق من ظهور العنصر للمستخدم.
// English: Determine whether an element is visibly rendered.
function isElementVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
}

// Arabic: إرسال أحداث الواجهة إلى سجل Python الخارجي مع fallback مباشر.
// English: Forward UI events to the external Python log with a direct-fetch fallback.
async function logClientEvent(level, event, message, details = {}) {
    const payload = {
        level,
        event,
        message,
        details,
        page: window.location.href,
    };

    try {
        const result = await safeRuntimeMessage({
            action: 'LOG_CLIENT_EVENT',
            payload,
        });

        if (result?.success) return;
    } catch (_) {}

    try {
        await fetch(`${LOCAL_API_BASE}/api/log/client`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        console.warn('AlphaCode log forwarding failed:', error);
    }
}

// Arabic: تحميل إعدادات الأداة المشتركة من تخزين Chrome.
// English: Load shared extractor settings from Chrome storage.
async function loadAdminConfiguration() {
    const stored = await safeStorageGet(['extractorConfig']);

    const storedConfig = stored.extractorConfig || {};

    adminConfig = {
        ...ADMIN_DEFAULTS,
        ...storedConfig,
    };

    // Arabic: دعم الاسم القديم SizeactualChoiceNo مع اعتماد SizeChoiceNo مستقبلاً.
    // English: Preserve the legacy SizeactualChoiceNo key while standardizing on SizeChoiceNo.
    adminConfig.SizeChoiceNo = Number(
        storedConfig.SizeChoiceNo
        ?? storedConfig.SizeactualChoiceNo
        ?? ADMIN_DEFAULTS.SizeChoiceNo
        ?? ADMIN_DEFAULTS.SizeactualChoiceNo
        ?? 1
    );

    adminConfig.SizeAttributeId = Number(
        storedConfig.SizeAttributeId
        ?? ADMIN_DEFAULTS.SizeAttributeId
        ?? 1
    );

    adminConfig.SizeTitle = String(
        storedConfig.SizeTitle
        ?? ADMIN_DEFAULTS.SizeTitle
        ?? 'الحجم'
    ).trim() || 'الحجم';

    if (adminConfig.StoreProfileName === 'BRANDKINGDOM') {
        adminConfig.StoreProfileName = 'Sooqify Online';
    }

    if (!adminConfig.SupplierStoreName) {
        adminConfig.SupplierStoreName = 'BRANDKINGDOM';
    }

    return adminConfig;
}

// Arabic: إرسال أحداث input/change حتى تتعرف أطر الواجهة على القيم الجديدة.
// English: Dispatch input/change events so the store framework detects programmatic values.
function dispatchControlEvents(element) {
    if (!element) return;

    element.dispatchEvent(new Event('input', {
        bubbles: true,
        composed: true,
    }));

    element.dispatchEvent(new Event('change', {
        bubbles: true,
        composed: true,
    }));

    if (window.jQuery) {
        try {
            window.jQuery(element).trigger('change');
        } catch (_) {}
    }
}

// Arabic: ضبط قيمة عنصر واحد مع دعم Select2 قدر الإمكان.
// English: Set one control value with best-effort Select2 support.
function setElementValue(element, value) {
    if (!element || value === undefined || value === null) return false;

    element.value = String(value);
    dispatchControlEvents(element);

    return true;
}

// Arabic: ضبط أول عنصر مطابق لمحدد CSS.
// English: Set the first control matching a CSS selector.
function setControlValue(selector, value) {
    return setElementValue(document.querySelector(selector), value);
}

// Arabic: انتظار شرط في الواجهة الديناميكية مع مهلة محددة.
// English: Wait for a condition in the dynamic admin interface with a timeout.
async function waitForCondition(check, timeoutMs = 10000, intervalMs = 100) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const result = check();

        if (result) return result;

        await sleep(intervalMs);
    }

    return null;
}

// Arabic: العثور على عنصر بالاسم مع دعم الأسماء التي تنتهي بأقواس المصفوفات.
// English: Find a control by its exact submitted name, including array-style names.
function getNamedControl(name) {
    return document.getElementsByName(name)[0] || null;
}

// Arabic: فتح Select2 لتحفيز تحميل الخيارات البعيدة عند الحاجة.
// English: Open Select2 to trigger remote option loading when needed.
function nudgeDynamicSelect(element) {
    if (!element) return;

    try {
        const container = element.nextElementSibling?.classList?.contains('select2')
            ? element.nextElementSibling
            : element.parentElement?.querySelector('.select2-selection');

        (
            container?.querySelector?.('.select2-selection')
            || container
        )?.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
            }),
        );
    } catch (_) {}

    try {
        element.focus();
        element.click();
    } catch (_) {}
}

// Arabic: تعيين قيمة select ديناميكي مع انتظار الخيار ودعم Select2.
// English: Set a dynamic select value, waiting for options and supporting Select2.
async function setDynamicSelectValue(name, value, label = '') {
    const wanted = String(value ?? '');

    if (!wanted) return false;

    const element = await waitForCondition(
        () => getNamedControl(name),
        5000,
        100,
    );

    if (!element) return false;

    if (element.tagName === 'SELECT') {
        nudgeDynamicSelect(element);

        let option = await waitForCondition(
            () => Array.from(element.options || []).find(item => (
                String(item.value) === wanted
            )),
            5000,
            100,
        );

        if (!option) {
            option = new Option(
                label || `ID ${wanted}`,
                wanted,
                true,
                true,
            );

            option.dataset.alphacodeGenerated = '1';
            element.add(option);
        }

        element.value = wanted;
        option.selected = true;

        if (window.jQuery) {
            try {
                window.jQuery(element)
                    .val(wanted)
                    .trigger('change.select2')
                    .trigger('change');
            } catch (_) {}
        }

        dispatchControlEvents(element);
        await sleep(60);

        return String(element.value) === wanted
            || Array.from(element.selectedOptions || []).some(item => (
                String(item.value) === wanted
            ));
    }

    return setElementValue(element, wanted);
}

// Arabic: تعبئة المقاسات في مكوّن المتجر مقاساً بعد مقاس.
// English: Populate the store size component one size at a time.
async function populateChoiceOptionsControl(element, sizes, form = null) {
    if (!element) return false;

    const values = Array.from(
        new Set(
            (sizes || [])
                .map(value => String(value).trim())
                .filter(Boolean),
        ),
    );

    if (!values.length) return false;

    const productForm = form || element.closest('form') || findProductForm();

    // Arabic: دعم Select وSelect2 متعدد القيم.
    // English: Support multiple-value Select and Select2 controls.
    if (element.tagName === 'SELECT') {
        Array.from(element.options || []).forEach(option => {
            option.selected = false;
        });

        values.forEach(value => {
            let option = Array.from(
                element.options || [],
            ).find(item => String(item.value) === value);

            if (!option) {
                option = new Option(value, value, true, true);
                element.add(option);
            }

            option.selected = true;
        });

        element.multiple = true;

        if (window.jQuery) {
            try {
                window.jQuery(element)
                    .val(values)
                    .trigger('change.select2')
                    .trigger('change');
            } catch (_) {}
        }

        dispatchControlEvents(element);
        await sleep(150);
        return true;
    }

    // Arabic: دعم Tagify.
    // English: Support Tagify.
    if (element._tagify?.removeAllTags && element._tagify?.addTags) {
        element._tagify.removeAllTags();
        element._tagify.addTags(values);
        await sleep(150);
        return true;
    }

    // Arabic: دعم Tom Select.
    // English: Support Tom Select.
    if (element.tomselect) {
        element.tomselect.clear(true);

        values.forEach(value => {
            element.tomselect.addOption({ value, text: value });
            element.tomselect.addItem(value, true);
        });

        await sleep(120);
        return true;
    }

    // Arabic: دعم Selectize.
    // English: Support Selectize.
    if (element.selectize) {
        element.selectize.clear(true);

        values.forEach(value => {
            element.selectize.addOption({ value, text: value });
            element.selectize.addItem(value, true);
        });

        await sleep(120);
        return true;
    }

    // Arabic: دعم Bootstrap Tags Input على الحقل الأصلي.
    // English: Support Bootstrap Tags Input on the original control.
    if (window.jQuery) {
        try {
            const jqElement = window.jQuery(element);

            if (typeof jqElement.tagsinput === 'function') {
                jqElement.tagsinput('removeAll');

                for (const value of values) {
                    jqElement.tagsinput('add', value);
                    await sleep(80);
                }

                await sleep(120);
                return true;
            }
        } catch (_) {}
    }

    // Arabic: تحديد حقل الكتابة المرئي الحقيقي الذي أنشأه مكوّن الوسوم.
    // English: Resolve the actual visible text input created by the tags widget.
    const resolveVisibleInput = () => {
        if (
            isElementVisible(element)
            && (
                element.matches('input:not([type="hidden"])')
                || element.getAttribute('contenteditable') === 'true'
            )
        ) {
            return element;
        }

        const localContainer = (
            element.closest('.form-group, .col-12, .row, [class*="choice"], [class*="attribute"]')
            || element.parentElement
            || productForm
        );

        const localCandidates = Array.from(
            localContainer?.querySelectorAll?.(
                '.bootstrap-tagsinput input, .tagify__input, input[placeholder*="أدخل قيم الاختيار"], input[placeholder*="Enter choice" i], input:not([type="hidden"]), [contenteditable="true"]',
            ) || [],
        ).filter(isElementVisible);

        const strictLocal = localCandidates.find(candidate => {
            const placeholder = String(candidate.getAttribute('placeholder') || '').toLowerCase();
            return (
                candidate.matches('.bootstrap-tagsinput input, .tagify__input')
                || placeholder.includes('أدخل قيم الاختيار')
                || placeholder.includes('enter choice')
            );
        });

        if (strictLocal) return strictLocal;

        return Array.from(
            productForm?.querySelectorAll?.(
                '.bootstrap-tagsinput input, .tagify__input, input[placeholder*="أدخل قيم الاختيار"], input[placeholder*="Enter choice" i]',
            ) || [],
        ).find(isElementVisible) || null;
    };

    const visibleInput = resolveVisibleInput();
    if (!visibleInput) return false;

    // Arabic: تنظيف الوسوم القديمة من الواجهة قبل إدخال المنتج الجديد.
    // English: Clear stale tags from the visible widget before entering new sizes.
    try {
        const tagContainer = visibleInput.closest('.bootstrap-tagsinput, .tagify');
        tagContainer?.querySelectorAll?.('.tag, .tagify__tag').forEach(tag => {
            tag.querySelector('[data-role="remove"], .tagify__tag__removeBtn')?.click();
        });
    } catch (_) {}

    const setNativeInputValue = value => {
        if (visibleInput.getAttribute('contenteditable') === 'true') {
            visibleInput.textContent = value;
            return;
        }

        const descriptor = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
        );

        if (descriptor?.set && visibleInput instanceof HTMLInputElement) {
            descriptor.set.call(visibleInput, value);
        } else {
            visibleInput.value = value;
        }
    };

    // Arabic: إدخال كل مقاس منفرداً مع أحداث Native وjQuery لضمان استجابة المتجر.
    // English: Enter each size separately with both native and jQuery events.
    for (const value of values) {
        visibleInput.focus();
        setNativeInputValue(value);

        visibleInput.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertText',
            data: value,
        }));

        visibleInput.dispatchEvent(new Event('change', {
            bubbles: true,
            composed: true,
        }));

        if (window.jQuery) {
            try {
                const jqInput = window.jQuery(visibleInput);
                jqInput.trigger(window.jQuery.Event('keydown', { key: 'Enter', which: 13, keyCode: 13 }));
                jqInput.trigger(window.jQuery.Event('keypress', { key: 'Enter', which: 13, keyCode: 13 }));
                jqInput.trigger(window.jQuery.Event('keyup', { key: 'Enter', which: 13, keyCode: 13 }));
            } catch (_) {}
        }

        for (const eventName of ['keydown', 'keypress', 'keyup']) {
            visibleInput.dispatchEvent(new KeyboardEvent(eventName, {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
            }));
        }

        await sleep(180);
        setNativeInputValue('');
    }

    visibleInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(350);
    return true;
}

// Arabic: العثور على نموذج المنتج الحقيقي بواسطة name[].
// English: Locate the real product form through its name[] controls.
function findProductForm() {
    const nameInput = document.querySelector(
        'input[name="name[]"], textarea[name="name[]"]',
    );

    return nameInput ? nameInput.closest('form') : null;
}

// Arabic: تعبئة الأسماء والأوصاف حسب ترتيب lang[] الفعلي.
// English: Populate names and descriptions according to the page's actual lang[] order.
function fillTranslations(form, product) {
    const languages = Array.from(
        form.querySelectorAll('[name="lang[]"]'),
    );

    const names = Array.from(
        form.querySelectorAll('[name="name[]"]'),
    );

    const descriptions = Array.from(
        form.querySelectorAll('[name="description[]"]'),
    );

    const defaultLanguage = String(
        product.settings?.DefaultLanguage
        || adminConfig.DefaultLanguage
        || 'en',
    ).toLowerCase();

    languages.forEach((languageElement, index) => {
        const language = String(
            languageElement.value || '',
        ).toLowerCase();

        const useArabic = language === 'ar'
            || (
                language === 'default'
                && defaultLanguage === 'ar'
            );

        const nameValue = useArabic
            ? (product.name_ar || product.name_en || '')
            : (product.name_en || product.name_ar || '');

        const descriptionValue = useArabic
            ? (
                product.description_ar
                || product.description_en
                || ''
            )
            : (
                product.description_en
                || product.description_ar
                || ''
            );

        if (names[index]) {
            setElementValue(names[index], nameValue);
        }

        if (descriptions[index]) {
            setElementValue(
                descriptions[index],
                descriptionValue,
            );
        }
    });
}

// Arabic: تحويل Base64 إلى File صالح لحقل الصور.
// English: Convert Base64 data into a File suitable for file inputs.
function base64ToFile(base64, mimeType, fileName) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], fileName, {
        type: mimeType || 'image/jpeg',
        lastModified: Date.now(),
    });
}

// Arabic: جلب صورة localhost عبر service worker لتجاوز mixed content.
// English: Fetch a localhost image through the service worker to avoid mixed-content restrictions.
async function fetchLocalImageFile(imageInfo) {
    const response = await safeRuntimeMessage({
        action: 'FETCH_LOCAL_FILE',
        url: imageInfo.url,
        fileName: imageInfo.name,
    });

    if (!response?.success) {
        throw new Error(
            response?.error
            || `Could not fetch ${imageInfo.name}`,
        );
    }

    return base64ToFile(
        response.base64,
        response.mimeType,
        imageInfo.name,
    );
}

// Arabic: إسناد ملفات إلى input[type=file] بواسطة DataTransfer.
// English: Assign files to an input[type=file] using DataTransfer.
function assignFilesToInput(input, files) {
    if (!input || !files.length) return false;

    if (files.length > 1) {
        input.multiple = true;
    }

    const transfer = new DataTransfer();

    files.forEach(file => {
        transfer.items.add(file);
    });

    input.files = transfer.files;
    dispatchControlEvents(input);

    return input.files.length === files.length;
}

// Arabic: إرجاع حقول صور المعرض الحقيقية التي أنشأها المتجر فقط.
// English: Return only the real gallery-image inputs created by the store.
function getGalleryImageInputs(form) {
    return Array.from(
        form.querySelectorAll(
            'input[type="file"][name="item_images[]"]',
        ),
    ).filter(input => (
        input.isConnected
        && !input.disabled
    ));
}

// Arabic: التحقق من أن حقل صور المعرض ما زال فارغاً وقابلاً للاستخدام.
// English: Check whether a gallery file input is still empty and usable.
function isEmptyGalleryImageInput(input) {
    return Boolean(
        input
        && input.isConnected
        && !input.disabled
        && input.type === 'file'
        && input.name === 'item_images[]'
        && (
            !input.files
            || input.files.length === 0
        )
    );
}

// Arabic: مراقبة النموذج قبل إضافة الصورة وانتظار حقل جديد ينشئه JavaScript الخاص بالمتجر.
// English: Observe the form before assigning an image and wait for a new input created by the store JavaScript.
function createNewGalleryInputWaiter(
    form,
    knownInputs,
    timeoutMs = 30000,
) {
    let observer = null;
    let timeoutId = null;
    let settled = false;
    let resolvePromise = null;

    const finish = input => {
        if (settled) return;

        settled = true;

        if (observer) {
            observer.disconnect();
        }

        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        resolvePromise(input || null);
    };

    const findCreatedInput = () => (
        getGalleryImageInputs(form).find(input => (
            !knownInputs.has(input)
            && isEmptyGalleryImageInput(input)
        ))
        || null
    );

    const promise = new Promise(resolve => {
        resolvePromise = resolve;

        observer = new MutationObserver(() => {
            const createdInput = findCreatedInput();

            if (createdInput) {
                finish(createdInput);
            }
        });

        observer.observe(form, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                'name',
                'type',
                'disabled',
            ],
        });

        // Arabic: فحص فوري لتغطية الحالة التي ينشئ فيها المتجر الحقل بسرعة كبيرة.
        // English: Check immediately in case the store creates the field extremely quickly.
        const immediateInput = findCreatedInput();

        if (immediateInput) {
            finish(immediateInput);
            return;
        }

        timeoutId = setTimeout(
            () => finish(null),
            timeoutMs,
        );
    });

    return {
        promise,
        cancel: () => finish(null),
    };
}

// Arabic: انتظار تأكيد احتفاظ الحقل بالصورة بعد أحداث JavaScript الخاصة بالمتجر.
// English: Wait until the input still contains the image after the store JavaScript events run.
async function waitForAssignedGalleryFile(
    form,
    input,
    file,
    timeoutMs = 8000,
) {
    const hasAssignedFile = () => {
        const directMatch = Array.from(
            input?.files || [],
        ).some(item => (
            item.name === file.name
            && item.size === file.size
        ));

        if (directMatch) return true;

        return new FormData(form)
            .getAll('item_images[]')
            .some(value => (
                value instanceof File
                && value.size > 0
                && value.name === file.name
            ));
    };

    const detected = await waitForCondition(
        () => hasAssignedFile() || null,
        timeoutMs,
        150,
    );

    if (!detected) return null;

    // Arabic: مهلة قصيرة للتأكد من أن المتجر لم يستبدل الحقل ويفقد الملف بعد حدث change.
    // English: Briefly settle to ensure the store did not replace the input and lose the file after change.
    await sleep(300);

    return hasAssignedFile() || null;
}

// Arabic: استخراج أسماء الملفات الفعلية التي سيدخلها FormData إلى الطلب.
// English: Read the actual file names that FormData will submit.
function getFormDataFileNames(form, fieldName) {
    const values = new FormData(form).getAll(fieldName);

    return values
        .filter(value => (
            value instanceof File
            && value.size > 0
        ))
        .map(value => value.name);
}

// Arabic: تعبئة الصورة الرئيسية ثم صور المعرض واحدة تلو الأخرى عبر حقول المتجر الحقيقية.
// English: Populate the main image, then gallery images one by one through the store's real inputs.
async function fillImageInputs(form, product, setStatus) {
    // Arabic: لا يتم إنشاء أي file input مخفي؛ المتجر وحده مسؤول عن إنشاء حقول الصور.
    // English: No hidden file inputs are created; only the store may create image fields.
    form.querySelectorAll(
        'input[type="file"][data-alphacode-generated="1"]',
    ).forEach(input => input.remove());

    const configuredLimit = Number(
        adminConfig.StoreImageLimit || 8,
    );

    const storeImageLimit = Math.max(
        1,
        Math.min(
            Number.isFinite(configuredLimit)
                ? configuredLimit
                : 8,
            20,
        ),
    );

    const imageInfoList = Array.isArray(product.image_files)
        ? product.image_files.slice(0, storeImageLimit)
        : [];

    const imageFiles = [];

    for (
        let index = 0;
        index < imageInfoList.length;
        index += 1
    ) {
        setStatus(
            `جلب الصورة ${index + 1} من ${imageInfoList.length}...`,
            'working',
        );

        try {
            imageFiles.push(
                await fetchLocalImageFile(
                    imageInfoList[index],
                ),
            );
        } catch (error) {
            await logClientEvent(
                'ERROR',
                'admin_image_fetch_failed',
                error.message,
                {
                    image_index: index + 1,
                    image_name: imageInfoList[index]?.name,
                },
            );

            if (adminConfig.RequireAllImages) {
                throw error;
            }
        }
    }

    if (!imageFiles.length) {
        throw new Error(
            'لا توجد صور صالحة لهذا المنتج.',
        );
    }

    const mainInput = await waitForCondition(
        () => form.querySelector(
            'input[type="file"][name="image"]',
        ),
        10000,
        200,
    );

    if (!mainInput) {
        throw new Error(
            'لم يتم العثور على حقل الصورة الرئيسية image.',
        );
    }

    setStatus(
        `إضافة الصورة الرئيسية: ${imageFiles[0].name}`,
        'working',
    );

    if (!assignFilesToInput(mainInput, [imageFiles[0]])) {
        throw new Error(
            'تعذر تعبئة الصورة الرئيسية.',
        );
    }

    const mainAccepted = await waitForCondition(() => {
        const directMatch = Array.from(
            mainInput.files || [],
        ).some(file => (
            file.name === imageFiles[0].name
            && file.size === imageFiles[0].size
        ));

        const payloadMatch = new FormData(form)
            .getAll('image')
            .some(value => (
                value instanceof File
                && value.size > 0
                && value.name === imageFiles[0].name
            ));

        return directMatch || payloadMatch || null;
    }, 8000, 150);

    if (!mainAccepted) {
        throw new Error(
            'المتجر لم يحتفظ بالصورة الرئيسية بعد تعبئتها.',
        );
    }

    const galleryFiles = imageFiles.slice(1);
    const assignedGalleryNames = [];

    const galleryFieldWaitTimeoutMs = Math.max(
        5000,
        Number(
            adminConfig.GalleryInputWaitTimeoutMs
            || 30000,
        ),
    );

    if (galleryFiles.length) {
        let currentGalleryInput = await waitForCondition(
            () => getGalleryImageInputs(form).find(
                isEmptyGalleryImageInput,
            ),
            galleryFieldWaitTimeoutMs,
            200,
        );

        if (!currentGalleryInput) {
            throw new Error(
                'لم يتم العثور على أول حقل صور للمعرض item_images[].',
            );
        }

        for (
            let index = 0;
            index < galleryFiles.length;
            index += 1
        ) {
            const file = galleryFiles[index];
            const imageNumber = index + 2;

            const needsAnotherInput = (
                index < galleryFiles.length - 1
            );

            if (!isEmptyGalleryImageInput(
                currentGalleryInput,
            )) {
                throw new Error(
                    `حقل صورة المعرض رقم ${index + 1} غير جاهز أو لم يعد فارغاً.`,
                );
            }

            setStatus(
                `إضافة الصورة ${imageNumber} من ${imageFiles.length}، ثم انتظار المتجر لإنشاء الحقل التالي...`,
                'working',
            );

            // Arabic: نبدأ المراقبة قبل إطلاق change حتى لا نفوّت الحقل إذا أُنشئ فوراً.
            // English: Start observing before dispatching change so an immediately created input is not missed.
            const knownInputs = new Set(
                getGalleryImageInputs(form),
            );

            const nextInputWaiter = needsAnotherInput
                ? createNewGalleryInputWaiter(
                    form,
                    knownInputs,
                    galleryFieldWaitTimeoutMs,
                )
                : null;

            if (!assignFilesToInput(
                currentGalleryInput,
                [file],
            )) {
                nextInputWaiter?.cancel();

                throw new Error(
                    `تعذر تعبئة صورة المعرض رقم ${index + 1}: ${file.name}`,
                );
            }

            const fileAccepted = (
                await waitForAssignedGalleryFile(
                    form,
                    currentGalleryInput,
                    file,
                    8000,
                )
            );

            if (!fileAccepted) {
                nextInputWaiter?.cancel();

                throw new Error(
                    `المتجر لم يحتفظ بصورة المعرض: ${file.name}`,
                );
            }

            assignedGalleryNames.push(file.name);

            await logClientEvent(
                'INFO',
                'admin_gallery_image_assigned',
                'Assigned one gallery image through a native store input.',
                {
                    product_id: product.local_id,
                    gallery_index: index + 1,
                    image_name: file.name,
                    native_input_count_before_change:
                        knownInputs.size,
                },
            );

            if (!needsAnotherInput) {
                continue;
            }

            setStatus(
                `تمت إضافة الصورة ${imageNumber} من ${imageFiles.length}. انتظار إنشاء حقل الصورة التالية من المتجر...`,
                'working',
            );

            const newGalleryInput = (
                await nextInputWaiter.promise
            );

            if (!newGalleryInput) {
                throw new Error(
                    `انتهت مهلة الانتظار: المتجر لم ينشئ حقل item_images[] جديداً بعد الصورة ${imageNumber}.`,
                );
            }

            await sleep(250);

            currentGalleryInput = (
                isEmptyGalleryImageInput(newGalleryInput)
                    ? newGalleryInput
                    : await waitForCondition(
                        () => getGalleryImageInputs(form)
                            .find(input => (
                                !knownInputs.has(input)
                                && isEmptyGalleryImageInput(
                                    input,
                                )
                            )),
                        5000,
                        150,
                    )
            );

            if (!currentGalleryInput) {
                throw new Error(
                    `أنشأ المتجر حقل الصورة التالية ثم استبدله قبل أن يصبح جاهزاً للصورة ${imageNumber + 1}.`,
                );
            }
        }
    }

    // Arabic: السماح لآخر معاينة صورة بالاستقرار قبل فحص FormData النهائي.
    // English: Allow the final image preview to settle before validating the final FormData.
    await sleep(200);

    const mainNames = getFormDataFileNames(
        form,
        'image',
    );

    const galleryNames = getFormDataFileNames(
        form,
        'item_images[]',
    );

    const expectedGalleryNames = galleryFiles.map(
        file => file.name,
    );

    const missingAfterFill = expectedGalleryNames.filter(
        name => !galleryNames.includes(name),
    );

    await logClientEvent(
        missingAfterFill.length ? 'ERROR' : 'INFO',
        'admin_images_payload_ready',
        `Prepared main=${mainNames.length}, gallery=${galleryNames.length}/${expectedGalleryNames.length}.`,
        {
            product_id: product.local_id,
            upload_mode:
                'native_sequential_dynamic_inputs',
            main_files: mainNames,
            gallery_files: galleryNames,
            sequentially_assigned_gallery_files:
                assignedGalleryNames,
            expected_gallery_files:
                expectedGalleryNames,
            missing_gallery_files:
                missingAfterFill,
            native_gallery_input_count:
                getGalleryImageInputs(form).length,
        },
    );

    if (!mainNames.length) {
        throw new Error(
            'الصورة الرئيسية غير موجودة في FormData.',
        );
    }

    if (missingAfterFill.length) {
        throw new Error(
            `هناك ${missingAfterFill.length} صور معرض غير موجودة في الطلب بعد التعبئة التسلسلية: ${missingAfterFill.join(', ')}`,
        );
    }

    return {
        total: imageFiles.length,
        main: mainNames.length,
        galleryExpected: expectedGalleryNames.length,
        galleryAssigned: galleryNames.length,
        galleryNames,
        missingGalleryNames: missingAfterFill,
        mode: 'native_sequential_dynamic_inputs',
    };
}

// Arabic: إنشاء input مخفي قابل للحذف قبل تعبئة منتج جديد.
// English: Append a marked hidden input that can be removed before the next autofill.
function appendHiddenInput(form, name, value) {
    const input = document.createElement('input');

    input.type = 'hidden';
    input.name = name;
    input.value = String(value ?? '');
    input.dataset.alphacodeGenerated = '1';

    form.appendChild(input);

    return input;
}

// Arabic: اختيار خاصية واحدة فقط وحذف product_id أو أي اختيار سابق.
// English: Select exactly one attribute and clear product_id or any stale selection.
async function selectOnlyProductAttribute(attributeId, expectedTitle = 'الحجم') {
    const select = await waitForCondition(
        () => getNamedControl('attribute_id[]'),
        10000,
        250,
    );

    if (!select || select.tagName !== 'SELECT') {
        return {
            success: false,
            title: expectedTitle,
        };
    }

    const wantedId = String(attributeId);
    nudgeDynamicSelect(select);

    const option = await waitForCondition(
        () => Array.from(select.options || []).find(
            item => String(item.value) === wantedId,
        ),
        12000,
        250,
    );

    if (!option) {
        throw new Error(
            `لم يتم العثور على خاصية الحجم رقم ${wantedId} في قائمة المتجر.`,
        );
    }

    const actualTitle = String(
        option.textContent || expectedTitle || 'الحجم',
    ).trim() || 'الحجم';

    // Arabic: حذف أي اختيار سابق ثم اختيار خاصية الحجم وحدها.
    // English: Clear stale selections and keep only the size attribute.
    Array.from(select.options || []).forEach(item => {
        item.selected = false;
    });

    if (window.jQuery) {
        try {
            const jqSelect = window.jQuery(select);
            jqSelect.val(null).trigger('change.select2').trigger('change');
            await sleep(250);
            jqSelect
                .val(select.multiple ? [wantedId] : wantedId)
                .trigger('change.select2')
                .trigger('change');
        } catch (_) {
            option.selected = true;
            dispatchControlEvents(select);
        }
    } else {
        option.selected = true;
        dispatchControlEvents(select);
    }

    const selectedCorrectly = await waitForCondition(
        () => {
            const selectedIds = Array.from(
                select.selectedOptions || [],
            ).map(item => String(item.value));

            return (
                selectedIds.length === 1
                && selectedIds[0] === wantedId
            ) ? true : null;
        },
        8000,
        200,
    );

    await sleep(900);

    return {
        success: Boolean(selectedCorrectly),
        title: actualTitle,
        element: select,
    };
}

// Arabic: البحث الدقيق عن حقل إدخال المقاسات دون مطابقة حقول أخرى في الصفحة.
// English: Precisely locate the size-options control without matching unrelated fields.
async function findSizeChoiceControl(form, preferredChoiceNo = '1') {
    return waitForCondition(
        () => {
            const exact = getNamedControl(
                `choice_options_${preferredChoiceNo}[]`,
            );

            if (exact) return exact;

            const named = Array.from(
                form.querySelectorAll(
                    '[name^="choice_options_"][name$="[]"]',
                ),
            );

            if (named.length) {
                return named.find(isElementVisible) || named[0];
            }

            const strictVisible = Array.from(
                form.querySelectorAll(
                    '.bootstrap-tagsinput input, .tagify__input, input[placeholder*="أدخل قيم الاختيار"], input[placeholder*="Enter choice" i]',
                ),
            ).find(isElementVisible);

            return strictVisible || null;
        },
        18000,
        250,
    );
}

// Arabic: استخراج رقم Choice الحقيقي من الحقل أو الرجوع للرقم المفضل.
// English: Read the real choice number from the generated control or use the preferred one.
function resolveActualChoiceNo(choiceControl, preferredChoiceNo = '1') {
    const directName = String(
        choiceControl?.getAttribute?.('name') || '',
    );

    const directMatch = directName.match(
        /^choice_options_(\d+)\[\]$/,
    );

    if (directMatch) return directMatch[1];

    const relatedNamed = choiceControl?.closest?.(
        '.form-group, .row, [class*="choice"], [class*="attribute"]',
    )?.querySelector?.(
        '[name^="choice_options_"][name$="[]"]',
    );

    const relatedMatch = String(
        relatedNamed?.getAttribute?.('name') || '',
    ).match(/^choice_options_(\d+)\[\]$/);

    return relatedMatch?.[1] || String(preferredChoiceNo || '1');
}

// Arabic: اختيار خاصية الحجم وإضافة المقاسات في واجهة المتجر الحقيقية فقط.
// English: Select the size attribute and populate only the real store UI.
async function fillSizeVariants(form, product) {
    const sizes = Array.from(
        new Set(
            (product.sizes || [])
                .map(value => String(value).trim())
                .filter(Boolean),
        ),
    );

    const settings = product.settings || {};

    const stockPerSize = Number(
        settings.Stock
        || adminConfig.Stock
        || 100,
    );

    if (!sizes.length) {
        setControlValue('[name="current_stock"]', stockPerSize);
        return {
            sizes: 0,
            filledRows: 0,
            stockPerSize,
            totalStock: stockPerSize,
        };
    }

    const totalStock = stockPerSize * sizes.length;

    const attributeId = String(
        settings.SizeAttributeId
        || adminConfig.SizeAttributeId
        || 1,
    );

    // Arabic: قبول الاسم الجديد والقديم للإعداد دون كسر الإصدارات السابقة.
    // English: Accept both the standardized and legacy setting keys.
    const preferredChoiceNo = String(
        settings.SizeChoiceNo
        || settings.SizeactualChoiceNo
        || adminConfig.SizeChoiceNo
        || adminConfig.SizeactualChoiceNo
        || 1,
    );

    const configuredTitle = String(
        settings.SizeTitle
        || adminConfig.SizeTitle
        || 'الحجم',
    ).trim() || 'الحجم';

    const attributeResult = await selectOnlyProductAttribute(
        attributeId,
        configuredTitle,
    );

    if (!attributeResult.success) {
        throw new Error(
            `تعذر اختيار خاصية الحجم رقم ${attributeId}.`,
        );
    }

    const choiceControl = await findSizeChoiceControl(
        form,
        preferredChoiceNo,
    );

    if (!choiceControl) {
        throw new Error(
            `تم اختيار خاصية ${attributeResult.title}، لكن المتجر لم يُنشئ حقل «أدخل قيم الاختيار».`,
        );
    }

    const actualChoiceNo = resolveActualChoiceNo(
        choiceControl,
        preferredChoiceNo,
    );

    const optionsAdded = await populateChoiceOptionsControl(
        choiceControl,
        sizes,
        form,
    );

    if (!optionsAdded) {
        throw new Error(
            'تم العثور على حقل المقاسات، لكن تعذر إدخال القيم فيه.',
        );
    }

    // Arabic: انتظار صف أول مقاس للتأكد أن JavaScript الخاص بالمتجر أنشأ الجدول.
    // English: Wait for the first variant row to confirm the store generated the table.
    const firstRowCreated = await waitForCondition(
        () => {
            const firstSize = sizes[0];
            const priceControl = document.getElementsByName(
                `price_${firstSize}`,
            )[0];
            const stockControl = document.getElementsByName(
                `stock_${firstSize}`,
            )[0];

            return priceControl && stockControl
                ? { priceControl, stockControl }
                : null;
        },
        18000,
        250,
    );

    if (!firstRowCreated) {
        throw new Error(
            'تم إدخال المقاسات، لكن المتجر لم ينشئ جدول السعر والمخزون.',
        );
    }

    let filledRows = 0;
    const missingRows = [];

    for (const size of sizes) {
        const controls = await waitForCondition(
            () => {
                const price = document.getElementsByName(
                    `price_${size}`,
                )[0];
                const stock = document.getElementsByName(
                    `stock_${size}`,
                )[0];

                return price && stock
                    ? { price, stock }
                    : null;
            },
            10000,
            200,
        );

        if (!controls) {
            missingRows.push(size);
            continue;
        }

        setElementValue(controls.price, product.price);
        setElementValue(controls.stock, stockPerSize);
        filledRows += 1;
    }

    setControlValue('[name="current_stock"]', totalStock);

    await logClientEvent(
        missingRows.length ? 'WARNING' : 'INFO',
        'admin_variants_ready',
        `Filled ${filledRows}/${sizes.length} size rows.`,
        {
            product_id: product.local_id,
            attribute_id: attributeId,
            attribute_title: attributeResult.title,
            preferred_choice_no: preferredChoiceNo,
            actual_choice_no: actualChoiceNo,
            sizes,
            filled_rows: filledRows,
            missing_rows: missingRows,
            stock_per_size: stockPerSize,
            total_stock: totalStock,
        },
    );

    if (missingRows.length) {
        throw new Error(
            `لم ينشئ المتجر صفوف المقاسات التالية: ${missingRows.join(', ')}`,
        );
    }

    return {
        sizes: sizes.length,
        filledRows,
        stockPerSize,
        totalStock,
        attributeSelected: true,
        actualChoiceNo,
    };
}

// Arabic: كتابة ID المنتج المحلي داخل حقل العلامات الظاهر فقط.
// English: Write the local product ID into the visible tags field only.
async function fillProductIdTag(form, productId) {
    const tagValue = String(productId ?? '').trim();

    if (!tagValue) return false;

    const originalControl = (
        form.querySelector('[name="tags"]')
        || form.querySelector('[name="tags[]"]')
    );

    if (!originalControl) return false;

    // Arabic: دعم Tagify إذا كان المتجر يستخدمه.
    // English: Support Tagify when the store uses it.
    if (
        originalControl._tagify?.removeAllTags
        && originalControl._tagify?.addTags
    ) {
        originalControl._tagify.removeAllTags();
        originalControl._tagify.addTags([tagValue]);
        await sleep(60);
        return true;
    }

    // Arabic: دعم Tom Select.
    // English: Support Tom Select.
    if (originalControl.tomselect) {
        originalControl.tomselect.clear(true);
        originalControl.tomselect.addOption({
            value: tagValue,
            text: tagValue,
        });
        originalControl.tomselect.addItem(tagValue, true);
        await sleep(60);
        return true;
    }

    // Arabic: دعم Selectize.
    // English: Support Selectize.
    if (originalControl.selectize) {
        originalControl.selectize.clear(true);
        originalControl.selectize.addOption({
            value: tagValue,
            text: tagValue,
        });
        originalControl.selectize.addItem(tagValue, true);
        await sleep(60);
        return true;
    }

    // Arabic: دعم Bootstrap Tags Input.
    // English: Support Bootstrap Tags Input.
    if (window.jQuery) {
        try {
            const jqControl = window.jQuery(originalControl);

            if (typeof jqControl.tagsinput === 'function') {
                jqControl.tagsinput('removeAll');
                jqControl.tagsinput('add', tagValue);
                await sleep(60);
                return true;
            }
        } catch (_) {}
    }

    // Arabic: دعم select متعدد القيم.
    // English: Support a multiple-value select.
    if (originalControl.tagName === 'SELECT') {
        Array.from(originalControl.options || []).forEach(option => {
            option.selected = false;
        });

        let option = Array.from(
            originalControl.options || [],
        ).find(item => String(item.value) === tagValue);

        if (!option) {
            option = new Option(
                tagValue,
                tagValue,
                true,
                true,
            );
            originalControl.add(option);
        }

        option.selected = true;

        if (window.jQuery) {
            try {
                window.jQuery(originalControl)
                    .val(
                        originalControl.multiple
                            ? [tagValue]
                            : tagValue,
                    )
                    .trigger('change.select2')
                    .trigger('change');
            } catch (_) {}
        }

        dispatchControlEvents(originalControl);
        await sleep(60);
        return true;
    }

    // Arabic: تعبئة الحقل الأصلي ثم حقل الكتابة المرئي إن وُجد.
    // English: Fill the original control and its visible widget input when present.
    setElementValue(originalControl, tagValue);

    const visibleInput = Array.from(
        (
            originalControl.closest(
                '.form-group, .row, [class*="tag"]',
            )
            || originalControl.parentElement
            || form
        ).querySelectorAll(
            '.bootstrap-tagsinput input, .tagify__input, input[placeholder*="علامات"], input[placeholder*="tags" i]',
        ),
    ).find(isElementVisible);

    if (visibleInput && visibleInput !== originalControl) {
        visibleInput.focus();
        setElementValue(visibleInput, tagValue);

        for (const eventName of ['keydown', 'keypress', 'keyup']) {
            visibleInput.dispatchEvent(
                new KeyboardEvent(eventName, {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        }

        await sleep(60);
    }

    return true;
}

// Arabic: تعبئة حقول Sooqify الديناميكية بسرعة مع احترام اعتماد الفئة الفرعية على الفئة.
// English: Fill Sooqify fields quickly while respecting the category-to-subcategory dependency.
async function fillCoreFields(product) {
    const settings = product.settings || {};

    const storeId = (
        settings.StoreId
        || adminConfig.StoreId
    );

    const categoryId = (
        settings.CategoryId
        || adminConfig.CategoryId
    );

    const subCategoryId = (
        settings.SubCategoryId
        || adminConfig.SubCategoryId
    );

    const brandId = (
        product.brand_id
        || adminConfig.BrandId
    );

    const unitId = (
        settings.UnitId
        || adminConfig.UnitId
    );

    const results = {};

    // Arabic: المتجر ثم الفئة لأن الفئة تعتمد على المتجر.
    // English: Store first, then category because category data depends on the store.
    results.store = await setDynamicSelectValue(
        'store_id',
        storeId,
        `Store ${storeId}`,
    );

    await sleep(80);

    results.category = await setDynamicSelectValue(
        'category_id',
        categoryId,
        `${categoryId}`,
    );

    // Arabic: الانتظار الذكي للفئة الفرعية دون تأخير ثابت طويل.
    // English: Smart-wait for the subcategory without a long fixed delay.
    await waitForCondition(
        () => {
            const control = getNamedControl(
                'sub_category_id',
            );

            if (
                !control
                || control.disabled
            ) {
                return null;
            }

            if (
                control.tagName === 'SELECT'
                && control.options.length < 2
            ) {
                return null;
            }

            return control;
        },
        3500,
        75,
    );

    results.subCategory = await setDynamicSelectValue(
        'sub_category_id',
        subCategoryId,
        `${subCategoryId}`,
    );

    // Arabic: تعبئة الحقول المستقلة بالتوازي لتقليل زمن الانتظار بين الحقول.
    // English: Fill independent fields in parallel to reduce delays between controls.
    const [
        brandResult,
        unitResult,
        discountTypeResult,
        tagResult,
    ] = await Promise.all([
        setDynamicSelectValue(
            'brand_id',
            brandId,
            product.brand_name || `Brand ${brandId}`,
        ),
        setDynamicSelectValue(
            'unit',
            unitId,
            `Unit ${unitId}`,
        ),
        setDynamicSelectValue(
            'discount_type',
            settings.DiscountType || 'percent',
            settings.DiscountType || 'percent',
        ),
        fillProductIdTag(
            findProductForm(),
            product.local_id,
        ),
    ]);

    results.brand = brandResult;
    results.unit = unitResult;
    results.discountType = discountTypeResult;
    results.productIdTag = tagResult;

    // Arabic: الحقول النصية والرقمية لا تحتاج انتظاراً متسلسلاً.
    // English: Plain text and numeric fields do not require sequential waits.
    setControlValue(
        '[name="maximum_cart_quantity"]',
        settings.MaximumCartQuantity || '',
    );

    setControlValue(
        '[name="price"]',
        product.price,
    );

    setControlValue(
        '[name="discount"]',
        settings.Discount ?? 0,
    );

    await logClientEvent(
        'INFO',
        'admin_core_fields_ready',
        'Core dynamic fields were prepared using fast parallel autofill.',
        {
            product_id: product.local_id,
            wanted: {
                storeId,
                categoryId,
                subCategoryId,
                brandId,
                unitId,
                tagId: product.local_id,
            },
            results,
            actual: {
                store_id:
                    getNamedControl('store_id')?.value
                    || '',
                category_id:
                    getNamedControl('category_id')?.value
                    || '',
                sub_category_id:
                    getNamedControl(
                        'sub_category_id',
                    )?.value
                    || '',
                brand_id:
                    getNamedControl('brand_id')?.value
                    || '',
                unit:
                    getNamedControl('unit')?.value
                    || '',
                tags:
                    getNamedControl('tags')?.value
                    || getNamedControl('tags[]')?.value
                    || '',
            },
        },
    );

    return results;
}

// Arabic: جلب آخر منتج مجهز من التخزين أو من Flask كحل بديل.
// English: Load the latest prepared product from storage or fall back to Flask.
async function getLatestPreparedProduct() {
    const stored = await safeStorageGet([
        'pendingSooqifyProduct',
    ]);

    if (stored.pendingSooqifyProduct) {
        return stored.pendingSooqifyProduct;
    }

    const response = await fetch(
        `${LOCAL_API_BASE}/api/pending/latest`,
        {
            cache: 'no-store',
        },
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(
            data.error || 'لا يوجد منتج مجهز.',
        );
    }

    await safeStorageSet({
        pendingSooqifyProduct:
            data.pending_product,
    });

    return data.pending_product;
}

// Arabic: تحديث حالة المنتج في الأرشيف المحلي.
// English: Update the product workflow status in the local archive.
async function updateWorkflowStatus(
    productId,
    status,
    details = {},
) {
    try {
        await fetch(
            `${LOCAL_API_BASE}/api/archive/product/${productId}/status`,
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
    } catch (error) {
        await logClientEvent(
            'WARNING',
            'workflow_status_update_failed',
            error.message,
            {
                product_id: productId,
                status,
            },
        );
    }
}

// Arabic: العثور على زر الإضافة الأصلي داخل نموذج المتجر.
// English: Locate the store's native product-submit button.
function findStoreSubmitButton(form) {
    const candidates = Array.from(
        form.querySelectorAll(
            'button, input[type="submit"], input[type="button"]',
        ),
    ).filter(element => (
        isElementVisible(element)
        && !element.disabled
        && !element.closest('#alphacode-admin-panel')
    ));

    const preferred = candidates.find(element => {
        const text = String(
            element.textContent
            || element.value
            || '',
        ).trim().toLowerCase();

        return (
            /إضافة|حفظ|انشاء|إنشاء|add|save|submit|create/
                .test(text)
        );
    });

    return preferred || form.querySelector(
        'button[type="submit"], input[type="submit"]',
    );
}

// Arabic: تسجيل ملخص FormData قبل الإرسال لتشخيص أي حقل ناقص.
// English: Log a FormData summary before submission to diagnose missing fields.
async function logFormPayloadSummary(form, product) {
    const formData = new FormData(form);
    const summary = {};

    for (const [key, value] of formData.entries()) {
        const displayed = value instanceof File
            ? {
                file_name: value.name,
                file_type: value.type,
                file_size: value.size,
            }
            : String(value);

        if (
            Object.prototype.hasOwnProperty.call(
                summary,
                key,
            )
        ) {
            if (!Array.isArray(summary[key])) {
                summary[key] = [summary[key]];
            }

            summary[key].push(displayed);
        } else {
            summary[key] = displayed;
        }
    }

    await logClientEvent(
        'INFO',
        'admin_form_payload_summary',
        'Prepared native Sooqify form payload.',
        {
            product_id: product.local_id,
            payload: summary,
        },
    );
}

// Arabic: الضغط على زر المتجر الأصلي بعد التحقق وتسجيل حالة الإرسال.
// English: Click the native store button after validation and status logging.
async function submitStoreProduct(
    form,
    product,
    setStatus,
) {
    const delaySeconds = Math.max(
        0,
        Number(
            adminConfig.AutoSubmitDelaySeconds || 0,
        ),
    );

    for (
        let remaining = delaySeconds;
        remaining > 0;
        remaining -= 1
    ) {
        setStatus(
            `سيتم إضافة المنتج تلقائياً خلال ${remaining} ثانية...`,
            'working',
        );

        await sleep(1000);
    }

    const submitButton = findStoreSubmitButton(form);

    if (!submitButton) {
        throw new Error(
            'لم يتم العثور على زر إضافة المنتج الأصلي.',
        );
    }

    // Arabic: إيقاف المحاولة مبكراً إذا كان المتجر ما زال يعتبر حقلاً مطلوباً غير صالح.
    // English: Stop early when the native store form still contains an invalid required control.
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        const invalidControl = form.querySelector(':invalid');
        const invalidName = String(
            invalidControl?.getAttribute?.('name')
            || invalidControl?.id
            || 'غير محدد',
        );

        throw new Error(
            `يوجد حقل مطلوب غير مكتمل في نموذج المتجر: ${invalidName}.`,
        );
    }

    await logFormPayloadSummary(form, product);

    await updateWorkflowStatus(
        product.local_id,
        'submit_started',
        {
            button_text: String(
                submitButton.textContent
                || submitButton.value
                || '',
            ).trim(),
        },
    );

    sessionStorage.setItem(
        'alphacodeSubmitProductId',
        String(product.local_id),
    );

    await safeStorageSet({
        lastAutoSubmitProductId:
            product.local_id,
        lastAutoSubmitAttemptAt:
            new Date().toISOString(),
    });

    setStatus(
        'يتم إرسال المنتج إلى المتجر الآن...',
        'working',
    );

    await logClientEvent(
        'INFO',
        'admin_auto_submit',
        'Clicking the native store submit button.',
        {
            product_id: product.local_id,
            button_text: String(
                submitButton.textContent
                || submitButton.value
                || '',
            ).trim(),
        },
    );

    submitButton.click();

    // Arabic: إذا منع التحقق المحلي الإرسال ولم يحدث انتقال، أبلغ صفحة المورد وأغلق تبويب المحاولة.
    // English: If local validation blocks navigation, report failure and close the retry tab.
    if (getFallbackRetryContext()?.isRetry) {
        setTimeout(async () => {
            if (
                !findProductForm()
                || !sessionStorage.getItem(
                    'alphacodeSubmitProductId',
                )
            ) {
                return;
            }

            const errorMessage = (
                'لم ينتقل Sooqify بعد الضغط على زر الإضافة. راجع الحقول المطلوبة أو رسالة التحقق في النموذج.'
            );

            try {
                await updateWorkflowStatus(
                    product.local_id,
                    'submit_failed',
                    {
                        mode: 'fallback_tab',
                        error: errorMessage,
                    },
                );

                await reportFallbackSubmissionResult({
                    success: false,
                    productId: product.local_id,
                    searchCode: product.search_code || '',
                    styleCode: product.style_code || '',
                    error: errorMessage,
                });
            } catch (_) {}
        }, 30000);
    }
}

// Arabic: تنفيذ تعبئة المنتج كاملة مع خيار الإرسال التلقائي.
// English: Populate the complete product form with optional automatic submission.
async function autofillLatestProduct(
    setStatus,
    options = {},
) {
    await loadAdminConfiguration();

    const product = await getLatestPreparedProduct();
    const form = findProductForm();

    if (!form) {
        throw new Error(
            'لم يتم العثور على نموذج إضافة المنتج. افتح صفحة إضافة منتج جديد.',
        );
    }

    await logClientEvent(
        'INFO',
        'admin_autofill_started',
        'Started Sooqify product autofill.',
        {
            product_id: product.local_id,
            requested_images:
                product.image_files?.length || 0,
            automatic_submit:
                Boolean(options.submitAfterFill),
            supplier_store_name:
                product.supplier_store_name,
        },
    );

    setStatus(
        'تعبئة الأسماء والأوصاف...',
        'working',
    );

    fillTranslations(form, product);

    setStatus(
        'تعبئة الفئات والبراند والوحدة...',
        'working',
    );

    const coreResult = await fillCoreFields(
        product,
    );

    setStatus(
        'تعبئة المخزون وخصائص المقاسات...',
        'working',
    );

    const variantResult = await fillSizeVariants(
        form,
        product,
    );

    const imageResult = await fillImageInputs(
        form,
        product,
        setStatus,
    );

    form.dataset.alphacodeProductId = String(
        product.local_id || '',
    );

    await safeStorageSet({
        pendingSooqifyProduct: product,
        lastAutoFilledProductId:
            product.local_id,
        lastAutoFillAt:
            new Date().toISOString(),
    });

    setStatus(
        `تم تجهيز المنتج ${product.local_id}: ${imageResult.total} صور، ${variantResult.sizes} مقاس، مخزون إجمالي ${variantResult.totalStock}.`,
        'success',
    );

    await logClientEvent(
        'INFO',
        'admin_autofill_completed',
        'Completed Sooqify product autofill.',
        {
            product_id: product.local_id,
            images: imageResult,
            core_fields: coreResult,
            variants: variantResult,
            sizes:
                product.sizes?.length || 0,
        },
    );

    form.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });

    if (options.submitAfterFill) {
        await submitStoreProduct(
            form,
            product,
            setStatus,
        );
    }

    return product;
}

// Arabic: تطبيق موضع اللوحة المحدد أو الإحداثيات المسحوبة.
// English: Apply configured panel placement or previously dragged coordinates.
async function applyPanelPosition(panel) {
    const stored = await safeStorageGet([
        'adminPanelCoordinates',
    ]);

    const coordinates = (
        stored.adminPanelCoordinates
    );

    panel.removeAttribute('style');

    panel.dataset.position = (
        adminConfig.AdminPanelPosition
        || 'middle-left'
    );

    if (
        coordinates
        && Number.isFinite(coordinates.left)
        && Number.isFinite(coordinates.top)
    ) {
        panel.dataset.position = 'custom';
        panel.style.left = `${
            Math.max(0, coordinates.left)
        }px`;
        panel.style.top = `${
            Math.max(0, coordinates.top)
        }px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
    }
}

// Arabic: جعل اللوحة قابلة للسحب مع حفظ موقعها.
// English: Make the panel draggable and persist its coordinates.
function enablePanelDragging(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener(
        'mousedown',
        event => {
            if (event.target.closest('button')) {
                return;
            }

            dragging = true;

            const rect = panel.getBoundingClientRect();

            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            panel.dataset.position = 'custom';

            Object.assign(panel.style, {
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                right: 'auto',
                bottom: 'auto',
                transform: 'none',
            });

            document.body.classList.add(
                'alphacode-dragging',
            );
        },
    );

    document.addEventListener(
        'mousemove',
        event => {
            if (!dragging) return;

            const left = Math.max(
                0,
                Math.min(
                    window.innerWidth
                        - panel.offsetWidth,
                    startLeft
                        + event.clientX
                        - startX,
                ),
            );

            const top = Math.max(
                0,
                Math.min(
                    window.innerHeight
                        - panel.offsetHeight,
                    startTop
                        + event.clientY
                        - startY,
                ),
            );

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        },
    );

    document.addEventListener(
        'mouseup',
        async () => {
            if (!dragging) return;

            dragging = false;

            document.body.classList.remove(
                'alphacode-dragging',
            );

            const rect = panel.getBoundingClientRect();

            if (isExtensionContextAvailable()) {
                try {
                    await chrome.storage.local.set({
                        adminPanelCoordinates: {
                            left: rect.left,
                            top: rect.top,
                        },
                    });
                } catch (_) {}
            }
        },
    );
}

// Arabic: إنشاء اللوحة العائمة بأسماء واضحة للمتجر المستهدف والمورد.
// English: Inject the floating panel with distinct target-store and supplier names.
async function injectAdminPanel() {
    if (
        document.getElementById(
            'alphacode-admin-panel',
        )
        || !findProductForm()
    ) {
        return;
    }

    await loadAdminConfiguration();

    const panel = document.createElement('div');

    panel.id = 'alphacode-admin-panel';

    panel.innerHTML = `
        <div class="alphacode-admin-header" id="alphacode-panel-handle">
            <div>
                <strong>AlphaCode → ${adminConfig.StoreProfileName || 'Sooqify Online'}</strong>
                <span>المورد: ${adminConfig.SupplierStoreName || 'غير محدد'}</span>
            </div>
            <button id="alphacode-collapse-panel" type="button" title="تصغير اللوحة">−</button>
        </div>
        <div class="alphacode-admin-body">
            <button id="alphacode-fill-product" type="button">تعبئة آخر منتج</button>
            <button id="alphacode-fill-submit" class="accent" type="button">تعبئة وإضافة الآن</button>
            <button id="alphacode-open-supplier" class="secondary" type="button">عرض بيانات المنتج المجهز</button>
            <button id="alphacode-reset-position" class="ghost" type="button">إعادة موضع اللوحة</button>
            <div id="alphacode-admin-status">جاهز — اسحب العنوان لتحريك اللوحة</div>
        </div>`;

    document.body.appendChild(panel);

    await applyPanelPosition(panel);

    enablePanelDragging(
        panel,
        panel.querySelector(
            '#alphacode-panel-handle',
        ),
    );

    const body = panel.querySelector(
        '.alphacode-admin-body',
    );

    const status = panel.querySelector(
        '#alphacode-admin-status',
    );

    const setStatus = (message, type = '') => {
        status.textContent = message;
        status.className = type;
    };

    panel.querySelector(
        '#alphacode-collapse-panel',
    ).onclick = event => {
        body.classList.toggle('collapsed');

        event.currentTarget.textContent = (
            body.classList.contains('collapsed')
                ? '+'
                : '−'
        );
    };

    panel.querySelector(
        '#alphacode-fill-product',
    ).onclick = async event => {
        event.currentTarget.disabled = true;

        try {
            await autofillLatestProduct(
                setStatus,
                {
                    submitAfterFill: false,
                },
            );
        } catch (error) {
            setStatus(
                error.message,
                'error',
            );

            await logClientEvent(
                'ERROR',
                'admin_manual_autofill_failed',
                error.message,
                {
                    stack: error.stack || '',
                },
            );
        } finally {
            event.currentTarget.disabled = false;
        }
    };

    panel.querySelector(
        '#alphacode-fill-submit',
    ).onclick = async event => {
        event.currentTarget.disabled = true;

        try {
            await autofillLatestProduct(
                setStatus,
                {
                    submitAfterFill: true,
                },
            );
        } catch (error) {
            setStatus(
                error.message,
                'error',
            );

            await logClientEvent(
                'ERROR',
                'admin_manual_submit_failed',
                error.message,
                {
                    stack: error.stack || '',
                },
            );

            event.currentTarget.disabled = false;
        }
    };

    panel.querySelector(
        '#alphacode-open-supplier',
    ).onclick = async () => {
        try {
            const product = (
                await getLatestPreparedProduct()
            );

            setStatus(
                `ID ${product.local_id} | ${product.brand_name || '-'} | ${product.style_code || '-'} | ${product.image_files?.length || 0} صور | المورد: ${product.supplier_store_name || '-'}`,
                'success',
            );
        } catch (error) {
            setStatus(
                error.message,
                'error',
            );
        }
    };

    panel.querySelector(
        '#alphacode-reset-position',
    ).onclick = async () => {
        if (isExtensionContextAvailable()) {
            try {
                await chrome.storage.local.remove(
                    'adminPanelCoordinates',
                );
            } catch (_) {}
        }

        await applyPanelPosition(panel);

        setStatus(
            'تمت إعادة موضع اللوحة حسب الإعدادات.',
            'success',
        );
    };
}

// Arabic: تشغيل الإضافة التلقائية فقط داخل تبويب إعادة المحاولة المؤقت.
// English: Run automatic submission only inside the temporary retry tab.
async function runAutomaticAddIfEnabled() {
    if (automaticRunStarted || !findProductForm()) {
        return;
    }

    const fallbackContext = getFallbackRetryContext();
    if (!fallbackContext?.isRetry) {
        return;
    }

    await loadAdminConfiguration();

    const product = await getLatestPreparedProduct();
    if (
        Number(product.local_id)
        !== Number(fallbackContext.productId)
    ) {
        const mismatchError = new Error(
            `المنتج المجهز رقم ${product.local_id} لا يطابق منتج إعادة المحاولة رقم ${fallbackContext.productId}.`,
        );

        await reportFallbackSubmissionResult({
            success: false,
            productId: fallbackContext.productId,
            error: mismatchError.message,
        });

        throw mismatchError;
    }

    automaticRunStarted = true;

    const status = document.querySelector(
        '#alphacode-admin-status',
    );

    const setStatus = (message, type = '') => {
        if (!status) return;
        status.textContent = message;
        status.className = type;
    };

    setStatus(
        'إعادة المحاولة: تعبئة المنتج وإضافته، وسيُغلق هذا التبويب تلقائياً بعد النتيجة...',
        'working',
    );

    try {
        await autofillLatestProduct(
            setStatus,
            {
                submitAfterFill: true,
            },
        );
    } catch (error) {
        setStatus(error.message, 'error');

        await updateWorkflowStatus(
            product.local_id,
            'submit_failed',
            {
                mode: 'fallback_tab',
                error: error.message,
            },
        );

        await logClientEvent(
            'ERROR',
            'admin_fallback_retry_failed',
            error.message,
            {
                product_id: product.local_id,
                stack: error.stack || '',
            },
        );

        await reportFallbackSubmissionResult({
            success: false,
            productId: product.local_id,
            searchCode: product.search_code || '',
            styleCode: product.style_code || '',
            error: error.message,
        });
    }
}

// Arabic: تأكيد نجاح التحويل بعد إرسال المنتج ثم إغلاق تبويب إعادة المحاولة عبر Service Worker.
// English: Confirm post-submit navigation, then let the service worker close the retry tab.
async function confirmSubmissionAfterNavigation() {
    const productId = Number(
        sessionStorage.getItem(
            'alphacodeSubmitProductId',
        ),
    );

    if (!productId || findProductForm()) {
        return;
    }

    const fallbackContext = getFallbackRetryContext();

    await updateWorkflowStatus(
        productId,
        'submitted',
        {
            mode: fallbackContext?.isRetry
                ? 'fallback_tab'
                : 'admin_visible',
            redirected_to: window.location.href,
        },
    );

    sessionStorage.removeItem(
        'alphacodeSubmitProductId',
    );

    const stored = await safeStorageGet([
        'pendingSooqifyProduct',
    ]);

    const product = stored.pendingSooqifyProduct || {
        local_id: productId,
    };

    if (
        stored.pendingSooqifyProduct?.local_id
            === productId
        && isExtensionContextAvailable()
    ) {
        try {
            await chrome.storage.local.remove(
                'pendingSooqifyProduct',
            );
        } catch (_) {}
    }

    await logClientEvent(
        'INFO',
        'admin_submission_confirmed',
        'Store navigation confirmed after product submission.',
        {
            product_id: productId,
            page: window.location.href,
            fallback_retry: Boolean(
                fallbackContext?.isRetry,
            ),
        },
    );

    if (fallbackContext?.isRetry) {
        await reportFallbackSubmissionResult({
            success: true,
            productId,
            searchCode: product.search_code || '',
            styleCode: product.style_code || '',
        });

        sessionStorage.removeItem(
            FALLBACK_RETRY_SESSION_KEY,
        );
    }
}

// Arabic: تسجيل أخطاء JavaScript غير المعالجة في السجل الخارجي.
// English: Record unhandled JavaScript errors in the external log.
function installGlobalErrorLogging() {
    window.addEventListener('error', event => {
        logClientEvent(
            'ERROR',
            'admin_window_error',
            event.message || 'Unknown window error',
            {
                filename: event.filename,
                line: event.lineno,
                column: event.colno,
                stack: event.error?.stack || '',
            },
        );
    });

    window.addEventListener(
        'unhandledrejection',
        event => {
            const reason = (
                event.reason instanceof Error
                    ? event.reason
                    : new Error(
                        String(
                            event.reason
                            || 'Unhandled rejection',
                        ),
                    )
            );

            logClientEvent(
                'ERROR',
                'admin_unhandled_rejection',
                reason.message,
                {
                    stack: reason.stack || '',
                },
            );
        },
    );
}

// Arabic: مراقبة تنقل SPA وإعادة تشغيل اللوحة عند الحاجة.
// English: Observe SPA navigation and restore the panel when required.
async function initializeAdminAutofill() {
    installGlobalErrorLogging();

    await loadAdminConfiguration();
    await confirmSubmissionAfterNavigation();
    await injectAdminPanel();
    await runAutomaticAddIfEnabled();

    const observer = new MutationObserver(() => {
        if (adminPanelObserverTimer) {
            return;
        }

        adminPanelObserverTimer = setTimeout(
            async () => {
                try {
                    await confirmSubmissionAfterNavigation();
                    await injectAdminPanel();
                    await runAutomaticAddIfEnabled();
                } finally {
                    adminPanelObserverTimer = null;
                }
            },
            600,
        );
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
    });

    await logClientEvent(
        'INFO',
        'admin_adapter_ready',
        'Sooqify admin adapter initialized.',
        {
            version: '3.4.2-fast-fields-product-id-tag',
            target_store:
                adminConfig.StoreProfileName,
            supplier_store:
                adminConfig.SupplierStoreName,
        },
    );
}

initializeAdminAutofill().catch(async error => {
    console.error(
        'AlphaCode admin initialization failed:',
        error,
    );

    await logClientEvent(
        'ERROR',
        'admin_initialization_failed',
        error.message,
        {
            stack: error.stack || '',
        },
    );
});