/*
 * Local-only Sooqify Admin brand-ID display helper.
 * Reads each brand row's edit/delete action URL and displays that real ID in the
 * first column instead of the row's 1..N display number. It does not send requests,
 * submit forms, or change data on the server. Reloading the page restores the page's
 * original HTML; DataTables redraws are re-applied automatically.
 */
(() => {
    'use strict';

    if (globalThis.__alphaSooqifyBrandIdOverlayInstalled) return;
    globalThis.__alphaSooqifyBrandIdOverlayInstalled = true;

    const BRAND_ACTION = /\/brand\/(?:delete|edit|update|show)\/(\d+)\/?$/i;
    const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    let scheduled = false;
    let lastReportedCount = -1;

    function actualBrandId(row) {
        const candidates = [];
        for (const form of row.querySelectorAll('form[action]')) candidates.push(form.action);
        for (const link of row.querySelectorAll('a[href]')) candidates.push(link.href);
        for (const element of row.querySelectorAll('[formaction],[data-url],[data-href]')) {
            candidates.push(
                element.getAttribute('formaction') ||
                element.getAttribute('data-url') ||
                element.getAttribute('data-href') ||
                '',
            );
        }

        for (const candidate of candidates) {
            try {
                const pathname = new URL(candidate, location.href).pathname;
                const match = pathname.match(BRAND_ACTION);
                if (match) return Number(match[1]);
            } catch (_) { /* Ignore malformed action attributes. */ }
        }
        return null;
    }

    function tableColumnIndexes(table) {
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (!headerRow) return null;
        const headers = [...headerRow.querySelectorAll('th,td')].map(cell => cleanText(cell.textContent));
        const numberIndex = headers.findIndex(header => /^(?:id|si|no\.?|number|رقم|الرقم)$/i.test(header));
        const nameIndex = headers.findIndex(header => /brand|اسم|العلامة|التجارية/i.test(header));
        return numberIndex >= 0 && nameIndex >= 0 ? { headerRow, numberIndex, nameIndex } : null;
    }

    function applyActualIds() {
        scheduled = false;
        let updated = 0;

        for (const table of document.querySelectorAll('table')) {
            const indexes = tableColumnIndexes(table);
            if (!indexes) continue;

            const heading = indexes.headerRow.querySelectorAll('th,td')[indexes.numberIndex];
            if (heading && !heading.hasAttribute('data-alpha-brand-id-heading')) {
                heading.setAttribute('data-alpha-brand-id-heading', '1');
                const oldTitle = heading.getAttribute('title');
                if (oldTitle !== null) {
                    heading.setAttribute('data-alpha-brand-id-old-title', oldTitle);
                    heading.setAttribute('data-alpha-brand-id-had-title', '1');
                }
                heading.setAttribute('title', 'يعرض هذا العمود ID البراند الفعلي من رابط الإجراء (عرض محلي فقط)');
            }

            for (const row of table.querySelectorAll('tbody tr')) {
                const cells = [...row.querySelectorAll('td,th')];
                const idCell = cells[indexes.numberIndex];
                if (!idCell || !cleanText(cells[indexes.nameIndex]?.textContent)) continue;

                const id = actualBrandId(row);
                if (!Number.isSafeInteger(id) || id <= 0) continue;

                if (!idCell.hasAttribute('data-alpha-brand-id-overlay')) {
                    idCell.setAttribute('data-alpha-brand-id-overlay', '1');
                    idCell.setAttribute('data-alpha-brand-id-original-value', idCell.textContent || '');
                    const oldTitle = idCell.getAttribute('title');
                    if (oldTitle !== null) {
                        idCell.setAttribute('data-alpha-brand-id-old-title', oldTitle);
                        idCell.setAttribute('data-alpha-brand-id-had-title', '1');
                    }
                }
                const actualText = String(id);
                if (cleanText(idCell.textContent) !== actualText) idCell.textContent = actualText;
                idCell.setAttribute('title', `ID الفعلي: ${actualText}`);
                updated += 1;
            }
        }

        if (updated > 0 && updated !== lastReportedCount) {
            console.info(`[Sooqify] عرض ID الفعلي بدلاً من رقم الترتيب في ${updated} صفوف. هذا تغيير بصري محلي فقط.`);
            lastReportedCount = updated;
        }
    }

    function scheduleUpdate() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(applyActualIds);
    }

    // Initial table, plus future redraws/search/pagination by the admin table widget.
    applyActualIds();
    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
})();
