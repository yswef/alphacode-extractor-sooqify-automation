// =========================================================
// AlphaCode Extractor - Adaptive Supplier Throttle
// =========================================================
// Arabic: خلفية المشكلة — أثناء العمل السابق توقّف ألبوم szwego عن عرض المنتجات بعد
//         تحميلات متكررة سريعة (حوالي 8 تحميلات كاملة خلال دقيقتين). النمط المرصود:
//         **ليس** 429 ولا رسالة خطأ صريحة، بل الصفحة ترجع 200 عادية ومعها HTML سليم
//         لكن **قائمة المنتجات تعود فارغة** ("No More Data")، بينما بقيت نداءات الـAPI
//         الأخرى (getCurrencySymbol) تعمل طبيعياً. أي أن التقييد **صامت وجزئي** على
//         مستوى قائمة المنتجات، لا حظر كامل ولا رمز حالة يدل عليه.
//
//         لذلك أي كاشف يعتمد على `response.status` وحده لن يرصد شيئاً إطلاقاً. الكاشف هنا
//         يعتمد على ثلاث إشارات: فشل الطلب، **أو نجاح بنتيجة فارغة** (أهمها)، أو بطء
//         غير اعتيادي بالاستجابة.
//
// English: Background — during earlier work the szwego album stopped serving products after
//          repeated rapid loads (about 8 full loads in two minutes). The observed pattern is
//          **not** a 429 and not an explicit error: the page returns a normal 200 with valid
//          HTML but an **empty product list** ("No More Data"), while other API calls
//          (getCurrencySymbol) kept working normally. The limiting is therefore **silent and
//          partial**, scoped to the product list, with no status code to key off.
//
//          So any detector based on `response.status` alone would catch nothing. The detector
//          here uses three signals: a failed request, **or a successful-but-empty result**
//          (the important one), or an unusually slow response.
//
// Arabic: الحدود المقدَّرة عملياً (تقدير محافظ من الحادثة المرصودة، لا رقم رسمي من الموقع):
//           - ~8 تحميلات كاملة للقائمة خلال ~2 دقيقة كانت كافية لتفعيل التقييد.
//           - أي أقل من ~4 طلبات بالدقيقة للقائمة يبدو آمناً.
//         القيم الافتراضية أدناه تبدأ من 1.2 ثانية بين الطلبات (~50 بالدقيقة للطلبات
//         الخفيفة كالصور) وتتباطأ تلقائياً عند أول إشارة تقييد.
// English: Practically estimated limits (a conservative reading of the observed incident, not
//          an official figure published by the site):
//            - ~8 full list loads within ~2 minutes was enough to trigger the limiting.
//            - anything under ~4 list requests per minute appears safe.
//          The defaults below start at 1.2s between requests (~50/min for light requests such
//          as images) and slow down automatically at the first sign of limiting.
// =========================================================

(() => {
    'use strict';

    const DEFAULTS = {
        // Arabic: التأخير المبدئي بين طلبين متتاليين لنفس المضيف.
        // English: The starting delay between two consecutive requests to the same host.
        baseDelayMs: 1200,
        // Arabic: لا ننزل تحت هذا مهما تحسّن الوضع.
        // English: Never go below this, however well things are going.
        minDelayMs: 600,
        // Arabic: السقف الأعلى للتباطؤ (30 ثانية بين الطلبات).
        // English: The ceiling for slowing down (30s between requests).
        maxDelayMs: 30000,
        // Arabic: مضاعف التباطؤ عند رصد تقييد.
        // English: Back-off multiplier when limiting is detected.
        backoffFactor: 2,
        // Arabic: معامل التعافي التدريجي بعد كل نجاح نظيف.
        // English: Gradual recovery factor after each clean success.
        recoveryFactor: 0.85,
        // Arabic: استجابة أبطأ من هذا تُعد إشارة ضغط مبكرة.
        // English: A response slower than this counts as an early pressure signal.
        slowResponseMs: 8000,
        // Arabic: عدد المحاولات لكل طلب قبل الاستسلام.
        // English: Attempts per request before giving up.
        maxAttempts: 4,
    };

    // Arabic: حالة مستقلة لكل مضيف — تقييد صور xcimg لا يجب أن يبطئ نداءات ألبوم آخر.
    // English: Independent state per host - limiting on xcimg images must not slow calls to a
    //          different album host.
    const hostStates = new Map();

    function hostKey(url) {
        try {
            return new URL(url, globalThis.location?.href || 'https://szwego.com').host;
        } catch (_) {
            return 'unknown';
        }
    }

    function stateFor(key, options) {
        if (!hostStates.has(key)) {
            hostStates.set(key, {
                delayMs: options.baseDelayMs,
                nextAllowedAt: 0,
                consecutiveLimitHits: 0,
                totalRequests: 0,
                totalLimitHits: 0,
                chain: Promise.resolve(),
            });
        }
        return hostStates.get(key);
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

    // Arabic: المستمعون لتغيّر الحالة — تستخدمهم الواجهة لعرض رسالة انتظار واضحة.
    // English: State-change listeners - used by the UI to show a clear waiting message.
    const listeners = new Set();
    function notify(event) {
        for (const listener of listeners) {
            try { listener(event); } catch (_) { /* Arabic: مستمع تالف لا يوقف الطابور. English: a broken listener must not stall the queue. */ }
        }
    }

    /**
     * Arabic: ينفّذ طلباً واحداً تحت التحكم بالمعدّل، مع تباطؤ تلقائي وإعادة محاولة.
     *         `task` دالة تُرجع وعداً بالنتيجة. `isEmpty` دالة اختيارية تقرر هل النتيجة
     *         "فارغة" — وهي الإشارة الأهم هنا لأن التقييد يظهر كنجاح بنتيجة فارغة.
     * English: Runs one request under rate control, with automatic back-off and retries.
     *          `task` returns a promise of the result. `isEmpty` optionally decides whether a
     *          result is "empty" - the most important signal here, because the limiting shows
     *          up as a successful response with an empty result.
     */
    async function run(url, task, { isEmpty = null, label = '', ...overrides } = {}) {
        const options = { ...DEFAULTS, ...overrides };
        const key = hostKey(url);
        const state = stateFor(key, options);

        // Arabic: تسلسل الطلبات لكل مضيف حتى لا تتجاوز الطلبات المتوازية التأخير المفروض.
        // English: Serialize per host so parallel callers cannot bypass the enforced delay.
        const attempt = state.chain.then(async () => {
            let lastError = null;

            for (let tryIndex = 1; tryIndex <= options.maxAttempts; tryIndex += 1) {
                const waitMs = Math.max(0, state.nextAllowedAt - Date.now());
                if (waitMs > 1500) {
                    notify({
                        type: 'waiting', host: key, label, waitMs,
                        message: `الخادم يبطئ استجابته — جاري الانتظار ${Math.ceil(waitMs / 1000)} ثانية قبل المتابعة...`,
                    });
                }
                await sleep(waitMs);

                const startedAt = Date.now();
                state.totalRequests += 1;
                try {
                    const result = await task();
                    const elapsed = Date.now() - startedAt;
                    const empty = typeof isEmpty === 'function' ? Boolean(isEmpty(result)) : false;
                    const slow = elapsed >= options.slowResponseMs;

                    if (!empty && !slow) {
                        // Arabic: نجاح نظيف — نتعافى تدريجياً نحو السرعة الطبيعية.
                        // English: A clean success - recover gradually toward normal speed.
                        state.consecutiveLimitHits = 0;
                        state.delayMs = Math.max(
                            options.minDelayMs,
                            Math.round(state.delayMs * options.recoveryFactor),
                        );
                        state.nextAllowedAt = Date.now() + state.delayMs;
                        notify({ type: 'ok', host: key, label, delayMs: state.delayMs });
                        return result;
                    }

                    // Arabic: نجاح لكن بنتيجة فارغة أو بطيئة — هذي بصمة التقييد الصامت.
                    // English: Success but empty or slow - the signature of the silent limiting.
                    registerLimitHit(state, options, key, label, empty ? 'empty-result' : 'slow-response');
                    lastError = new Error(empty
                        ? 'الخادم أرجع نتيجة فارغة (مؤشر تقييد).'
                        : 'استجابة بطيئة جداً من الخادم (مؤشر تقييد).');

                    // Arabic: بالمحاولة الأخيرة نُرجع النتيجة كما هي بدل رمي خطأ — قد تكون
                    //         فارغة فعلاً لا مقيَّدة (منتج بلا صور مثلاً).
                    // English: On the final attempt return the result as-is rather than throwing -
                    //          it may genuinely be empty rather than limited (e.g. a product with
                    //          no images).
                    if (tryIndex === options.maxAttempts) return result;
                } catch (error) {
                    lastError = error;
                    registerLimitHit(state, options, key, label, 'request-failed');
                    if (tryIndex === options.maxAttempts) throw error;
                }
            }

            throw lastError || new Error('تعذر تنفيذ الطلب.');
        });

        // Arabic: أبقِ السلسلة حية حتى لو فشل هذا الطلب.
        // English: Keep the chain alive even if this request fails.
        state.chain = attempt.then(() => undefined, () => undefined);
        return attempt;
    }

    function registerLimitHit(state, options, host, label, reason) {
        state.consecutiveLimitHits += 1;
        state.totalLimitHits += 1;
        state.delayMs = Math.min(
            options.maxDelayMs,
            Math.max(options.minDelayMs, Math.round(state.delayMs * options.backoffFactor)),
        );
        state.nextAllowedAt = Date.now() + state.delayMs;
        notify({
            type: 'throttled', host, label, reason,
            delayMs: state.delayMs,
            consecutive: state.consecutiveLimitHits,
            message: `الخادم يبطئ استجابته (${reason}) — جاري الانتظار ${Math.ceil(state.delayMs / 1000)} ثانية قبل إعادة المحاولة...`,
        });
    }

    function getStats() {
        const stats = {};
        for (const [host, state] of hostStates) {
            stats[host] = {
                delayMs: state.delayMs,
                totalRequests: state.totalRequests,
                totalLimitHits: state.totalLimitHits,
                consecutiveLimitHits: state.consecutiveLimitHits,
            };
        }
        return stats;
    }

    function reset() {
        hostStates.clear();
    }

    globalThis.ALPHACODE_SUPPLIER_THROTTLE = Object.freeze({
        DEFAULTS,
        run,
        getStats,
        reset,
        onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    });
})();
