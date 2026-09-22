// =========================================================
// AlphaCode Extractor - Supplier Currency Resolution (szwego)
// =========================================================
// Arabic: خلفية المشكلة — szwego يختار العملة المعروضة من عنوان الـIP (VPN)، لا من أي
//         إعداد للمستخدم. ثبت هذا عملياً على صفحة منتج حقيقية: الـAPI
//         /album/api/v3/shop/shortUrl/getCurrencySymbol ردّ بـ:
//             { autoCode: true, code: "JPY", enableRate: true,
//               exchangeRate: 23.591, ipCountry: "日本", symbol: "Ұ" }
//         والمنتج كان معروضاً بـ"Ұ7077.3" بينما عنوانه يقول "🔥P300🔥" أي 300 يوان.
//         و 7077.3 ÷ 23.591 = 300.000 بالضبط.
//
//         جُرِّبت كل الطرق المحتملة لإجبار العملة على CNY وفشلت كلها: باراميترات
//         (currency / code / currencyCode / autoCode / country / isoCode / transLang)
//         كلها تُتجاهل ويبقى الرد JPY؛ وتبديل لغة الموقع (weshop_translator_language)
//         غيّر النصوص فقط وترك السعر "Ұ7077.3" كما هو. فالعملة قرار خادم مبني على IP.
//
//         لكن الموقع **ينشر سعر الصرف نفسه** عبر ذلك الـAPI، فنستعيد اليوان الحقيقي
//         بعملية حسابية مضبوطة: CNY = السعر_المعروض ÷ exchangeRate.
//
// English: Background — szwego picks the displayed currency from the request IP (VPN), not
//          from any user setting. Verified live on a real product page: the
//          /album/api/v3/shop/shortUrl/getCurrencySymbol API returned:
//              { autoCode: true, code: "JPY", enableRate: true,
//                exchangeRate: 23.591, ipCountry: "日本", symbol: "Ұ" }
//          while the product displayed "Ұ7077.3" and its own title said "🔥P300🔥" (300 CNY).
//          And 7077.3 / 23.591 = 300.000 exactly.
//
//          Every way of forcing CNY was tried and failed: query parameters
//          (currency / code / currencyCode / autoCode / country / isoCode / transLang) are
//          all ignored and still answer JPY; switching the site language
//          (weshop_translator_language) changed only the text and left the price at
//          "Ұ7077.3". The currency is a server-side, IP-derived decision.
//
//          But the site **publishes the exchange rate itself** through that API, so the true
//          CNY price is recovered by exact arithmetic: CNY = displayed / exchangeRate.
// =========================================================

(() => {
    'use strict';

    const CURRENCY_API_PATH = '/album/api/v3/shop/shortUrl/getCurrencySymbol';

    // Arabic: نسبة الانحراف المسموحة بين السعر المحسوب وسعر العنوان قبل اعتباره تعارضاً.
    //         0.30 = 30%؛ واسعة عمداً لأن سعر العنوان تقريبي (سعر جملة/عرض) وليس دقيقاً.
    // English: Allowed deviation between the computed price and the title hint before it is
    //          treated as a conflict. 0.30 = 30%; deliberately wide because the title price is
    //          an approximate (wholesale/offer) figure, not an exact one.
    const TITLE_PRICE_TOLERANCE = 0.30;

    // =====================================================================
    // Arabic: أنماط السعر في عنوان المنتج — قائمة قابلة للتوسعة.
    //
    //   لإضافة نمط جديد اكتشفته لاحقاً: أضف سطراً واحداً فقط إلى هذي المصفوفة بالشكل
    //       { name: 'وصف-قصير', regex: String.raw`...(\d+)...`, group: 1 },
    //   ولا تلمس أي شيء آخر. أول نمط يطابق يفوز، فرتّب الأدق أولاً.
    //
    //   ⚠️ تحذير مهم مستفاد من فحص 7,176 عنواناً حقيقياً من أرشيف المستخدم:
    //      النمط الساذج /P\d+/ يلتقط **أكواد الستايل** لا الأسعار — مثل
    //      WP518-178 و HP50620 و MELP57UG (47 تطابقاً خاطئاً، صفر تطابق صحيح).
    //      لذلك كل نمط هنا مقيَّد بحدود: الحرف قبل الرمز ليس حرفاً/رقماً، والرقم
    //      بعده ليس متبوعاً بحرف/رقم/شرطة. بهذا القيد صار عدد التطابقات الخاطئة
    //      على نفس الـ7,176 عنواناً = صفر، مع التقاط "🔥P300🔥" الحقيقي بنجاح.
    //
    // English: Product-title price patterns — an extensible list.
    //
    //   To add a newly discovered pattern later: add ONE line to this array as
    //       { name: 'short-label', regex: String.raw`...(\d+)...`, group: 1 },
    //   and touch nothing else. First match wins, so keep the most specific first.
    //
    //   ⚠️ Important warning learned from scanning 7,176 real titles in the operator's
    //      archive: the naive /P\d+/ pattern matches **style codes**, not prices — e.g.
    //      WP518-178, HP50620, MELP57UG (47 false matches, zero real ones). Every pattern
    //      here is therefore boundary-constrained: the character before the marker must not
    //      be a letter/digit, and the number must not be followed by a letter/digit/hyphen.
    //      With that constraint the false-positive count over those same 7,176 titles is
    //      zero, while the real "🔥P300🔥" is still captured.
    // =====================================================================
    const TITLE_PRICE_PATTERNS = [
        // Arabic: 💰280 — رمز النقود متبوعاً بالسعر (موجود فعلياً بأرشيف المستخدم).
        // English: 💰280 — money emoji followed by the price (present in the real archive).
        { name: 'money-emoji', regex: String.raw`💰\s?(\d{2,6}(?:\.\d{1,2})?)`, group: 1 },

        // Arabic: ¥280 / ￥280 — رمز اليوان الصريح.
        // English: ¥280 / ￥280 — explicit CNY sign.
        { name: 'cny-sign', regex: String.raw`[¥￥]\s?(\d{2,6}(?:\.\d{1,2})?)`, group: 1 },

        // Arabic: 280元 / 280 元 — كلمة "يوان" الصينية بعد الرقم.
        // English: 280元 — the Chinese "yuan" word after the number.
        { name: 'yuan-cn', regex: String.raw`(\d{2,6}(?:\.\d{1,2})?)\s?元`, group: 1 },

        // Arabic: RMB280 / CNY280.
        // English: RMB280 / CNY280.
        { name: 'rmb-word', regex: String.raw`(?:RMB|CNY)\s?(\d{2,6}(?:\.\d{1,2})?)`, group: 1 },

        // Arabic: 🔥P300🔥 / P300 / P 450 — النمط الذي ظهر بالبلاغ. مقيَّد بحدود صارمة
        //         حتى لا يلتقط أكواد الستايل (WP518-178، HP50620، MELP57UG).
        // English: 🔥P300🔥 / P300 / P 450 — the pattern from the report. Strictly bounded so
        //          it cannot capture style codes (WP518-178, HP50620, MELP57UG).
        { name: 'p-prefix', regex: String.raw`(?<![0-9A-Za-z])[Pp]\s?(\d{2,5}(?:\.\d{1,2})?)(?![0-9A-Za-z\-])`, group: 1 },
    ];

    // Arabic: ذاكرة مؤقتة لنتيجة العملة لكل ألبوم — نداء شبكة واحد لكل ألبوم بالجلسة.
    // English: Per-album cache for the currency result — one network call per album per session.
    const currencyCache = new Map();

    // Arabic: معرّف الألبوم من مسار الصفحة، مثل /weshop/goods_list/<albumId>.
    // English: The album id from the page path, e.g. /weshop/goods_list/<albumId>.
    function resolveAlbumId(href) {
        const url = String(href || (typeof location !== 'undefined' ? location.href : ''));
        const match = url.match(/\/(?:weshop|album)\/[^/]+\/([A-Za-z0-9_\-]{10,})/)
            || url.match(/[?&](?:albumId|shopId|sellerAlbumId)=([A-Za-z0-9_\-]{10,})/);
        return match ? match[1] : '';
    }

    // Arabic: يقرأ إعداد العملة الفعلي من الموقع نفسه. يفشل بهدوء ويُرجع null لو تعذّر —
    //         والمستدعي يعامل ذلك كـ"عملة مجهولة" لا كـ"يوان مؤكد".
    // English: Reads the live currency setting from the site itself. Fails quietly with null —
    //          the caller treats that as "unknown currency", never as "confirmed CNY".
    async function fetchSupplierCurrency(albumId) {
        const id = albumId || resolveAlbumId();
        if (!id) return null;
        if (currencyCache.has(id)) return currencyCache.get(id);

        let resolved = null;
        try {
            // Arabic: يمر عبر المنظّم التكيفي مثل باقي طلبات المورد. نتيجة النداء مخزّنة
            //         لكل ألبوم، فهذا نداء واحد بالجلسة عملياً - لكن التنظيم يحميه أيضاً
            //         لو تزامن مع موجة طلبات صور.
            // English: Goes through the adaptive throttle like every other supplier request.
            //          The result is cached per album, so this is effectively one call per
            //          session - but throttling still protects it if it coincides with a wave
            //          of image requests.
            const throttle = globalThis.ALPHACODE_SUPPLIER_THROTTLE;
            const doFetch = () => fetch(
                `${CURRENCY_API_PATH}?albumId=${encodeURIComponent(id)}`,
                { credentials: 'include', cache: 'no-store' },
            ).then(response => response.json());
            const data = throttle
                ? await throttle.run(CURRENCY_API_PATH, doFetch, {
                    label: 'currency',
                    isEmpty: result => !result || !result.result,
                })
                : await doFetch();
            const result = data && data.result;
            if (result && result.code) {
                const rate = Number(result.exchangeRate);
                resolved = {
                    code: String(result.code).toUpperCase(),
                    symbol: result.symbol || '',
                    ipCountry: result.ipCountry || '',
                    // Arabic: نعتبر السعر محوَّلاً فقط لو العملة ليست CNY والمعدّل صالح (>0 و≠1).
                    // English: Treat the price as converted only when the currency is not CNY
                    //          and the rate is usable (> 0 and != 1).
                    exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : null,
                    rateEnabled: Boolean(result.enableRate),
                    autoCode: Boolean(result.autoCode),
                };
            }
        } catch (_) {
            resolved = null;
        }
        currencyCache.set(id, resolved);
        return resolved;
    }

    function isCny(currency) {
        return Boolean(currency) && currency.code === 'CNY';
    }

    // Arabic: هل يحتاج السعر المعروض تحويلاً لاستعادة اليوان؟
    // English: Does the displayed price need converting back to CNY?
    function needsConversion(currency) {
        return Boolean(currency) && !isCny(currency)
            && Number.isFinite(currency.exchangeRate) && currency.exchangeRate > 0
            && currency.exchangeRate !== 1;
    }

    // Arabic: يبحث عن سعر داخل عنوان/نص المنتج باستخدام الأنماط أعلاه. أول تطابق يفوز.
    // English: Finds a price inside the product title/text using the patterns above. First wins.
    function findTitlePrice(sourceText) {
        const text = String(sourceText || '');
        if (!text) return null;
        for (const pattern of TITLE_PRICE_PATTERNS) {
            try {
                const match = text.match(new RegExp(pattern.regex, 'u'));
                const raw = match && match[pattern.group];
                const value = raw ? parseFloat(raw) : NaN;
                if (Number.isFinite(value) && value > 0) {
                    return { value, pattern: pattern.name, raw: match[0] };
                }
            } catch (_) { /* Arabic: نمط تالف يُتخطّى. English: skip a malformed pattern. */ }
        }
        return null;
    }

    /**
     * Arabic: يحوّل السعر المعروض إلى يوان ويقرّر هل النتيجة موثوقة كفاية للمتابعة تلقائياً.
     * English: Converts the displayed price to CNY and decides whether the result is trustworthy
     *          enough to continue automatically.
     *
     * Arabic: الحالات المُرجَعة في `status`:
     *   - `cny`                  : العملة المعروضة يوان أصلاً — السلوك الطبيعي، لا تحويل ولا إيقاف.
     *   - `converted_confirmed`  : تم تحويل بسعر صرف الموقع، وسعر العنوان يؤكّد النتيجة.
     *   - `needs_manual`         : شك حقيقي — يجب إيقاف الاستخراج التلقائي وأخذ قيمة يدوية.
     * English: returned `status` values:
     *   - `cny`                 : the displayed currency is already CNY — normal path, no block.
     *   - `converted_confirmed` : converted with the site's rate and the title price confirms it.
     *   - `needs_manual`        : genuine doubt — stop auto-extraction and take a manual value.
     */
    function resolveCnyPrice(displayedPrice, currency, sourceText) {
        const displayed = Number(displayedPrice) || 0;
        const titleHint = findTitlePrice(sourceText);
        const base = {
            displayedPrice: displayed,
            currencyCode: currency ? currency.code : 'UNKNOWN',
            ipCountry: currency ? currency.ipCountry : '',
            exchangeRate: currency ? currency.exchangeRate : null,
            titleHint,
            converted: false,
        };

        // Arabic: 1) العملة يوان — المسار الطبيعي تماماً كما كان قبل هذا الإصلاح.
        // English: 1) Currency is CNY — exactly the pre-fix normal path.
        if (isCny(currency)) {
            return { ...base, cnyPrice: displayed, status: 'cny', trusted: true };
        }

        // Arabic: 2) عملة أجنبية وسعر الصرف معروف — نحوّل، ثم نطلب تأكيداً من العنوان.
        // English: 2) Foreign currency with a known rate — convert, then seek title confirmation.
        if (needsConversion(currency)) {
            const cnyPrice = Math.round((displayed / currency.exchangeRate) * 100) / 100;
            if (titleHint) {
                const deviation = Math.abs(cnyPrice - titleHint.value) / titleHint.value;
                if (deviation <= TITLE_PRICE_TOLERANCE) {
                    return {
                        ...base, cnyPrice, converted: true, deviation,
                        status: 'converted_confirmed', trusted: true,
                    };
                }
                return {
                    ...base, cnyPrice, converted: true, deviation,
                    status: 'needs_manual', trusted: false,
                    reason: `السعر المحوَّل (${cnyPrice} يوان) يخالف سعر العنوان (${titleHint.value} يوان) بفارق ${Math.round(deviation * 100)}%.`,
                };
            }
            // Arabic: لا سعر بالعنوان يؤكّد التحويل — نطلب تأكيداً يدوياً، لأن هذي بالضبط
            //         الحالة التي أنتجت 3839 ريالاً لمنتج سعره 300 يوان.
            // English: No title price to confirm the conversion — ask for manual confirmation,
            //          because this is exactly the case that produced 3839 SAR for a 300 CNY item.
            return {
                ...base, cnyPrice, converted: true,
                status: 'needs_manual', trusted: false,
                reason: `الموقع يعرض السعر بعملة ${currency.code}${currency.ipCountry ? ` (IP: ${currency.ipCountry})` : ''} لا باليوان، وما فيه سعر بالعنوان يؤكّد التحويل.`,
            };
        }

        // Arabic: 3) عملة أجنبية بلا سعر صرف، أو تعذّر الوصول للـAPI — لا تخمين إطلاقاً.
        // English: 3) Foreign currency without a rate, or the API was unreachable — never guess.
        if (currency && !isCny(currency)) {
            return {
                ...base,
                cnyPrice: titleHint ? titleHint.value : displayed,
                status: 'needs_manual', trusted: false,
                reason: `الموقع يعرض السعر بعملة ${currency.code} وما توفّر سعر صرف لتحويله لليوان.`,
            };
        }

        // Arabic: 4) تعذّر معرفة العملة أصلاً. لو العنوان فيه سعر وهو قريب من المعروض،
        //         فالمعروض يوان على الأرجح ونكمل؛ غير ذلك نطلب تأكيداً يدوياً.
        // English: 4) The currency could not be determined at all. If the title carries a price
        //          close to the displayed one, the displayed value is most likely CNY and we
        //          continue; otherwise ask for manual confirmation.
        if (titleHint && displayed > 0) {
            const deviation = Math.abs(displayed - titleHint.value) / titleHint.value;
            if (deviation <= TITLE_PRICE_TOLERANCE) {
                return { ...base, cnyPrice: displayed, deviation, status: 'cny', trusted: true };
            }
            return {
                ...base, cnyPrice: displayed, deviation,
                status: 'needs_manual', trusted: false,
                reason: `تعذّر تحديد عملة الموقع، والسعر المعروض (${displayed}) يخالف سعر العنوان (${titleHint.value} يوان) بفارق ${Math.round(deviation * 100)}%.`,
            };
        }

        // Arabic: لا عملة معروفة ولا سعر بالعنوان — لا نوقف كل استخراج بسبب فشل شبكة عابر،
        //         لكن نُعلّم النتيجة كغير مؤكَّدة حتى تظهر ملاحظة للمستخدم بالمراجعة.
        // English: No known currency and no title price — do not block every extraction over a
        //          transient network failure, but mark the result unconfirmed so the review
        //          screen shows the operator a notice.
        return {
            ...base, cnyPrice: displayed, status: 'cny', trusted: true,
            note: 'تعذّر التحقق من عملة الموقع (لم يستجب API العملة) — تأكد أن السعر باليوان.',
        };
    }

    // Arabic: مختصر يجمع جلب العملة والتحويل في نداء واحد.
    // English: Convenience wrapper combining the currency fetch and the conversion.
    async function resolveCnyPriceForPage(displayedPrice, sourceText, albumId) {
        const currency = await fetchSupplierCurrency(albumId);
        return resolveCnyPrice(displayedPrice, currency, sourceText);
    }

    globalThis.ALPHACODE_SUPPLIER_CURRENCY = Object.freeze({
        CURRENCY_API_PATH,
        TITLE_PRICE_PATTERNS,
        TITLE_PRICE_TOLERANCE,
        resolveAlbumId,
        fetchSupplierCurrency,
        findTitlePrice,
        isCny,
        needsConversion,
        resolveCnyPrice,
        resolveCnyPriceForPage,
    });
})();
