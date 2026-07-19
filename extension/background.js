// =========================================================
// AlphaCode Extractor - Background Service Worker
// Arabic: يجلب الصور المحلية ويرسل سجلات الواجهة إلى ملف Python الخارجي.
// English: Fetches local images and forwards UI logs to the external Python log.
// =========================================================

'use strict';

const LOCAL_API_BASE = 'http://127.0.0.1:5000';

// Arabic: تحويل Uint8Array إلى Base64 على دفعات لتجنب تجاوز مكدس الاستدعاء.
// English: Convert bytes to Base64 in chunks to avoid call-stack overflow.
function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
}

// Arabic: جلب صورة محلية وإعادتها إلى content script بصيغة Base64.
// English: Fetch a local image and return it to the content script as Base64.
async function fetchLocalFile(message) {
    const response = await fetch(message.url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
        success: true,
        base64: bytesToBase64(bytes),
        mimeType: response.headers.get('content-type') || 'image/jpeg',
        fileName: message.fileName || 'product.jpg'
    };
}

// Arabic: إرسال حدث الواجهة إلى سجل Flask الخارجي دون تعطيل الأداة عند فشل الخادم.
// English: Send a UI event to the Flask external log without breaking the extension if unavailable.
async function forwardClientLog(message) {
    const response = await fetch(`${LOCAL_API_BASE}/api/log/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.payload || {})
    });
    if (!response.ok) throw new Error(`Log request failed (${response.status})`);
    return { success: true };
}


// Arabic: فتح رابط في تبويب جديد من service worker لتجنب حظر النوافذ المنبثقة.
// English: Open a URL in a new tab from the service worker to avoid popup blocking.
async function openExtensionTab(message) {
    if (!message.url) throw new Error('A URL is required.');
    const tab = await chrome.tabs.create({ url: message.url, active: true });
    return { success: true, tabId: tab.id };
}

// Arabic: توجيه رسائل الإضافة إلى الوظيفة المناسبة.
// English: Route extension messages to the proper background action.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.action) return false;

    (async () => {
        try {
            if (message.action === 'FETCH_LOCAL_FILE') {
                sendResponse(await fetchLocalFile(message));
                return;
            }
            if (message.action === 'LOG_CLIENT_EVENT') {
                sendResponse(await forwardClientLog(message));
                return;
            }
            if (message.action === 'OPEN_TAB') {
                sendResponse(await openExtensionTab(message));
                return;
            }
            sendResponse({ success: false, error: `Unknown action: ${message.action}` });
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    })();

    return true;
});
