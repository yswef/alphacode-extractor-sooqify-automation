// =========================================================
// AlphaCode Extractor - Page World Bridge
// Arabic: يقرأ بيانات React ويلتقط ردود الشبكة للوصول إلى معرض الصور الكامل.
// English: Reads React data and captures network payloads to recover full galleries.
// =========================================================

(() => {
    'use strict';

    if (window.__ALPHACODE_PAGE_BRIDGE_INSTALLED__) return;
    window.__ALPHACODE_PAGE_BRIDGE_INSTALLED__ = true;

    const MAILBOX_ID = 'alphacode-bridge-mailbox';
    const MAX_CAPTURED_PAYLOADS = 80;
    const MAX_CAPTURE_TEXT = 4 * 1024 * 1024;
    const capturedPayloads = [];

    // Arabic: نفس منطق تلوين الـConsole المستخدم في content.js، لكن مستقل لأن page_bridge.js
    //         يعمل في عالم (MAIN world) منفصل ولا يستطيع الوصول لدوال content.js مباشرة.
    // English: Same console-colouring logic used in content.js, kept standalone because
    //          page_bridge.js runs in the isolated MAIN world and can't reach content.js's helpers.
    const BRIDGE_STYLES = {
        debug: 'background:#4c1d95;color:#d8b4fe;font-weight:bold;padding:2px 6px;border-radius:3px',
        warn:  'background:#78350f;color:#fcd34d;font-weight:bold;padding:2px 6px;border-radius:3px',
        error: 'background:#7f1d1d;color:#fca5a5;font-weight:bold;padding:2px 6px;border-radius:3px',
    };
    const BRIDGE_ICONS = { debug: '🔎', warn: '⚠️', error: '❌' };
    const bridgeLog = (level, ...args) => {
        console.log(`%c${BRIDGE_ICONS[level] || '🧩'} AlphaCode·Bridge · ${level.toUpperCase()}`, BRIDGE_STYLES[level] || BRIDGE_STYLES.debug, ...args);
    };

    const IMAGE_URL_RE = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>\\]*)?/gi;

    function normalizeEscapedText(value) {
        return String(value || '')
            .replace(/\\u002f/gi, '/')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/\\u0026/gi, '&');
    }

    function normalizeImageUrl(value) {
        let url = normalizeEscapedText(value).trim();
        url = url.replace(/[),;]+$/g, '');
        if (!/^https?:\/\//i.test(url)) return '';
        if (!/\.(?:jpe?g|png|webp|gif|avif)(?:\?|$)/i.test(url)) return '';
        if (/(?:avatar|icon|logo|emoji|sprite|add_cart_default_cover)/i.test(url)) return '';
        return url;
    }

    function collectUrlsFromString(value, output) {
        const normalized = normalizeEscapedText(value);
        const matches = normalized.match(IMAGE_URL_RE) || [];
        for (const match of matches) {
            const url = normalizeImageUrl(match);
            if (url) output.add(url);
        }
    }

    function collectImageUrls(root, output, options = {}) {
        const maxDepth = Number(options.maxDepth || 10);
        const maxNodes = Number(options.maxNodes || 25000);
        const seen = new WeakSet();
        let visited = 0;

        function walk(value, depth) {
            if (visited >= maxNodes || depth > maxDepth || value == null) return;

            if (typeof value === 'string') {
                collectUrlsFromString(value, output);
                return;
            }

            if (typeof value !== 'object' && typeof value !== 'function') return;
            if (value === window || value === document || value instanceof Node) return;
            if (seen.has(value)) return;
            seen.add(value);
            visited += 1;

            if (Array.isArray(value)) {
                for (const item of value) walk(item, depth + 1);
                return;
            }

            let keys;
            try {
                keys = Object.keys(value);
            } catch (_) {
                return;
            }

            for (const key of keys) {
                if (/^(?:ownerDocument|parentNode|parentElement|childNodes|children|stateNode|alternate|child|sibling)$/i.test(key)) {
                    continue;
                }
                let child;
                try {
                    child = value[key];
                } catch (_) {
                    continue;
                }
                walk(child, depth + 1);
            }
        }

        walk(root, 0);
    }

    function collectImagesNearMarkers(root, markers, visibleBasenames, output, diagnosticsOut) {
        const normalizedMarkers = markers
            .map(marker => String(marker || '').trim().toLowerCase())
            .filter(Boolean);
        const normalizedVisible = visibleBasenames
            .map(value => String(value || '').trim().toLowerCase())
            .filter(Boolean);

        if (!normalizedMarkers.length) {
            collectImageUrls(root, output, { maxDepth: 12, maxNodes: 30000 });
            return;
        }

        const candidates = [];
        const candidateSet = new WeakSet();
        const seen = new WeakSet();
        let visited = 0;
        const MAX_NODES = 30000;

        function addCandidate(value) {
            if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
            if (value === window || value === document || value instanceof Node) return;
            if (candidateSet.has(value)) return;
            candidateSet.add(value);
            candidates.push(value);
        }

        function walk(value, depth, ancestors) {
            if (visited >= MAX_NODES || depth > 13 || value == null) return;

            if (typeof value === 'string' || typeof value === 'number') {
                const text = normalizeEscapedText(value).toLowerCase();
                if (normalizedMarkers.some(marker => text.includes(marker))) {
                    for (let offset = 1; offset <= Math.min(6, ancestors.length); offset += 1) {
                        addCandidate(ancestors[ancestors.length - offset]);
                    }
                }
                return;
            }

            if (typeof value !== 'object' && typeof value !== 'function') return;
            if (value === window || value === document || value instanceof Node) return;
            if (seen.has(value)) return;
            seen.add(value);
            visited += 1;

            const nextAncestors = ancestors.concat(value);
            if (Array.isArray(value)) {
                for (const item of value) walk(item, depth + 1, nextAncestors);
                return;
            }

            let keys;
            try {
                keys = Object.keys(value);
            } catch (_) {
                return;
            }

            for (const key of keys) {
                if (/^(?:ownerDocument|parentNode|parentElement|childNodes|children|stateNode|alternate|child|sibling)$/i.test(key)) {
                    continue;
                }
                let child;
                try {
                    child = value[key];
                } catch (_) {
                    continue;
                }
                walk(child, depth + 1, nextAncestors);
            }
        }

        walk(root, 0, []);
        if (!candidates.length) return;

        const evaluated = [];
        for (const candidate of candidates) {
            const images = new Set();
            collectImageUrls(candidate, images, { maxDepth: 10, maxNodes: 18000 });
            if (!images.size) continue;

            const normalizedUrls = Array.from(images).map(url => normalizeImageUrl(url)).filter(Boolean);
            const visibleMatches = normalizedVisible.filter(base =>
                normalizedUrls.some(url => url.toLowerCase().includes(base))
            ).length;

            evaluated.push({ images: normalizedUrls, visibleMatches });
        }

        if (!evaluated.length) return;
        // Arabic: تراجعنا عن فلتر visibleMatches (كان يزيد المشكلة سوءاً حسب اختبار المشغّل
        //         الفعلي: نفس صورة البانر استمرت بالظهور + صور حقيقية انحذفت). رجعنا لدمج كل
        //         المرشحين (السلوك المعروف والآمن)، ونكتفي الآن بتسجيل تفاصيل كل مرشح
        //         بـ diagnosticsOut بدل التعديل على المنطق بناءً على تخمين تاني.
        // English: Reverted the visibleMatches>0 filter — confirmed by the operator's live
        //          test to make things worse (the same banner still got through AND real
        //          images were dropped). Back to merging every evaluated candidate (the known,
        //          safe baseline). We now only record per-candidate detail into diagnosticsOut
        //          instead of changing behavior based on another guess.
        evaluated.forEach((candidate, index) => {
            candidate.images.forEach(url => output.add(url));
            if (diagnosticsOut) {
                diagnosticsOut.push({
                    candidateIndex: index,
                    imageCount: candidate.images.length,
                    visibleMatches: candidate.visibleMatches,
                    sampleUrls: candidate.images.slice(0, 5),
                });
            }
        });
        bridgeLog('debug', `[ImageBridge] merged ${evaluated.length} candidate(s) → ${output.size} total image(s) so far.`);
    }

    function rememberPayload(payload, sourceUrl = '') {
        if (payload == null) return;
        capturedPayloads.push({ payload, sourceUrl, capturedAt: Date.now() });
        if (capturedPayloads.length > MAX_CAPTURED_PAYLOADS) capturedPayloads.shift();
    }

    function captureResponseText(text, sourceUrl = '') {
        if (!text || text.length > MAX_CAPTURE_TEXT) return;
        if (!/(?:xcimg\.szwego\.com|\.jpe?g|\.png|\.webp|\.avif)/i.test(text)) return;

        try {
            rememberPayload(JSON.parse(text), sourceUrl);
        } catch (_) {
            rememberPayload(text, sourceUrl);
        }
    }

    // Arabic: اعتراض fetch مع إعادة الاستجابة الأصلية دون تغيير.
    // English: Observe fetch responses without changing the original response.
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            try {
                const clone = response.clone();
                const sourceUrl = clone.url || String(args[0] || '');
                clone.text().then(text => captureResponseText(text, sourceUrl)).catch(() => {});
            } catch (_) {
                // Observation is optional; never interrupt the website.
            }
            return response;
        };
    }

    // Arabic: اعتراض XHR لالتقاط بيانات المنتجات التي تحمل معرض الصور الكامل.
    // English: Observe XHR responses that may contain the complete product gallery.
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__alphaCodeUrl = String(url || '');
        return originalXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
            try {
                if (this.responseType === 'json' && this.response) {
                    rememberPayload(this.response, this.__alphaCodeUrl || '');
                } else if (!this.responseType || this.responseType === 'text') {
                    captureResponseText(this.responseText || '', this.__alphaCodeUrl || '');
                }
            } catch (_) {
                // Observation is optional; never interrupt the website.
            }
        }, { once: true });
        return originalXhrSend.apply(this, args);
    };

    function collectDomUrls(target, output) {
        if (!target) return;
        target.querySelectorAll('img, a, source, video, [style]').forEach(element => {
            for (const directValue of [element.currentSrc, element.src, element.href]) {
                if (directValue) collectUrlsFromString(directValue, output);
            }
            for (const attribute of ['src', 'href', 'data-src', 'data-original', 'data-lazy-src', 'srcset']) {
                const value = element.getAttribute && element.getAttribute(attribute);
                if (value) collectUrlsFromString(value, output);
            }
            const style = element.getAttribute && element.getAttribute('style');
            if (style) collectUrlsFromString(style, output);
        });
        collectUrlsFromString(target.outerHTML || '', output);
    }

    function collectReactUrls(target, markers, visibleBasenames, output, diagnosticsOut) {
        if (!target) return;

        const candidateNodes = [
            target,
            target.querySelector('.wsxc_download'),
            target.querySelector('img'),
            target.firstElementChild
        ].filter(Boolean);

        for (const node of candidateNodes) {
            let keys;
            try {
                keys = Object.keys(node);
            } catch (_) {
                continue;
            }

            for (const key of keys) {
                if (key.startsWith('__reactProps$')) {
                    const props = node[key];
                    collectImagesNearMarkers(props, markers, visibleBasenames, output, diagnosticsOut);
                }

                if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
                    let fiber = node[key];
                    for (let level = 0; fiber && level < 12; level += 1) {
                        for (const candidate of [fiber.memoizedProps, fiber.pendingProps, fiber.memoizedState]) {
                            if (candidate) collectImagesNearMarkers(candidate, markers, visibleBasenames, output, diagnosticsOut);
                        }
                        fiber = fiber.return;
                    }
                }
            }
        }
    }

    function collectCapturedUrls(markers, visibleBasenames, output, diagnosticsOut) {
        // Arabic: يجمع الصور من الاستجابات المخزّنة بشرط أن يوجد marker واحد على الأقل
        //         (searchCode أو styleCode أو صورة ظاهرة) - بدون ذلك الشرط ستُجمع صور
        //         كل المنتجات في الصفحة معاً. الفلترة الفعلية تحصل داخل
        //         collectImagesNearMarkers التي تبحث عن صور قريبة من الmarkers فقط.
        //         حُذف فلتر sourceUrl لأنه كان يمنع استجابات صحيحة كثيرة.
        // English: Collects images from cached payloads only when at least one marker
        //          exists (searchCode/styleCode/visible image). Without this guard all
        //          products on the page would be merged into one. Actual narrowing happens
        //          inside collectImagesNearMarkers which only picks images near a marker.
        //          The sourceUrl pre-filter was removed because it blocked too many valid responses.
        const normalizedMarkers = markers
            .map(m => String(m || '').trim().toLowerCase())
            .filter(Boolean);
        if (!normalizedMarkers.length) return;

        for (let index = capturedPayloads.length - 1; index >= 0; index -= 1) {
            const entry = capturedPayloads[index];
            collectImagesNearMarkers(entry.payload, markers, visibleBasenames, output, diagnosticsOut);
        }
    }

    function respondToInspection() {
        const mailbox = document.getElementById(MAILBOX_ID);
        if (!mailbox) return;

        let request;
        try {
            request = JSON.parse(mailbox.getAttribute('data-request') || '{}');
        } catch (_) {
            request = {};
        }

        const token = String(request.token || '');
        const target = token ? document.querySelector(`[data-alphacode-target="${token}"]`) : null;
        const visibleBasenames = Array.isArray(request.visibleBasenames) ? request.visibleBasenames : [];
        const markers = [request.searchCode, request.styleCode, ...visibleBasenames]
            .map(value => String(value || '').trim())
            .filter(Boolean);

        // Arabic: تشخيص مؤقت - نجمع من كل مصدر بشكل منفصل (بدون تغيير النتيجة النهائية) عشان
        //         نعرف بالضبط أي مصدر (DOM / React / استجابات شبكة سابقة) يجيب صور من منتج
        //         مختلف، حتى لو searchCode/styleCode موجودين فعلاً.
        // English: Temporary diagnostic - we collect from each source separately (without
        //          changing the final result) to identify exactly which source (DOM / React
        //          / previously-captured network responses) is pulling in images from a
        //          different product, even when searchCode/styleCode are present.
        const domUrls = new Set();
        collectDomUrls(target, domUrls);

        const reactDiagnostics = [];
        const reactUrls = new Set();
        collectReactUrls(target, markers, visibleBasenames, reactUrls, reactDiagnostics);

        const capturedDiagnostics = [];
        const capturedUrls = new Set();
        collectCapturedUrls(markers, visibleBasenames, capturedUrls, capturedDiagnostics);

        bridgeLog('debug', '[ImageBridge] markers used:', markers, {
            searchCode: request.searchCode, styleCode: request.styleCode, visibleBasenames,
        });
        bridgeLog('debug', '[ImageBridge] DOM source found:', domUrls.size, Array.from(domUrls));
        bridgeLog('debug', '[ImageBridge] React-state source found:', reactUrls.size, Array.from(reactUrls));
        bridgeLog('debug', '[ImageBridge] Captured-network source found:', capturedUrls.size, Array.from(capturedUrls),
            `(searched ${capturedPayloads.length} payloads, skipped those with unmatched sourceUrl)`
        );

        const urls = new Set([...domUrls, ...reactUrls, ...capturedUrls]);

        // Arabic: تقرير تشخيصي كامل - يُرسل تلقائياً لسجل Python (alphacode.log) عبر content.js،
        //         بدون أي حاجة لفتح DevTools يدوياً. يوضح بالضبط أي مصدر (DOM/React/شبكة) جاب
        //         كل صورة، وكم مرشح داخل React/الشبكة اجتاز فلتر العلامة، وكم صورة/تطابق ظاهر
        //         عند كل مرشح - عشان نحدد سبب التلوث أو النقص بدقة بدل التخمين.
        // English: Full diagnostic report - automatically sent to the Python log
        //          (alphacode.log) via content.js, no manual DevTools needed. Shows exactly
        //          which source (DOM/React/network) contributed each image, how many
        //          React/network candidates passed the marker filter, and how many
        //          images/visible-matches each candidate had - to pin down contamination or
        //          under-capture precisely instead of guessing.
        const diagnostics = {
            markersUsed: markers,
            searchCode: request.searchCode || '',
            styleCode: request.styleCode || '',
            visibleBasenames,
            sources: {
                dom: { count: domUrls.size, urls: Array.from(domUrls) },
                react: {
                    count: reactUrls.size,
                    urls: Array.from(reactUrls),
                    candidates: reactDiagnostics,
                },
                captured: {
                    count: capturedUrls.size,
                    urls: Array.from(capturedUrls),
                    candidates: capturedDiagnostics,
                    totalPayloadsBuffered: capturedPayloads.length,
                },
            },
            mergedTotal: urls.size,
        };

        const response = {
            token,
            images: Array.from(urls).map(normalizeImageUrl).filter(Boolean),
            capturedPayloadCount: capturedPayloads.length,
            diagnostics,
        };

        mailbox.setAttribute('data-response', JSON.stringify(response));
        window.dispatchEvent(new Event('alphacode-bridge-response'));
    }

    window.addEventListener('alphacode-bridge-request', respondToInspection);
    window.dispatchEvent(new Event('alphacode-bridge-ready'));
})();