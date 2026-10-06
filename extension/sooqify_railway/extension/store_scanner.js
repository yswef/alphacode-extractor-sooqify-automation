// Read-only paginated Sooqify list collector. Never requests view/edit/delete routes.
(() => {
    'use strict';

    if (!/\/admin\/item\/list\/?$/i.test(location.pathname)) return;
    if (document.getElementById('sooqify-railway-audit-trigger')) return;

    const API_ACTION = 'SOOQIFY_RAILWAY_API';
    const CONFIG_ACTION = 'SOOQIFY_RAILWAY_GET_CONFIG';
    const SAVE_CONFIG_ACTION = 'SOOQIFY_RAILWAY_SAVE_CONFIG';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function normalize(value) {
        return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    }

    function toLatinDigits(value) {
        return String(value || '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
    }

    function parseMoney(value) {
        const text = toLatinDigits(normalize(value)).replace(/,/g, '');
        const matches = Array.from(text.matchAll(/(?:^|[^\d])(\d+(?:\.\d{1,2})?)(?:[^\d]|$)/g));
        if (matches.length !== 1) return null;
        const number = Number(matches[0][1]);
        return Number.isFinite(number) && number >= 0 ? number : null;
    }

    function parseCount(value) {
        const matches = Array.from(toLatinDigits(normalize(value)).matchAll(/\d+/g));
        if (matches.length !== 1) return null;
        const count = Number(matches[0][0]);
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }

    function storeIdFromRow(row) {
        for (const link of row.querySelectorAll('a[href]')) {
            try {
                const pathname = new URL(link.href, location.href).pathname;
                const match = pathname.match(/\/admin\/item\/(?:view|edit)\/(\d+)(?:\/|$)/i);
                const id = Number(match?.[1] || 0);
                if (Number.isSafeInteger(id) && id > 0) return id;
            } catch (_) {}
        }
        return 0;
    }

    function headerKind(value) {
        const label = normalize(value).toLowerCase();
        if (/السعر|price|سعر/.test(label)) return 'price';
        if (/brand.?id|id.?brand|معرف.*العلامة|رقم.*العلامة|معرف.*البراند/.test(label)) return 'brand_id';
        if (/brand|براند|ماركة|العلامة التجارية/.test(label)) return 'brand';
        if (/\bsku\b|style.?code|كود.*ستايل|كود الصنف/.test(label)) return 'style_code';
        if (/search.?code|item.?code|رمز البحث|كود البحث/.test(label)) return 'search_code';
        if (/local.?id|alphacode.*id|معرف.*ألفا|رقم.*ألفا/.test(label)) return 'local_id';
        if (/image.?count|count.?of.?images|number.?of.?images|عدد الصور|عدد.*الصور/.test(label)) return 'image_count';
        if (/image|صورة|الصورة/.test(label)) return 'image';
        if (/\b(?:id|code|sku)\b|رقم|معرف/.test(label)) return '';

        const hasName = /\bname\b|\btitle\b|الاسم|اسم المنتج|^اسم$|^المنتج$|^product$/.test(label);
        if (hasName && /arabic|\bar\b|عربي|العربية/.test(label)) return 'name_ar';
        if (hasName && /english|\ben\b|إنجليزي|الإنجليزية/.test(label)) return 'name_en';
        if (hasName) return 'name';
        return '';
    }

    function findProductTable(doc) {
        const tables = Array.from(doc.querySelectorAll('table'));
        return tables
            .map(table => {
                const tbodyRows = Array.from(table.querySelectorAll('tbody tr')).filter(row => row.cells?.length);
                const candidateRows = tbodyRows.length
                    ? tbodyRows
                    : Array.from(table.querySelectorAll('tr')).filter(row => row.querySelector('td'));
                return {
                    table,
                    candidateRows,
                    rows: candidateRows.filter(row => storeIdFromRow(row)),
                    hasHeaders: Boolean(table.querySelector('thead th, th')),
                };
            })
            .filter(item => item.rows.length || item.hasHeaders)
            .sort((a, b) => b.rows.length - a.rows.length)[0] || null;
    }

    function parseListPage(doc, requestedPage) {
        const found = findProductTable(doc);
        if (!found) return { page: requestedPage, products: [], maxPage: 0, foundTable: false };
        if (found.candidateRows.length !== found.rows.length) {
            throw new Error(`بعض صفوف جدول القائمة لا تحتوي رابط إجراء يمكن استخراج Store ID منه (صفحة ${requestedPage}).`);
        }

        const headerRow = found.table.querySelector('thead tr')
            || Array.from(found.table.querySelectorAll('tr')).find(row => row.querySelector('th'));
        const headerCells = Array.from(headerRow?.querySelectorAll('th, td') || []);
        if (headerCells.length && found.rows.some(row => row.cells.length !== headerCells.length)) {
            throw new Error(`عدد أعمدة الصف لا يطابق العناوين في الصفحة ${requestedPage}؛ المسح غير مكتمل.`);
        }
        const columns = headerCells.map(cell => headerKind(cell.textContent));
        const fieldsAvailable = {
            name: columns.some(key => ['name', 'name_en', 'name_ar'].includes(key)),
            price: columns.includes('price'),
            brand: columns.includes('brand'),
            brand_id: columns.includes('brand_id'),
            image_count: columns.includes('image_count'),
            style_code: columns.includes('style_code'),
            search_code: columns.includes('search_code'),
            local_id_tags: columns.includes('local_id'),
        };
        const products = [];

        for (const row of found.rows) {
            const cells = Array.from(row.cells || []);
            const id = storeIdFromRow(row);
            const values = {};
            cells.forEach((cell, index) => {
                const key = columns[index];
                if (key && !values[key]) values[key] = normalize(cell.textContent);
            });

            products.push({
                id,
                name_en: values.name_en || '',
                name_ar: values.name_ar || '',
                name: values.name || '',
                brand_name: values.brand || '',
                brand_id: fieldsAvailable.brand_id ? parseCount(values.brand_id) : null,
                price: parseMoney(values.price),
                image_count: fieldsAvailable.image_count ? parseCount(values.image_count) : null,
                style_code: values.style_code || '',
                search_code: values.search_code || '',
                fields_available: fieldsAvailable,
                local_tags: fieldsAvailable.local_id_tags && values.local_id ? [values.local_id] : [],
            });
        }

        let maxPage = 0;
        const pageLinks = Array.from(doc.querySelectorAll('a[href*="page="]'));
        const linkedPages = [];
        for (const link of pageLinks) {
            try {
                const url = new URL(link.href, location.href);
                const page = Number(url.searchParams.get('page') || 0);
                const label = normalize(`${link.textContent} ${link.getAttribute('aria-label') || ''} ${link.title || ''} ${link.rel || ''} ${link.className || ''}`).toLowerCase();
                if (page > 0) linkedPages.push({ page, label });
                if (page > maxPage && /last|الأخيرة|الاخيرة|آخر صفحة|»»/.test(label)) maxPage = page;
            } catch (_) {}
        }
        const hasPagination = pageLinks.length > 1 || Boolean(doc.querySelector('.pagination, [aria-label*="pagination" i]'));
        const activePageElement = doc.querySelector('.pagination .active, .pagination [aria-current="page"]');
        const activeLink = activePageElement?.querySelector('a[href*="page="]');
        let activePage = Number(activeLink ? new URL(activeLink.href, location.href).searchParams.get('page') : 0);
        if (!activePage && activePageElement) activePage = Number(toLatinDigits(activePageElement.textContent).match(/\d+/)?.[0] || 0);
        if (maxPage && linkedPages.some(item => item.page > maxPage)) {
            throw new Error(`روابط الترقيم تتجاوز الصفحة الأخيرة المعلنة في الصفحة ${requestedPage}.`);
        }
        const currentPage = activePage || requestedPage;
        const hasNext = linkedPages.some(item => item.page > currentPage) || pageLinks.some(link => {
            if (link.getAttribute('aria-disabled') === 'true' || link.closest('.disabled')) return false;
            const label = normalize(`${link.textContent} ${link.getAttribute('aria-label') || ''} ${link.title || ''} ${link.rel || ''}`).toLowerCase();
            const isNext = /next|التالي|التالية|›|»|→|>/.test(label);
            if (!isNext) return false;
            const target = Number(new URL(link.href, location.href).searchParams.get('page') || 0);
            return !target || target > currentPage;
        });
        return { page: requestedPage, products, maxPage, hasPagination, activePage, hasNext, hasPageLinks: pageLinks.length > 0, foundTable: true };
    }

    async function fetchListPage(page) {
        const url = new URL('/admin/item/list', location.origin);
        url.searchParams.set('page', String(page));
        const response = await fetch(url.href, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'text/html' },
        });
        if (!response.ok) throw new Error(`تعذر قراءة صفحة القائمة ${page} (HTTP ${response.status}).`);
        const finalUrl = new URL(response.url || url.href, location.href);
        if (/\/login(?:\/|$)/i.test(finalUrl.pathname)) {
            throw new Error('انتهت جلسة Sooqify؛ سجّل الدخول يدوياً وأدخل التحدي ثم أعد الفحص.');
        }
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (doc.querySelector('input[type="password"]') || /\/login(?:\/|$)/i.test(finalUrl.pathname)) {
            throw new Error('الجلسة غير مسجلة. أكمل تسجيل الدخول يدوياً ثم أعد الفحص.');
        }
        const parsed = parseListPage(doc, page);
        if (!parsed.foundTable) throw new Error(`لم أتعرف على جدول قائمة المنتجات في الصفحة ${page}.`);
        return parsed;
    }

    async function scanListOnly(onProgress) {
        const pages = [];
        const seenIds = new Set();
        let maxPage = 0;
        let reachedEnd = false;
        let repeatedPage = false;

        for (let page = 1; page <= 5000; page++) {
            onProgress(`قراءة صفحة القائمة ${page}...`);
            const result = await fetchListPage(page);
            if (result.maxPage) maxPage = Math.max(maxPage, result.maxPage);
            if (!result.products.length) {
                throw new Error(`لم أجد صفوف منتجات قابلة للتحقق في الصفحة ${page}؛ لم تُعتمد لقطة جديدة.`);
            }
            if (result.activePage && result.activePage !== page) {
                throw new Error(`طلبت الصفحة ${page} لكن ترقيم القائمة أظهر الصفحة ${result.activePage}؛ المسح غير مكتمل.`);
            }

            const ids = result.products.map(product => product.id);
            const signature = ids.join(',');
            if (pages.length && pages[pages.length - 1].signature === signature) {
                const previousPage = pages[pages.length - 1].page;
                const reachedClampedLastPage = result.activePage === previousPage && !result.hasNext;
                if ((maxPage && page <= maxPage) || !reachedClampedLastPage) {
                    throw new Error('رُصد تكرار صفحة دون دليل كافٍ على نهاية الترقيم؛ المسح غير مكتمل.');
                }
                repeatedPage = true;
                reachedEnd = true;
                break;
            }
            const duplicates = ids.filter(id => seenIds.has(id));
            if (duplicates.length) {
                throw new Error(`تغيّرت القائمة أثناء المسح وظهرت IDs مكررة (${duplicates.slice(0, 3).join(', ')}). أعد المسح لاحقاً.`);
            }
            ids.forEach(id => seenIds.add(id));
            pages.push({ page, products: result.products, signature });

            if (maxPage && page >= maxPage) {
                reachedEnd = true;
                break;
            }
            if (!maxPage && !result.hasNext) {
                if (result.hasPagination && (!result.activePage || result.activePage !== page || !result.hasPageLinks)) {
                    throw new Error(`تعذر التحقق من نهاية الترقيم بعد الصفحة ${page}؛ المسح غير مكتمل.`);
                }
                reachedEnd = true;
                break;
            }
            if (page === 5000) throw new Error('تجاوز الفحص حد 5000 صفحة؛ لم تُعتمد اللقطة.');
            await sleep(120);
        }

        if (!pages.length) throw new Error('لم يُعثر على أي صف منتج في قائمة Sooqify.');
        if (!reachedEnd) throw new Error('لم يتم إثبات الوصول إلى نهاية قائمة Sooqify؛ لم تُعتمد اللقطة.');
        return {
            pages: pages.map(({ page, products }) => ({ page, products })),
            complete: true,
            repeatedPage,
        };
    }

    function runtimeMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, response => {
                const error = chrome.runtime.lastError;
                if (error) return reject(new Error(error.message));
                if (!response?.success) return reject(new Error(response?.error || 'فشل الاتصال بخدمة Railway.'));
                resolve(response);
            });
        });
    }

    async function railwayRequest(method, path, body) {
        const response = await runtimeMessage({
            action: API_ACTION,
            request: { method, path, ...(body === undefined ? {} : { body }) },
        });
        return response;
    }

    async function runScan(status) {
        const scanId = `sooqify_${crypto.randomUUID().replace(/-/g, '')}`;
        const scan = await scanListOnly(status);
        status(`اكتمل جمع ${scan.pages.length} صفحة من القائمة؛ جارٍ رفع لقطة القراءة فقط...`);
        await railwayRequest('POST', '/api/audit/scans/start', {
            scan_id: scanId,
            expected_pages: scan.pages.length,
            started_at: new Date().toISOString(),
        });
        for (const page of scan.pages) {
            status(`رفع الصفحة ${page.page} من ${scan.pages.length}...`);
            await railwayRequest('POST', `/api/audit/scans/${scanId}/pages/${page.page}`, {
                products: page.products,
            });
        }
        const completed = await railwayRequest('POST', `/api/audit/scans/${scanId}/complete`, {
            captured_at: new Date().toISOString(),
        });
        status(`اكتمل الفحص: ${completed.product_count} منتجاً عبر ${scan.pages.length} صفحة. لم تُفتح صفحات العرض أو التعديل أو الحذف.`);
    }

    function addControl() {
        const trigger = document.createElement('button');
        trigger.id = 'sooqify-railway-audit-trigger';
        trigger.type = 'button';
        trigger.textContent = 'تدقيق Railway — قراءة فقط';
        Object.assign(trigger.style, {
            position: 'fixed', bottom: '18px', left: '18px', zIndex: '2147483646',
            padding: '10px 14px', border: '0', borderRadius: '8px', color: '#fff',
            background: '#172554', font: 'bold 13px sans-serif', cursor: 'pointer',
            boxShadow: '0 4px 18px #0004',
        });
        document.documentElement.appendChild(trigger);

        const panel = document.createElement('section');
        panel.id = 'sooqify-railway-audit-panel';
        Object.assign(panel.style, {
            position: 'fixed', bottom: '66px', left: '18px', zIndex: '2147483646',
            width: '340px', maxWidth: 'calc(100vw - 36px)', padding: '14px',
            borderRadius: '10px', background: '#fff', color: '#172033',
            boxShadow: '0 6px 24px #0005', direction: 'rtl', font: '13px sans-serif',
            display: 'none',
        });
        panel.innerHTML = `
            <strong>فحص قائمة Sooqify (GET فقط)</strong>
            <p style="margin:8px 0;color:#475569">يُدخل التحدي يدوياً في تسجيل الدخول. الفاحص يقرأ صفحات القائمة فقط ولا يفتح العرض أو التعديل أو الحذف.</p>
            <label style="display:block;margin:8px 0 4px">رابط خدمة Railway</label>
            <input id="sooqify-railway-url" type="url" dir="ltr" placeholder="https://your-service.up.railway.app" style="box-sizing:border-box;width:100%;padding:8px">
            <label style="display:block;margin:8px 0 4px">AUDIT_API_TOKEN</label>
            <input id="sooqify-railway-token" type="password" dir="ltr" autocomplete="new-password" placeholder="رمز محفوظ محلياً في Chrome" style="box-sizing:border-box;width:100%;padding:8px">
            <div style="display:flex;gap:8px;margin-top:10px">
                <button id="sooqify-railway-save" type="button" style="flex:1;padding:8px">حفظ الإعدادات</button>
                <button id="sooqify-railway-start" type="button" style="flex:1;padding:8px;background:#172554;color:#fff">ابدأ الفحص</button>
            </div>
            <div id="sooqify-railway-status" role="status" style="margin-top:10px;white-space:pre-wrap"></div>`;
        document.documentElement.appendChild(panel);

        const statusElement = panel.querySelector('#sooqify-railway-status');
        const setStatus = value => { statusElement.textContent = String(value || ''); };
        trigger.addEventListener('click', async () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') {
                try {
                    const config = await runtimeMessage({ action: CONFIG_ACTION });
                    panel.querySelector('#sooqify-railway-url').value = config.baseUrl || '';
                    setStatus(config.configured ? 'الإعدادات جاهزة؛ لم يتم عرض الرمز المحفوظ.' : 'أدخل رابط Railway والرمز مرة واحدة.');
                } catch (error) { setStatus(error.message); }
            }
        });

        panel.querySelector('#sooqify-railway-save').addEventListener('click', async () => {
            const baseUrl = panel.querySelector('#sooqify-railway-url').value.trim();
            const token = panel.querySelector('#sooqify-railway-token').value.trim();
            try {
                await runtimeMessage({ action: SAVE_CONFIG_ACTION, config: { baseUrl, token } });
                panel.querySelector('#sooqify-railway-token').value = '';
                setStatus('تم حفظ الإعدادات محلياً في تخزين Chrome.');
            } catch (error) { setStatus(error.message); }
        });

        panel.querySelector('#sooqify-railway-start').addEventListener('click', async event => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                await runScan(setStatus);
            } catch (error) {
                setStatus(`توقف الفحص دون اعتماد لقطة كاملة:\n${error.message}`);
            } finally {
                button.disabled = false;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addControl, { once: true });
    } else {
        addControl();
    }
})();
