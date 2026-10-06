// Railway bridge for the existing MV3 service worker. No Sooqify cookies are sent.
(() => {
    'use strict';

    const STORAGE_KEY = 'sooqifyRailwayAuditConfig';
    const PENDING_BASELINES_KEY = 'sooqifyRailwayPendingBaselines';
    let baselineQueuePromise = Promise.resolve();

    function serializeBaselineOperation(operation) {
        const result = baselineQueuePromise.then(operation, operation);
        baselineQueuePromise = result.catch(() => {});
        return result;
    }

    function validateConfig(input) {
        const baseUrl = String(input?.baseUrl || '').trim().replace(/\/+$/, '');
        const token = String(input?.token || '').trim();
        let parsed;
        try {
            parsed = new URL(baseUrl);
        } catch (_) {
            throw new Error('أدخل رابط خدمة Railway الصحيح.');
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
            throw new Error('أدخل أصل الخدمة HTTPS فقط، من دون مسار أو بيانات دخول أو معاملات.');
        }
        if (!parsed.hostname.endsWith('.up.railway.app')) {
            throw new Error('استخدم رابط Railway المنتهي بـ .up.railway.app حالياً.');
        }
        if (token.length < 20) {
            throw new Error('رمز AUDIT_API_TOKEN يجب أن يكون طويلاً؛ لا تستخدم قيمة تجريبية.');
        }
        return { baseUrl, token };
    }

    async function getConfig() {
        const saved = await chrome.storage.local.get(STORAGE_KEY);
        const config = saved[STORAGE_KEY] || {};
        return {
            success: true,
            configured: Boolean(config.baseUrl && config.token),
            baseUrl: String(config.baseUrl || ''),
            hasToken: Boolean(config.token),
        };
    }

    async function saveConfig(input) {
        const config = validateConfig(input);
        return serializeBaselineOperation(async () => {
            await chrome.storage.local.set({ [STORAGE_KEY]: config });
            await flushPendingBaselines();
            return { success: true, baseUrl: config.baseUrl, hasToken: true };
        });
    }

    async function apiRequest({ method = 'GET', path, body }) {
        if (!/^\/api\/[A-Za-z0-9_./{}-]+$/.test(String(path || ''))) {
            throw new Error('مسار API غير صالح.');
        }
        const saved = await chrome.storage.local.get(STORAGE_KEY);
        const config = saved[STORAGE_KEY] || {};
        if (!config.baseUrl || !config.token) {
            throw new Error('اضبط رابط Railway والرمز أولاً من لوحة الفحص.');
        }
        const response = await fetch(`${config.baseUrl}${path}`, {
            method,
            credentials: 'omit',
            cache: 'no-store',
            headers: {
                Authorization: `Bearer ${config.token}`,
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let result = {};
        try { result = await response.json(); } catch (_) {}
        if (!response.ok || result.success === false) {
            throw new Error(String(result.error || `Railway returned HTTP ${response.status}.`));
        }
        return result;
    }

    function cleanBaseline(input) {
        const product = input && typeof input === 'object' ? input : {};
        const localId = Number(product.local_id || 0);
        const original = Number(product.original_price_yuan);
        const settings = product.settings && typeof product.settings === 'object' ? product.settings : {};
        const type = String(product.product_type || '').toLowerCase();
        const rate = Number(settings.ExchangeRate);
        const feeKey = type === 'watches' ? 'WatchFlatFeeYuan' : 'AddedFeeYuan';
        const fee = Number(settings[feeKey]);
        if (!Number.isSafeInteger(localId) || localId <= 0 || !Number.isFinite(original) || original <= 0
            || !['shoes', 'watches'].includes(type) || !Number.isFinite(rate) || rate <= 0
            || !Number.isFinite(fee) || fee < 0) {
            throw new Error('مدخلات خط أساس السعر غير مكتملة؛ لم تُرسل إلى Railway.');
        }
        return {
            local_id: localId,
            name_en: String(product.name_en || '').slice(0, 400),
            name_ar: String(product.name_ar || '').slice(0, 400),
            product_type: type,
            original_price_yuan: original,
            price_sar: Number.isFinite(Number(product.price_sar)) ? Number(product.price_sar) : null,
            settings: { ExchangeRate: rate, [feeKey]: fee },
        };
    }

    async function readPendingBaselines() {
        const saved = await chrome.storage.local.get(PENDING_BASELINES_KEY);
        return Array.isArray(saved[PENDING_BASELINES_KEY]) ? saved[PENDING_BASELINES_KEY] : [];
    }

    async function writePendingBaselines(items) {
        await chrome.storage.local.set({ [PENDING_BASELINES_KEY]: items.slice(-5000) });
    }

    async function flushPendingBaselines() {
        const pending = await readPendingBaselines();
        const saved = await chrome.storage.local.get(STORAGE_KEY);
        const config = saved[STORAGE_KEY] || {};
        if (!config.baseUrl || !config.token) {
            return { sent: 0, pending: pending.length };
        }

        const unsent = [];
        for (let index = 0; index < pending.length; index += 1) {
            const product = pending[index];
            try {
                await apiRequest({
                    method: 'POST',
                    path: '/api/pricing-baselines',
                    body: { products: [product] },
                });
            } catch (error) {
                unsent.push(product);
                if (!String(error?.message || '').includes('Conflicting pricing baseline')) {
                    unsent.push(...pending.slice(index + 1));
                    break;
                }
            }
        }
        await writePendingBaselines(unsent);
        return { sent: pending.length - unsent.length, pending: unsent.length };
    }

    async function savePriceBaseline(message) {
        const product = cleanBaseline(message.product);
        return serializeBaselineOperation(async () => {
            const pending = await readPendingBaselines();
            const next = pending.filter(item => Number(item.local_id) !== product.local_id);
            next.push(product);
            await writePendingBaselines(next);
            const result = await flushPendingBaselines();
            return { success: true, queued: result.pending > 0, pending: result.pending };
        });
    }

    async function handle(message) {
        if (message.action === 'SOOQIFY_RAILWAY_GET_CONFIG') return getConfig();
        if (message.action === 'SOOQIFY_RAILWAY_SAVE_CONFIG') return saveConfig(message.config || {});
        if (message.action === 'SOOQIFY_RAILWAY_API') return apiRequest(message.request || {});
        if (message.action === 'SOOQIFY_RAILWAY_PRICE_BASELINE') return savePriceBaseline(message);
        if (message.action === 'SOOQIFY_RAILWAY_FLUSH_PENDING_BASELINES') {
            return serializeBaselineOperation(flushPendingBaselines);
        }
        throw new Error('Unknown Railway bridge action.');
    }

    globalThis.ALPHACODE_RAILWAY_AUDIT = { handle };
})();
