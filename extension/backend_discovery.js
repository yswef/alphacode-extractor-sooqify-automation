// =========================================================
// AlphaCode Extractor - Backend Port Discovery
// =========================================================
// Arabic: المشكلة التي يعالجها هذا الملف — الباك اند يسقط تلقائياً إلى المنفذ التالي
//         (5001، 5002 ...) لو كان 5000 مشغولاً (عملية قديمة لم تُغلق مثلاً)، بينما كانت
//         الإضافة تستخدم منفذاً ثابتاً من config.js. النتيجة: الإضافة تكلّم منفذاً لا أحد
//         يستمع عليه، فتفشل المزامنة وجلب البراندات والأرشيف بصمت — وهو بالضبط بلاغ
//         "أول مرة أزامن والبورت مختلف ما يزامن". وكانت رسالة الباك اند نفسها تطلب تعديل
//         BackendPort يدوياً بـconfig.js، وهذا ما لا يفعله أحد ولا يجب أن يُطلب منه.
//
//         الحل: تكتشف الإضافة المنفذ بنفسها. تجرّب المنفذ المحفوظ أولاً (أسرع مسار)، ثم
//         تمسح مدى صغيراً من المنافذ بحثاً عن /api/health يرد بـservice = "AlphaCode
//         Extractor" — والتحقق من الاسم مهم حتى لا نتكلم مع خادم آخر يصادف أنه على نفس
//         المنفذ. يُحفظ المنفذ المكتشف، ويُعاد الاكتشاف تلقائياً عند أول فشل لاحق.
//
// English: The problem this file solves - the backend automatically falls back to the next
//          port (5001, 5002 ...) when 5000 is busy (an old process still holding it, say),
//          while the extension used a fixed port from config.js. The result: the extension
//          talks to a port nobody is listening on, and sync, brand loading and archive calls
//          all fail silently - exactly the reported "first time syncing, the port is different
//          and it doesn't sync". The backend's own startup message asked the operator to edit
//          BackendPort in config.js by hand, which nobody does and nobody should have to.
//
//          The fix: the extension discovers the port itself. It tries the remembered port
//          first (the fast path), then scans a small range for an /api/health that answers
//          with service = "AlphaCode Extractor" - checking the name matters so we never talk
//          to some unrelated server that happens to sit on the same port. The discovered port
//          is remembered, and rediscovery is triggered automatically on the next failure.
// =========================================================

(() => {
    'use strict';

    const HOST = 'http://127.0.0.1';
    const SERVICE_NAME = 'AlphaCode Extractor';
    const STORAGE_KEY = 'alphacodeBackendPort';
    // Arabic: نفس مدى المنافذ الذي يجرّبه الباك اند عند السقوط (start_port + offset).
    // English: The same port range the backend walks when falling back (start_port + offset).
    const SCAN_COUNT = 10;
    const PROBE_TIMEOUT_MS = 1200;

    function configuredPort() {
        const port = Number((globalThis.ALPHACODE_DEFAULT_CONFIG || {}).BackendPort);
        return Number.isFinite(port) && port > 0 ? port : 5000;
    }

    let resolvedPort = null;
    let inFlight = null;

    // Arabic: يتحقق أن هذا المنفذ عليه باك اند AlphaCode فعلاً، لا أي خادم آخر.
    // English: Verifies this port really hosts an AlphaCode backend, not just any server.
    async function probe(port) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
            const response = await fetch(`${HOST}:${port}/api/health`, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!response.ok) return false;
            const data = await response.json();
            return Boolean(data && data.success && data.service === SERVICE_NAME);
        } catch (_) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function readRememberedPort() {
        try {
            const stored = await chrome.storage.local.get([STORAGE_KEY]);
            const port = Number(stored[STORAGE_KEY]);
            return Number.isFinite(port) && port > 0 ? port : null;
        } catch (_) {
            return null;
        }
    }

    async function rememberPort(port) {
        try {
            await chrome.storage.local.set({ [STORAGE_KEY]: port });
        } catch (_) { /* Arabic: تعذّر الحفظ لا يمنع العمل. English: a failed save must not block work. */ }
    }

    // Arabic: يُرجع المنفذ الحي، أو المنفذ المُعَد كملاذ أخير حتى تبقى رسائل الخطأ مفهومة.
    // English: Returns the live port, or the configured one as a last resort so error messages
    //          still make sense.
    async function discoverPort() {
        const candidates = [];
        const remembered = await readRememberedPort();
        if (remembered) candidates.push(remembered);
        const base = configuredPort();
        if (!candidates.includes(base)) candidates.push(base);
        for (let offset = 0; offset < SCAN_COUNT; offset += 1) {
            const port = base + offset;
            if (!candidates.includes(port)) candidates.push(port);
        }

        for (const port of candidates) {
            // Arabic: بالتسلسل لا بالتوازي - أول مرشّح هو الصحيح غالباً، ولا داعي لإزعاج
            //         عشرة منافذ على جهاز المستخدم في كل مرة.
            // English: Sequential, not parallel - the first candidate is usually right, and
            //          there is no need to poke ten ports on the operator's machine every time.
            if (await probe(port)) {
                resolvedPort = port;
                await rememberPort(port);
                return port;
            }
        }

        resolvedPort = null;
        return base;
    }

    // Arabic: العنوان الأساسي للباك اند. يكتشف المنفذ مرة واحدة ثم يعيد استخدامه.
    // English: The backend base URL. Discovers the port once, then reuses it.
    async function getBackendBase() {
        if (resolvedPort) return `${HOST}:${resolvedPort}`;
        if (!inFlight) {
            inFlight = discoverPort().finally(() => { inFlight = null; });
        }
        const port = await inFlight;
        return `${HOST}:${port}`;
    }

    // Arabic: يُنسي المنفذ المكتشف ليُعاد البحث عند النداء التالي - يُستدعى عند فشل طلب.
    // English: Forgets the discovered port so the next call rediscovers - called on a failure.
    function invalidateBackendPort() {
        resolvedPort = null;
    }

    // Arabic: غلاف fetch يوجّه المسار للمنفذ الصحيح، ويعيد المحاولة مرة واحدة بعد إعادة
    //         الاكتشاف لو فشل الاتصال (مثلاً أُعيد تشغيل الباك اند على منفذ آخر).
    // English: A fetch wrapper that routes a path to the right port and retries once after
    //          rediscovery if the connection fails (e.g. the backend restarted on another port).
    async function backendFetch(path, options) {
        const url = async () => `${await getBackendBase()}${path}`;
        try {
            return await fetch(await url(), options);
        } catch (error) {
            invalidateBackendPort();
            return fetch(await url(), options);
        }
    }

    globalThis.ALPHACODE_BACKEND = Object.freeze({
        STORAGE_KEY,
        SERVICE_NAME,
        configuredPort,
        probe,
        discoverPort,
        getBackendBase,
        invalidateBackendPort,
        backendFetch,
    });
})();
