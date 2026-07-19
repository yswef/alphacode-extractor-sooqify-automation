// =========================================================
// AlphaCode Extractor - Sooqify Admin Form Adapter
// Arabic: ملف مستقل لتعبئة متجر Sooqify ويمكن استبداله عند الانتقال إلى متجر آخر.
// English: Isolated Sooqify adapter that can be replaced for another store platform.
// =========================================================

'use strict';

const ADMIN_DEFAULTS = globalThis.ALPHACODE_DEFAULT_CONFIG || {};
const LOCAL_API_BASE = 'http://127.0.0.1:5000';
let adminConfig = { ...ADMIN_DEFAULTS };
let adminPanelObserverTimer = null;
let automaticRunStarted = false;

// Arabic: الانتظار بين خطوات واجهة المتجر الديناميكية.
// English: Pause between dynamic store-interface steps.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
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
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

// Arabic: إرسال أحداث الواجهة إلى سجل Python الخارجي مع fallback مباشر.
// English: Forward UI events to the external Python log with a direct-fetch fallback.
async function logClientEvent(level, event, message, details = {}) {
    const payload = { level, event, message, details, page: window.location.href };
    try {
        const result = await safeRuntimeMessage({ action: 'LOG_CLIENT_EVENT', payload });
        if (result?.success) return;
    } catch (_) {}

    try {
        await fetch(`${LOCAL_API_BASE}/api/log/client`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
    adminConfig = { ...ADMIN_DEFAULTS, ...(stored.extractorConfig || {}) };
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
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    if (window.jQuery) {
        try { window.jQuery(element).trigger('change'); } catch (_) {}
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

// Arabic: العثور على نموذج المنتج الحقيقي بواسطة name[].
// English: Locate the real product form through its name[] controls.
function findProductForm() {
    const nameInput = document.querySelector('input[name="name[]"], textarea[name="name[]"]');
    return nameInput ? nameInput.closest('form') : null;
}

// Arabic: تعبئة الأسماء والأوصاف حسب ترتيب lang[] الفعلي.
// English: Populate names and descriptions according to the page's actual lang[] order.
function fillTranslations(form, product) {
    const languages = Array.from(form.querySelectorAll('[name="lang[]"]'));
    const names = Array.from(form.querySelectorAll('[name="name[]"]'));
    const descriptions = Array.from(form.querySelectorAll('[name="description[]"]'));
    const defaultLanguage = String(product.settings?.DefaultLanguage || adminConfig.DefaultLanguage || 'en').toLowerCase();

    languages.forEach((languageElement, index) => {
        const language = String(languageElement.value || '').toLowerCase();
        const useArabic = language === 'ar' || (language === 'default' && defaultLanguage === 'ar');
        const nameValue = useArabic
            ? (product.name_ar || product.name_en || '')
            : (product.name_en || product.name_ar || '');
        const descriptionValue = useArabic
            ? (product.description_ar || product.description_en || '')
            : (product.description_en || product.description_ar || '');

        if (names[index]) setElementValue(names[index], nameValue);
        if (descriptions[index]) setElementValue(descriptions[index], descriptionValue);
    });
}

// Arabic: تحويل Base64 إلى File صالح لحقل الصور.
// English: Convert Base64 data into a File suitable for file inputs.
function base64ToFile(base64, mimeType, fileName) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
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
    if (!response?.success) throw new Error(response?.error || `Could not fetch ${imageInfo.name}`);
    return base64ToFile(response.base64, response.mimeType, imageInfo.name);
}

// Arabic: إسناد ملفات إلى input[type=file] بواسطة DataTransfer.
// English: Assign files to an input[type=file] using DataTransfer.
function assignFilesToInput(input, files) {
    if (!input || !files.length) return false;
    if (files.length > 1) input.multiple = true;
    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    input.files = transfer.files;
    dispatchControlEvents(input);
    return input.files.length === files.length;
}

// Arabic: إنشاء حقل صور مخفي يشارك في FormData الحقيقي.
// English: Create a hidden file input that participates in the form's real FormData payload.
function createGeneratedFileInput(form, name, files) {
    const input = document.createElement('input');
    input.type = 'file';
    input.name = name;
    input.multiple = files.length > 1;
    input.accept = 'image/jpeg,image/png';
    input.dataset.alphacodeGenerated = '1';
    input.className = 'alphacode-generated-file-input';
    form.appendChild(input);
    if (!assignFilesToInput(input, files)) {
        input.remove();
        throw new Error(`Could not attach ${files.length} files to ${name}.`);
    }
    return input;
}

// Arabic: استخراج أسماء الملفات الفعلية التي سيدخلها FormData إلى الطلب.
// English: Read the actual file names that FormData will submit.
function getFormDataFileNames(form, fieldName) {
    const values = new FormData(form).getAll(fieldName);
    return values
        .filter(value => value instanceof File && value.size > 0)
        .map(value => value.name);
}

// Arabic: تعبئة الصورة الرئيسية وكل صور المعرض مع تحقق نهائي من FormData.
// English: Populate main/gallery images and validate the resulting FormData payload.
async function fillImageInputs(form, product, setStatus) {
    form.querySelectorAll('input[type="file"][data-alphacode-generated="1"]').forEach(input => input.remove());

    const imageInfoList = Array.isArray(product.image_files) ? product.image_files : [];
    const imageFiles = [];
    for (let index = 0; index < imageInfoList.length; index += 1) {
        setStatus(`جلب الصورة ${index + 1} من ${imageInfoList.length}...`, 'working');
        try {
            imageFiles.push(await fetchLocalImageFile(imageInfoList[index]));
        } catch (error) {
            await logClientEvent('ERROR', 'admin_image_fetch_failed', error.message, {
                image_index: index + 1,
                image_name: imageInfoList[index]?.name,
            });
            if (adminConfig.RequireAllImages) throw error;
        }
    }
    if (!imageFiles.length) throw new Error('لا توجد صور صالحة لهذا المنتج.');

    const mainInput = form.querySelector('input[type="file"][name="image"]');
    if (!mainInput) throw new Error('لم يتم العثور على حقل الصورة الرئيسية image.');
    if (!assignFilesToInput(mainInput, [imageFiles[0]])) {
        throw new Error('تعذر تعبئة الصورة الرئيسية.');
    }
    await sleep(500);

    const galleryFiles = imageFiles.slice(1);
    if (galleryFiles.length) {
        setStatus(`تعبئة ${galleryFiles.length} صور في معرض المنتج...`, 'working');

        // Arabic: المحاولة الأولى ترسل الصور دفعة واحدة إلى حقل المعرض الأصلي.
        // English: First try bulk assignment through the store's original gallery input.
        const originalGalleryInput = form.querySelector('input[type="file"][name="item_images[]"]');
        if (originalGalleryInput) {
            try {
                assignFilesToInput(originalGalleryInput, galleryFiles);
                await sleep(1200);
            } catch (_) {}
        }

        // Arabic: إضافة الملفات الناقصة في input مخفي لضمان دخولها في FormData.
        // English: Add any missing files through a hidden input to guarantee inclusion in FormData.
        const payloadNames = new Set(getFormDataFileNames(form, 'item_images[]'));
        const missingFiles = galleryFiles.filter(file => !payloadNames.has(file.name));
        if (missingFiles.length) createGeneratedFileInput(form, 'item_images[]', missingFiles);
    }

    const mainNames = getFormDataFileNames(form, 'image');
    const galleryNames = getFormDataFileNames(form, 'item_images[]');
    const expectedGalleryNames = galleryFiles.map(file => file.name);
    const missingAfterFill = expectedGalleryNames.filter(name => !galleryNames.includes(name));

    await logClientEvent(
        missingAfterFill.length ? 'ERROR' : 'INFO',
        'admin_images_payload_ready',
        `Prepared main=${mainNames.length}, gallery=${galleryNames.length}/${expectedGalleryNames.length}.`,
        {
            product_id: product.local_id,
            main_files: mainNames,
            gallery_files: galleryNames,
            expected_gallery_files: expectedGalleryNames,
            missing_gallery_files: missingAfterFill,
            file_input_count: form.querySelectorAll('input[type="file"][name="item_images[]"]').length,
        },
    );

    if (!mainNames.length) throw new Error('الصورة الرئيسية غير موجودة في FormData.');
    if (adminConfig.RequireAllImages && missingAfterFill.length) {
        throw new Error(`هناك ${missingAfterFill.length} صور معرض غير موجودة في الطلب. راجع تبويب التشخيص.`);
    }

    return {
        total: imageFiles.length,
        main: mainNames.length,
        galleryExpected: expectedGalleryNames.length,
        galleryAssigned: galleryNames.length,
        galleryNames,
        missingGalleryNames: missingAfterFill,
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

// Arabic: تعبئة المقاسات بالسعر والمخزون نفسيهما لكل مقاس.
// English: Fill size variants with identical price and stock for every size.
function fillSizeVariants(form, product) {
    form.querySelectorAll('[data-alphacode-generated="1"]:not([type="file"])').forEach(element => element.remove());
    const sizes = Array.from(new Set((product.sizes || []).map(value => String(value).trim()).filter(Boolean)));
    const settings = product.settings || {};

    if (!sizes.length) {
        setControlValue('[name="current_stock"]', settings.Stock || adminConfig.Stock || 0);
        return;
    }

    setControlValue('[name="current_stock"]', '');
    const attributeId = settings.SizeAttributeId || adminConfig.SizeAttributeId || 1;
    const choiceNo = settings.SizeChoiceNo || adminConfig.SizeChoiceNo || 1;
    const choiceTitle = settings.SizeTitle || adminConfig.SizeTitle || 'الحجم';
    appendHiddenInput(form, 'attribute_id[]', attributeId);
    appendHiddenInput(form, 'choice_no[]', choiceNo);
    appendHiddenInput(form, 'choice[]', choiceTitle);

    sizes.forEach(size => {
        appendHiddenInput(form, `choice_options_${choiceNo}[]`, size);
        appendHiddenInput(form, `price_${size}`, product.price);
        appendHiddenInput(form, `stock_${size}`, settings.Stock || adminConfig.Stock || 100);
    });
}

// Arabic: تعبئة حقول Sooqify الأساسية المؤكدة.
// English: Fill the confirmed core Sooqify product fields.
function fillCoreFields(product) {
    const settings = product.settings || {};
    setControlValue('[name="store_id"]', settings.StoreId || adminConfig.StoreId);
    setControlValue('[name="category_id"]', settings.CategoryId || adminConfig.CategoryId);
    setControlValue('[name="sub_category_id"]', settings.SubCategoryId || adminConfig.SubCategoryId);
    setControlValue('[name="brand_id"]', product.brand_id || adminConfig.BrandId);
    setControlValue('[name="unit"]', settings.UnitId || adminConfig.UnitId);
    setControlValue('[name="veg"]', String(settings.Veg === 'yes' ? 1 : (settings.Veg ?? 0)));
    setControlValue('[name="maximum_cart_quantity"]', settings.MaximumCartQuantity || '');
    setControlValue('[name="available_time_starts"]', settings.AvailableTimeStarts || '');
    setControlValue('[name="available_time_ends"]', settings.AvailableTimeEnds || '');
    setControlValue('[name="price"]', product.price);
    setControlValue('[name="discount_type"]', settings.DiscountType || 'percent');
    setControlValue('[name="discount"]', settings.Discount ?? 0);
    setControlValue('[name="tags"]', '');
}

// Arabic: جلب آخر منتج مجهز من التخزين أو من Flask كحل بديل.
// English: Load the latest prepared product from storage or fall back to Flask.
async function getLatestPreparedProduct() {
    const stored = await safeStorageGet(['pendingSooqifyProduct']);
    if (stored.pendingSooqifyProduct) return stored.pendingSooqifyProduct;

    const response = await fetch(`${LOCAL_API_BASE}/api/pending/latest`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'لا يوجد منتج مجهز.');
    await safeStorageSet({ pendingSooqifyProduct: data.pending_product });
    return data.pending_product;
}

// Arabic: تحديث حالة المنتج في الأرشيف المحلي.
// English: Update the product workflow status in the local archive.
async function updateWorkflowStatus(productId, status, details = {}) {
    try {
        await fetch(`${LOCAL_API_BASE}/api/archive/product/${productId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, details }),
        });
    } catch (error) {
        await logClientEvent('WARNING', 'workflow_status_update_failed', error.message, { product_id: productId, status });
    }
}

// Arabic: العثور على زر الإضافة الأصلي داخل نموذج المتجر.
// English: Locate the store's native product-submit button.
function findStoreSubmitButton(form) {
    const candidates = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'))
        .filter(element => isElementVisible(element) && !element.disabled && !element.closest('#alphacode-admin-panel'));
    const preferred = candidates.find(element => {
        const text = String(element.textContent || element.value || '').trim().toLowerCase();
        return /إضافة|حفظ|انشاء|إنشاء|add|save|submit|create/.test(text);
    });
    return preferred || form.querySelector('button[type="submit"], input[type="submit"]');
}

// Arabic: تسجيل ملخص FormData قبل الإرسال لتشخيص أي حقل ناقص.
// English: Log a FormData summary before submission to diagnose missing fields.
async function logFormPayloadSummary(form, product) {
    const formData = new FormData(form);
    const summary = {};
    for (const [key, value] of formData.entries()) {
        const displayed = value instanceof File
            ? { file_name: value.name, file_type: value.type, file_size: value.size }
            : String(value);
        if (Object.prototype.hasOwnProperty.call(summary, key)) {
            if (!Array.isArray(summary[key])) summary[key] = [summary[key]];
            summary[key].push(displayed);
        } else {
            summary[key] = displayed;
        }
    }
    await logClientEvent('INFO', 'admin_form_payload_summary', 'Prepared native Sooqify form payload.', {
        product_id: product.local_id,
        payload: summary,
    });
}

// Arabic: الضغط على زر المتجر الأصلي بعد التحقق وتسجيل حالة الإرسال.
// English: Click the native store button after validation and status logging.
async function submitStoreProduct(form, product, setStatus) {
    const delaySeconds = Math.max(0, Number(adminConfig.AutoSubmitDelaySeconds || 0));
    for (let remaining = delaySeconds; remaining > 0; remaining -= 1) {
        setStatus(`سيتم إضافة المنتج تلقائياً خلال ${remaining} ثانية...`, 'working');
        await sleep(1000);
    }

    const submitButton = findStoreSubmitButton(form);
    if (!submitButton) throw new Error('لم يتم العثور على زر إضافة المنتج الأصلي.');

    await logFormPayloadSummary(form, product);
    await updateWorkflowStatus(product.local_id, 'submit_started', {
        button_text: String(submitButton.textContent || submitButton.value || '').trim(),
    });
    sessionStorage.setItem('alphacodeSubmitProductId', String(product.local_id));
    await safeStorageSet({
        lastAutoSubmitProductId: product.local_id,
        lastAutoSubmitAttemptAt: new Date().toISOString(),
    });

    setStatus('يتم إرسال المنتج إلى المتجر الآن...', 'working');
    await logClientEvent('INFO', 'admin_auto_submit', 'Clicking the native store submit button.', {
        product_id: product.local_id,
        button_text: String(submitButton.textContent || submitButton.value || '').trim(),
    });
    submitButton.click();
}

// Arabic: تنفيذ تعبئة المنتج كاملة مع خيار الإرسال التلقائي.
// English: Populate the complete product form with optional automatic submission.
async function autofillLatestProduct(setStatus, options = {}) {
    await loadAdminConfiguration();
    const product = await getLatestPreparedProduct();
    const form = findProductForm();
    if (!form) throw new Error('لم يتم العثور على نموذج إضافة المنتج. افتح صفحة إضافة منتج جديد.');

    await logClientEvent('INFO', 'admin_autofill_started', 'Started Sooqify product autofill.', {
        product_id: product.local_id,
        requested_images: product.image_files?.length || 0,
        automatic_submit: Boolean(options.submitAfterFill),
        supplier_store_name: product.supplier_store_name,
    });

    setStatus('تعبئة الأسماء والأوصاف...', 'working');
    fillTranslations(form, product);
    fillCoreFields(product);
    fillSizeVariants(form, product);
    const imageResult = await fillImageInputs(form, product, setStatus);

    form.dataset.alphacodeProductId = String(product.local_id || '');
    await safeStorageSet({
        pendingSooqifyProduct: product,
        lastAutoFilledProductId: product.local_id,
        lastAutoFillAt: new Date().toISOString(),
    });

    setStatus(
        `تم تجهيز المنتج ${product.local_id}: صورة رئيسية + ${imageResult.galleryAssigned} صور معرض.`,
        'success',
    );
    await logClientEvent('INFO', 'admin_autofill_completed', 'Completed Sooqify product autofill.', {
        product_id: product.local_id,
        images: imageResult,
        sizes: product.sizes?.length || 0,
    });

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (options.submitAfterFill) await submitStoreProduct(form, product, setStatus);
    return product;
}

// Arabic: تطبيق موضع اللوحة المحدد أو الإحداثيات المسحوبة.
// English: Apply configured panel placement or previously dragged coordinates.
async function applyPanelPosition(panel) {
    const stored = await safeStorageGet(['adminPanelCoordinates']);
    const coordinates = stored.adminPanelCoordinates;
    panel.removeAttribute('style');
    panel.dataset.position = adminConfig.AdminPanelPosition || 'middle-left';
    if (coordinates && Number.isFinite(coordinates.left) && Number.isFinite(coordinates.top)) {
        panel.dataset.position = 'custom';
        panel.style.left = `${Math.max(0, coordinates.left)}px`;
        panel.style.top = `${Math.max(0, coordinates.top)}px`;
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

    handle.addEventListener('mousedown', event => {
        if (event.target.closest('button')) return;
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
        document.body.classList.add('alphacode-dragging');
    });

    document.addEventListener('mousemove', event => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + event.clientX - startX));
        const top = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + event.clientY - startY));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    });

    document.addEventListener('mouseup', async () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('alphacode-dragging');
        const rect = panel.getBoundingClientRect();
        if (isExtensionContextAvailable()) {
            try { await chrome.storage.local.set({ adminPanelCoordinates: { left: rect.left, top: rect.top } }); } catch (_) {}
        }
    });
}

// Arabic: إنشاء اللوحة العائمة بأسماء واضحة للمتجر المستهدف والمورد.
// English: Inject the floating panel with distinct target-store and supplier names.
async function injectAdminPanel() {
    if (document.getElementById('alphacode-admin-panel') || !findProductForm()) return;
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
    enablePanelDragging(panel, panel.querySelector('#alphacode-panel-handle'));

    const body = panel.querySelector('.alphacode-admin-body');
    const status = panel.querySelector('#alphacode-admin-status');
    const setStatus = (message, type = '') => {
        status.textContent = message;
        status.className = type;
    };

    panel.querySelector('#alphacode-collapse-panel').onclick = event => {
        body.classList.toggle('collapsed');
        event.currentTarget.textContent = body.classList.contains('collapsed') ? '+' : '−';
    };

    panel.querySelector('#alphacode-fill-product').onclick = async event => {
        event.currentTarget.disabled = true;
        try {
            await autofillLatestProduct(setStatus, { submitAfterFill: false });
        } catch (error) {
            setStatus(error.message, 'error');
            await logClientEvent('ERROR', 'admin_manual_autofill_failed', error.message, { stack: error.stack || '' });
        } finally {
            event.currentTarget.disabled = false;
        }
    };

    panel.querySelector('#alphacode-fill-submit').onclick = async event => {
        event.currentTarget.disabled = true;
        try {
            await autofillLatestProduct(setStatus, { submitAfterFill: true });
        } catch (error) {
            setStatus(error.message, 'error');
            await logClientEvent('ERROR', 'admin_manual_submit_failed', error.message, { stack: error.stack || '' });
            event.currentTarget.disabled = false;
        }
    };

    panel.querySelector('#alphacode-open-supplier').onclick = async () => {
        try {
            const product = await getLatestPreparedProduct();
            setStatus(
                `ID ${product.local_id} | ${product.brand_name || '-'} | ${product.style_code || '-'} | ${product.image_files?.length || 0} صور | المورد: ${product.supplier_store_name || '-'}`,
                'success',
            );
        } catch (error) {
            setStatus(error.message, 'error');
        }
    };

    panel.querySelector('#alphacode-reset-position').onclick = async () => {
        if (isExtensionContextAvailable()) {
            try { await chrome.storage.local.remove('adminPanelCoordinates'); } catch (_) {}
        }
        await applyPanelPosition(panel);
        setStatus('تمت إعادة موضع اللوحة حسب الإعدادات.', 'success');
    };
}

// Arabic: تشغيل الإضافة التلقائية مرة واحدة عند جاهزية نموذج المنتج.
// English: Run full automatic add once when the product form is ready.
async function runAutomaticAddIfEnabled() {
    if (automaticRunStarted || !findProductForm()) return;
    await loadAdminConfiguration();
    if (!adminConfig.AutoAddProduct) return;

    const product = await getLatestPreparedProduct();
    const stored = await safeStorageGet(['lastAutoSubmitProductId']);
    if (stored.lastAutoSubmitProductId === product.local_id) return;
    automaticRunStarted = true;

    const status = document.querySelector('#alphacode-admin-status');
    const setStatus = (message, type = '') => {
        if (!status) return;
        status.textContent = message;
        status.className = type;
    };

    try {
        await autofillLatestProduct(setStatus, { submitAfterFill: true });
    } catch (error) {
        setStatus(error.message, 'error');
        await updateWorkflowStatus(product.local_id, 'submit_failed', { error: error.message });
        await logClientEvent('ERROR', 'admin_automatic_add_failed', error.message, {
            product_id: product.local_id,
            stack: error.stack || '',
        });
    }
}

// Arabic: تأكيد نجاح الانتقال بعد إرسال المنتج وتحديث الأرشيف إلى submitted.
// English: Confirm post-submit navigation and mark the archived product as submitted.
async function confirmSubmissionAfterNavigation() {
    const productId = Number(sessionStorage.getItem('alphacodeSubmitProductId'));
    if (!productId || findProductForm()) return;
    await updateWorkflowStatus(productId, 'submitted', { redirected_to: window.location.href });
    sessionStorage.removeItem('alphacodeSubmitProductId');

    const stored = await safeStorageGet(['pendingSooqifyProduct']);
    if (stored.pendingSooqifyProduct?.local_id === productId && isExtensionContextAvailable()) {
        try { await chrome.storage.local.remove('pendingSooqifyProduct'); } catch (_) {}
    }
    await logClientEvent('INFO', 'admin_submission_confirmed', 'Store navigation confirmed after product submission.', {
        product_id: productId,
        page: window.location.href,
    });
}

// Arabic: تسجيل أخطاء JavaScript غير المعالجة في السجل الخارجي.
// English: Record unhandled JavaScript errors in the external log.
function installGlobalErrorLogging() {
    window.addEventListener('error', event => {
        logClientEvent('ERROR', 'admin_window_error', event.message || 'Unknown window error', {
            filename: event.filename,
            line: event.lineno,
            column: event.colno,
            stack: event.error?.stack || '',
        });
    });
    window.addEventListener('unhandledrejection', event => {
        const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || 'Unhandled rejection'));
        logClientEvent('ERROR', 'admin_unhandled_rejection', reason.message, { stack: reason.stack || '' });
    });
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
        if (adminPanelObserverTimer) return;
        adminPanelObserverTimer = setTimeout(async () => {
            try {
                await confirmSubmissionAfterNavigation();
                await injectAdminPanel();
                await runAutomaticAddIfEnabled();
            } finally {
                adminPanelObserverTimer = null;
            }
        }, 600);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    await logClientEvent('INFO', 'admin_adapter_ready', 'Sooqify admin adapter initialized.', {
        version: '3.2.0',
        target_store: adminConfig.StoreProfileName,
        supplier_store: adminConfig.SupplierStoreName,
    });
}

initializeAdminAutofill().catch(async error => {
    console.error('AlphaCode admin initialization failed:', error);
    await logClientEvent('ERROR', 'admin_initialization_failed', error.message, { stack: error.stack || '' });
});
