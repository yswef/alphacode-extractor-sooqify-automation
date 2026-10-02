/*
 * Read-only diagnostic for Sooqify Admin > Brand page.
 * Paste this whole file into DevTools Console while logged in to /admin/brand.
 * It does not click buttons, submit forms, or modify store data.
 * For convenience, it temporarily replaces the visible row number with the real brand ID
 * in this browser tab only; the original number is retained in the report. Refreshing the page
 * or uninstalling the probe restores the original display. Sensitive fields are redacted.
 */
(() => {
    'use strict';

    const PROBE_VERSION = '2.2.0';
    const existingProbe = globalThis.__alphaSooqifyBrandProbe;
    if (existingProbe?.installed) {
        if (existingProbe.version === PROBE_VERSION) {
            console.info(`Brand probe v${PROBE_VERSION} is already installed; copying a fresh report.`);
            existingProbe.copy({ automatic: true, reason: 'probe rerun' }).catch(error => {
                console.warn('[Sooqify brand probe] Automatic clipboard copy failed:', error);
            });
            return existingProbe;
        }
        if (typeof existingProbe.uninstall === 'function') {
            console.info(`Replacing older brand probe${existingProbe.version ? ` v${existingProbe.version}` : ''} with v${PROBE_VERSION}.`);
            existingProbe.uninstall();
        } else {
            console.warn('An older brand probe is still installed and cannot be replaced safely. Refresh this page, then paste the updated probe.');
            return null;
        }
    }

    const SENSITIVE = /token|secret|password|passwd|authorization|cookie|csrf|session|api[_-]?key/i;
    const BRAND_URL = /brand/i;
    const requests = [];
    let autoCopyTimer = null;
    let probeReference = null;

    function queueAutoCopy(reason, delay = 250) {
        if (!probeReference) return;
        clearTimeout(autoCopyTimer);
        autoCopyTimer = setTimeout(() => {
            probeReference?.copy({ automatic: true, reason }).catch(error => {
                console.warn('[Sooqify brand probe] Automatic clipboard copy failed:', error);
            });
        }, delay);
    }

    const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const redact = (key, value) => {
        if (SENSITIVE.test(String(key || ''))) return '[redacted]';
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
        if (Array.isArray(value)) return value.map(item => redact('', item));
        if (typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
                childKey,
                SENSITIVE.test(childKey) ? '[redacted]' : redact(childKey, childValue),
            ]));
        }
        return String(value);
    };

    function safeUrl(rawUrl) {
        try {
            const url = new URL(String(rawUrl || ''), location.href);
            for (const key of [...url.searchParams.keys()]) {
                if (SENSITIVE.test(key)) url.searchParams.set(key, '[redacted]');
            }
            return `${url.origin}${url.pathname}${url.search}`;
        } catch (_) {
            return String(rawUrl || '').slice(0, 500);
        }
    }

    function safeRequestFields(value) {
        const usefulField = /brand|name|(^id$)|action|status|success|error/i;
        if (Array.isArray(value)) return value.map(item => safeRequestFields(item));
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, child]) => {
                if (SENSITIVE.test(key)) return [key, '[redacted]'];
                return [key, usefulField.test(key) ? safeRequestFields(child) : '[omitted]'];
            }));
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try { return safeRequestFields(JSON.parse(trimmed)); } catch (_) { /* treat as an ordinary value */ }
            }
            return trimmed.slice(0, 500);
        }
        return value;
    }

    function parseBody(body) {
        if (body == null) return null;
        if (typeof body === 'string') {
            const trimmed = body.trim();
            if (!trimmed) return '';
            try {
                return safeRequestFields(JSON.parse(trimmed));
            } catch (_) {
                if (trimmed.includes('=') && !trimmed.startsWith('<')) {
                    const params = new URLSearchParams(trimmed);
                    return safeRequestFields(Object.fromEntries(params.entries()));
                }
                return { body_omitted: true, length: trimmed.length };
            }
        }
        if (body instanceof URLSearchParams) return safeRequestFields(Object.fromEntries(body.entries()));
        if (body instanceof FormData) {
            const entries = Object.fromEntries([...body.entries()].map(([key, value]) => [
                key,
                value instanceof File ? `[file: ${value.name}]` : String(value),
            ]));
            return safeRequestFields(entries);
        }
        if (typeof body === 'object') return safeRequestFields(body);
        return `[${typeof body}]`;
    }

    function rowRecordId(row) {
        const actionCandidates = [];
        for (const form of row.querySelectorAll('form[action]')) actionCandidates.push(form.action);
        for (const link of row.querySelectorAll('a[href]')) actionCandidates.push(link.href);
        for (const element of row.querySelectorAll('[formaction],[data-url],[data-href]')) {
            actionCandidates.push(element.getAttribute('formaction') || element.getAttribute('data-url') || element.getAttribute('data-href') || '');
        }

        for (const candidate of actionCandidates) {
            try {
                const pathname = new URL(candidate, location.href).pathname;
                const match = pathname.match(/\/brand\/(?:delete|edit|update|show)\/(\d+)\/?$/i);
                if (match) return { id: Number(match[1]), source: 'row_action_url' };
            } catch (_) { /* ignore malformed page attributes */ }
        }

        // Only explicitly named record-ID attributes are trusted as a fallback. Generic
        // data-id / the visible number column may be a row index, so do not treat them as IDs.
        for (const element of row.querySelectorAll('[data-brand-id],[data-record-id]')) {
            const raw = element.getAttribute('data-brand-id') || element.getAttribute('data-record-id') || '';
            if (/^\d+$/.test(raw)) return { id: Number(raw), source: 'row_record_data_attribute' };
        }
        const rowRecordId = row.getAttribute('data-brand-id') || row.getAttribute('data-record-id') || '';
        if (/^\d+$/.test(rowRecordId)) return { id: Number(rowRecordId), source: 'row_record_data_attribute' };
        return { id: null, source: 'not_found' };
    }

    function showRealBrandIdsInTable() {
        const updatedRows = [];
        for (const table of document.querySelectorAll('table')) {
            const headRow = table.querySelector('thead tr') || table.querySelector('tr');
            const headerCells = headRow ? [...headRow.querySelectorAll('th,td')] : [];
            const headers = headerCells.map(cell => cleanText(cell.textContent));
            const numberIndex = headers.findIndex(header => /^(?:id|no\.?|number|رقم|الرقم)$/i.test(header));
            const nameIndex = headers.findIndex(header => /brand|اسم|العلامة|التجارية/i.test(header));
            if (numberIndex < 0 || nameIndex < 0) continue;

            const numberHeader = headerCells[numberIndex];
            if (numberHeader && !numberHeader.hasAttribute('data-alpha-brand-probe-id-header')) {
                numberHeader.setAttribute('data-alpha-brand-probe-id-header', '1');
                const oldTitle = numberHeader.getAttribute('title');
                if (oldTitle !== null) {
                    numberHeader.setAttribute('data-alpha-brand-probe-had-title', '1');
                    numberHeader.setAttribute('data-alpha-brand-probe-original-title', oldTitle);
                }
                numberHeader.setAttribute('title', 'معرّف قاعدة البيانات الفعلي — عرض محلي فقط');
            }

            for (const row of table.querySelectorAll('tbody tr')) {
                const cells = [...row.querySelectorAll('td,th')];
                const numberCell = cells[numberIndex];
                if (!numberCell || !cleanText(cells[nameIndex]?.textContent)) continue;
                const record = rowRecordId(row);
                if (!Number.isInteger(record.id) || record.id <= 0) continue;

                if (!row.hasAttribute('data-alpha-brand-probe-original-number')) {
                    row.setAttribute('data-alpha-brand-probe-original-number', numberCell.textContent || '');
                    numberCell.setAttribute('data-alpha-brand-probe-id-cell', '1');
                    numberCell.setAttribute('data-alpha-brand-probe-original-text', numberCell.textContent || '');
                    const oldTitle = numberCell.getAttribute('title');
                    if (oldTitle !== null) {
                        numberCell.setAttribute('data-alpha-brand-probe-had-title', '1');
                        numberCell.setAttribute('data-alpha-brand-probe-original-title', oldTitle);
                    }
                }
                numberCell.textContent = String(record.id);
                numberCell.setAttribute('title', `ID الفعلي: ${record.id} — رقم العرض الأصلي: ${cleanText(row.getAttribute('data-alpha-brand-probe-original-number'))}`);
                updatedRows.push({ id: record.id, name: cleanText(cells[nameIndex].textContent) });
            }
        }
        return updatedRows;
    }

    function restoreOriginalBrandNumbers() {
        for (const cell of document.querySelectorAll('[data-alpha-brand-probe-id-cell="1"]')) {
            cell.textContent = cell.getAttribute('data-alpha-brand-probe-original-text') || '';
            if (cell.getAttribute('data-alpha-brand-probe-had-title') === '1') {
                cell.setAttribute('title', cell.getAttribute('data-alpha-brand-probe-original-title') || '');
            } else {
                cell.removeAttribute('title');
            }
            cell.removeAttribute('data-alpha-brand-probe-id-cell');
            cell.removeAttribute('data-alpha-brand-probe-original-text');
            cell.removeAttribute('data-alpha-brand-probe-had-title');
            cell.removeAttribute('data-alpha-brand-probe-original-title');
        }
        for (const row of document.querySelectorAll('[data-alpha-brand-probe-original-number]')) {
            row.removeAttribute('data-alpha-brand-probe-original-number');
        }
        for (const header of document.querySelectorAll('[data-alpha-brand-probe-id-header="1"]')) {
            if (header.getAttribute('data-alpha-brand-probe-had-title') === '1') {
                header.setAttribute('title', header.getAttribute('data-alpha-brand-probe-original-title') || '');
            } else {
                header.removeAttribute('title');
            }
            header.removeAttribute('data-alpha-brand-probe-id-header');
            header.removeAttribute('data-alpha-brand-probe-had-title');
            header.removeAttribute('data-alpha-brand-probe-original-title');
        }
    }

    function tableReport() {
        const tables = [...document.querySelectorAll('table')].map((table, tableIndex) => {
            const headRow = table.querySelector('thead tr') || table.querySelector('tr');
            const headers = headRow ? [...headRow.querySelectorAll('th,td')].map(cell => cleanText(cell.textContent)) : [];
            const rowEntries = [...table.querySelectorAll('tbody tr')].map(row => ({
                row,
                cells: [...row.querySelectorAll('td,th')].map(cell => cleanText(cell.textContent)),
                record: rowRecordId(row),
            })).filter(entry => entry.cells.some(Boolean));

            const rowNumberIndex = headers.findIndex(header => /^(?:id|no\.?|number|رقم|الرقم)$/i.test(header));
            for (const entry of rowEntries) {
                const originalNumber = entry.row.getAttribute('data-alpha-brand-probe-original-number');
                if (originalNumber !== null && rowNumberIndex >= 0) entry.cells[rowNumberIndex] = originalNumber;
            }
            const rows = rowEntries.map(entry => entry.cells);
            const nameIndex = headers.findIndex(header => /brand|اسم|العلامة|التجارية/i.test(header));
            const countIndex = headers.findIndex(header => /product|count|إجمالي|المنتجات/i.test(header));
            const brands = [];

            if (rowNumberIndex >= 0 && nameIndex >= 0) {
                for (const entry of rowEntries) {
                    const cells = entry.cells;
                    const displayedNumberText = (cells[rowNumberIndex] || '').replace(/[^0-9]/g, '');
                    const name = cleanText(cells[nameIndex]);
                    if (!name) continue;
                    brands.push({
                        // Use the record ID from the row's edit/delete URL. The visible first
                        // column can be a display index (1..N), not the database primary key.
                        id: entry.record.id,
                        id_source: entry.record.source,
                        ...(displayedNumberText ? { displayed_number: Number(displayedNumberText) } : {}),
                        name,
                        ...(countIndex >= 0 ? { product_count: (cells[countIndex] || '').replace(/[^0-9]/g, '') } : {}),
                    });
                }
            }
            return { table_index: tableIndex, headers, rows, brands };
        });
        const candidates = tables
            .flatMap(table => table.brands)
            .filter(brand => Number.isInteger(brand.id) && brand.id > 0 && brand.name);
        return { tables, brands: candidates };
    }

    function formReport() {
        return [...document.forms].map((form, formIndex) => ({
            form_index: formIndex,
            action: safeUrl(form.action || location.href),
            method: String(form.method || 'GET').toUpperCase(),
            fields: [...form.elements].filter(element => element.name || element.id).map(element => {
                const type = String(element.type || element.tagName || '').toLowerCase();
                const label = element.labels?.[0]?.textContent || '';
                const hidden = type === 'hidden';
                const sensitive = SENSITIVE.test(`${element.name || ''} ${element.id || ''} ${label}`);
                const item = {
                    name: element.name || '',
                    id: element.id || '',
                    type,
                    label: cleanText(label),
                    required: Boolean(element.required),
                    disabled: Boolean(element.disabled),
                };
                if (!hidden && !sensitive && !['password', 'file'].includes(type)) {
                    item.value = cleanText(element.value).slice(0, 200);
                } else if (hidden || sensitive) {
                    item.value = '[redacted]';
                }
                return item;
            }),
            submit_buttons: [...form.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')]
                .map(button => cleanText(button.textContent || button.value)),
        }));
    }

    function recordRequest(record) {
        if (!BRAND_URL.test(record.url)) return;
        requests.push({ at: new Date().toISOString(), ...record });
        if (requests.length > 30) requests.shift();
        console.info('[Sooqify brand probe] brand request', requests[requests.length - 1]);
        queueAutoCopy('brand request captured');
    }

    // Observe future fetch calls without changing their result or timing.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (...args) {
        const input = args[0];
        const init = args[1] || {};
        const url = safeUrl(typeof input === 'string' ? input : input?.url);
        const method = String(init.method || input?.method || 'GET').toUpperCase();
        const body = parseBody(init.body);
        const promise = originalFetch.apply(this, args);
        if (BRAND_URL.test(url)) {
            recordRequest({ transport: 'fetch', method, url, request_body: body });
            promise.then(response => {
                response.clone().text().then(text => {
                    let responseBody = text.slice(0, 2000);
                    try { responseBody = redact('', JSON.parse(text)); } catch (_) { /* keep bounded text */ }
                    recordRequest({ transport: 'fetch-response', method, url, status: response.status, response_body: responseBody });
                }).catch(() => {});
            }).catch(() => {});
        }
        return promise;
    };

    // Observe future XMLHttpRequest calls (including common jQuery AJAX requests).
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__alphaBrandProbeRequest = {
            method: String(method || 'GET').toUpperCase(),
            url: safeUrl(url),
        };
        return xhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const info = this.__alphaBrandProbeRequest;
        if (info && BRAND_URL.test(info.url)) {
            recordRequest({ transport: 'xhr', ...info, request_body: parseBody(body) });
            this.addEventListener('load', () => {
                let responseBody = '';
                try {
                    if (this.responseType === 'json') {
                        responseBody = redact('', this.response);
                    } else if (this.responseType === '' || this.responseType === 'text') {
                        responseBody = String(this.responseText || '').slice(0, 2000);
                        try { responseBody = redact('', JSON.parse(responseBody)); } catch (_) { /* keep bounded text */ }
                    } else {
                        responseBody = `[responseType: ${this.responseType}]`;
                    }
                } catch (_) { responseBody = '[response unavailable]'; }
                recordRequest({ transport: 'xhr-response', ...info, status: this.status, response_body: responseBody });
            }, { once: true });
        }
        return xhrSend.call(this, body);
    };

    // Capture regular HTML form submissions too. This listener does not cancel submission.
    const submitListener = event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const entries = [...new FormData(form).entries()].map(([key, value]) => [
            key,
            SENSITIVE.test(key)
                ? '[redacted]'
                : (value instanceof File ? `[file: ${value.name}]` : String(value).slice(0, 500)),
        ]);
        recordRequest({
            transport: 'form-submit',
            method: String(form.method || 'GET').toUpperCase(),
            url: safeUrl(form.action || location.href),
            request_body: Object.fromEntries(entries),
        });
    };
    document.addEventListener('submit', submitListener, true);

    const reportTables = tableReport();
    const visuallyUpdatedRows = showRealBrandIdsInTable();
    const probe = {
        version: PROBE_VERSION,
        installed: true,
        snapshot() {
            const tablesNow = tableReport();
            return {
                probe_version: PROBE_VERSION,
                page: { origin: location.origin, path: location.pathname, title: document.title },
                captured_at: new Date().toISOString(),
                brands: tablesNow.brands,
                tables: tablesNow.tables,
                forms: formReport(),
                recent_brand_requests: [...requests],
                note: 'Sensitive token/password/cookie/CSRF fields are redacted. The visible first-column IDs are a browser-only display overlay; the original row number is retained as displayed_number. Refresh or uninstall to restore it. No form was submitted by this probe.',
            };
        },
        async copy({ automatic = false, reason = '' } = {}) {
            const json = JSON.stringify(this.snapshot(), null, 2);
            try {
                if (typeof globalThis.copy === 'function') {
                    globalThis.copy(json);
                } else if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(json);
                } else {
                    throw new Error('Clipboard API is unavailable in this browser context');
                }
                console.info(automatic
                    ? `[Sooqify brand probe] Latest report copied automatically${reason ? ` (${reason})` : ''}. Paste it here.`
                    : '[Sooqify brand probe] Report copied.');
            } catch (error) {
                console.warn('[Sooqify brand probe] Clipboard copy was blocked; the report is printed below.', error);
                console.log(json);
            }
            return json;
        },
        uninstall() {
            clearTimeout(autoCopyTimer);
            globalThis.fetch = originalFetch;
            XMLHttpRequest.prototype.open = xhrOpen;
            XMLHttpRequest.prototype.send = xhrSend;
            document.removeEventListener('submit', submitListener, true);
            restoreOriginalBrandNumbers();
            probeReference = null;
            delete globalThis.__alphaSooqifyBrandProbe;
            console.info('Brand probe removed.');
        },
    };
    probeReference = probe;
    globalThis.__alphaSooqifyBrandProbe = probe;

    console.info(`[Sooqify brand probe] Installed v${PROBE_VERSION}. Actual IDs are shown in the first column for ${visuallyUpdatedRows.length} rows in this browser tab only; refresh or uninstall to restore.`);
    console.info('[Sooqify brand probe] Verified brand rows:', reportTables.brands);
    console.info('[Sooqify brand probe] Forms:', formReport());
    console.info('The report is copied automatically. After any brand request, the updated report is copied again. Use __alphaSooqifyBrandProbe.copy() if automatic clipboard access is blocked.');
    queueAutoCopy('initial page scan', 0);
    return probe;
})();
