# Sooqify Audit v6 — isolated Railway companion

This directory is the v6 companion service. It is designed to be copied into its own repository and deployed on Railway; it does not replace, move, or modify the existing `backend/` or live PHP sync service. Its AlphaCode integration reads the shared archive only. New v6 APIs and workers live in this folder.

## Server-side Sooqify browser and list scan

The audit scan now runs on Railway, not in the local Chrome extension. The included Dockerfile installs headed Chromium and Xvfb; `REMOTE_BROWSER_ENABLED=true` starts the opt-in remote-browser controls in `/dashboard`. The operator opens the browser through the dashboard, signs in there, and solves any CAPTCHA **manually** using the compressed remote view and mouse/keyboard controls. The browser profile is created directly on Railway at `/data/sooqify_browser/profile`; no local browser cookies, profile, or session files are uploaded or copied.

After login, click **Open product list / verify**, then **Start list scan on Railway**. The server requests paginated `/admin/item/list?page=N` pages only. Product row links are read to extract Store IDs, never followed. Requests and top-level navigation to product view, edit, and delete routes are blocked. A field absent from the list is unavailable, never inferred; an absent image-count column remains `null`, not zero. Product images/media/fonts are blocked during the scan.

Pages are stored under the same Railway partial-scan area and promoted to `/data/latest_complete_scan.json` only after pagination ends safely and Store IDs are unique. An interrupted, cancelled, stale-login, duplicate-ID, or uncertain-pagination scan cannot replace the previous complete snapshot. On success or failure, a completion notice is queued to `WHATSAPP_PRIMARY_NUMBER` when WhatsApp is enabled.

The remote screen and input API are protected by `AUDIT_API_TOKEN`, as are the other `/api/*` routes. The live view is opt-in and refreshes a compressed JPEG every three seconds only while enabled; screenshots and control events still use the operator's internet connection. Sooqify page requests and scan uploads originate from Railway. The remote browser may use Railway egress and memory while open; close it when finished. The session profile remains on the persistent `/data` Volume for the next visit.

This server-side scan writes the same Railway audit snapshot used by reports. It does **not** write to the existing PHP `sync.php`/shared AlphaCode archive; that integration remains read-only. Legacy extension upload endpoints remain for compatibility, but the remote scan does not require the Chrome scanner.

## Matching, audit and reports

- Store ID and AlphaCode Local ID are separate fields. Matching uses only observed identifiers and unique exact fallbacks; ambiguous links are not guessed.
- A submitted archive record is marked missing only when it has a known Store ID absent from a complete list snapshot. Otherwise, the report marks it unresolved/unverified as appropriate.
- Name, price, brand and image count are compared only when the list actually exposes those values.
- `POST /api/reports/generate` creates a details CSV, an employee-summary CSV and a multi-sheet XLSX (Summary, Details, By Employee). Employee totals are keyed from archive `added_by` values.
- When `ENABLE_SCHEDULER=true`, a daily report is generated at **21:00 `Asia/Aden`**. If WhatsApp is enabled, its three files are queued for delivery. A disconnected worker leaves the report in the durable outbox for retry.
- A report is refused if the shared archive cannot be read or there is no complete Sooqify list snapshot. A stale snapshot is identified in the report rather than silently described as current.

## WhatsApp linked device and commands

A separate Node.js worker in `whatsapp_worker/` uses Baileys `6.7.24` (Node 20+) and a linked device. The pairing QR is held temporarily in service memory and rendered on `/dashboard`; it is not written to disk or application logs. The linked account must match `WHATSAPP_PRIMARY_NUMBER` exactly. Incoming commands from all other numbers and groups are ignored.

Supported direct messages:

- `HELP` — command list.
- `STATUS` — connection and latest complete scan.
- `REPORT` — generate and queue detail CSV, employee CSV and XLSX.
- `DELETE <LocalID>` — read-only lookup of one exact Local ID and a 15-minute confirmation preview; no deletion occurs yet.
- `CONFIRM DELETE <CODE>` — explicitly confirm that one local archive record. The Railway Volume stores a pre-delete shared-record copy; an updated Chrome extension then backs up its local record before using the existing local archive delete route with `delete_images=false`.
- `CANCEL <CODE>` — cancel an unexecuted preview.
- `RESTORE <BackupID>` — ask an updated Chrome extension to run the existing full archive reconcile and verify the record reappeared before removing the deletion tombstone.

**Deletion boundary:** these commands never delete a product from Sooqify and never delete its local image folder. A confirmed Local ID tombstone is distributed to updated extension clients configured for this Railway service; they suppress that local record again if sync brings it back. This does **not** delete the source record from the shared PHP archive or alter PHP. Consequently, `RESTORE` depends on the source archive still containing the product. The stored backup and append-only event log are retained on the Railway Volume for evidence, but the companion deliberately has no direct write path to the existing backend/PHP service. If the shared source no longer has that record, restore must be handled by an operator through the existing system; the companion will not invent or push a replacement. Do not interpret local tombstoning as a global source deletion.

There is no bulk-delete command. A product name or brand is never used as a deletion selector, and there is no Cartier or Sooqify product-deletion action in this service.

## Railway deployment

Copy this directory's contents into a separate repository and set the Railway service root to that repository root.

1. Deploy from the repository root; Railway uses the included `Dockerfile` (Python, Node 22, Playwright Chromium, and Xvfb). Do not force the Nixpacks builder for the remote browser.
2. Mount a Railway Volume at `/data` before enabling the browser. It stores the complete scan, reports, queues, backups, WhatsApp linked-device credentials, and the new Sooqify Chromium profile. Treat this Volume as sensitive.
3. Set private Railway variables (never commit actual values):
   - `AUDIT_API_TOKEN` — strong random bearer secret, at least 32 random characters; protects the dashboard, remote screenshot/input, APIs, and worker.
   - `ALPHACODE_SYNC_URL` and `ALPHACODE_SYNC_TOKEN` — the existing PHP sync endpoint/read token. This companion only reads that archive.
   - `DATA_DIR=/data`, `APP_TIMEZONE=Asia/Aden`, `LOG_LEVEL=INFO`.
   - `REMOTE_BROWSER_ENABLED=true` — opt in to Chromium/Xvfb after the Volume and Docker deployment are ready. Keep false to leave the browser stopped.
   - `REMOTE_BROWSER_DISPLAY=:99` — Xvfb display used by the headed browser.
   - `ENABLE_SCHEDULER=false` during setup; enable after a full scan and report test.
   - `WHATSAPP_ENABLED=false` during setup. Later configure the authorized number in international digits without `+`, spaces, or punctuation, set `AUDIT_SERVICE_URL=https://<this-service>.up.railway.app`, and enable WhatsApp.
4. Keep **one Railway replica**. The service runs one Gunicorn web worker, one optional Playwright browser context, the Xvfb display, and the optional WhatsApp worker against the same `/data` Volume. Plan for the additional memory and image size required by Chromium.
5. Visit `/dashboard` over HTTPS, enter the bearer token, start the remote browser, and sign in manually. Solve CAPTCHA yourself; then verify/open the list and start the server-side scan. The authenticated session remains in `/data/sooqify_browser/profile` and is never copied from your device.
6. After a complete scan, generate a report to test the read-only PHP archive connection. Then, if desired, enable the scheduler and WhatsApp. WhatsApp receives a queued completion/failure message for server-side scans; pair the configured phone via WhatsApp → Linked devices. Never share the QR, API token, or Volume files.

For local development, use Python 3.10+, Node 20+, Chromium, and Xvfb; install `requirements.txt` and `package.json` dependencies, set `DISPLAY`, and run `python run_service.py`. Tests: `python -m pytest -q`; JavaScript syntax checks: `node --check whatsapp_worker/index.js` and `node --check extension/sooqify_railway/extension/service_worker.js`.

## API outline

All `/api/*` routes require `Authorization: Bearer $AUDIT_API_TOKEN`.

- `GET /healthz` — public health/configuration-presence flags only.
- `POST /api/pricing-baselines` — store price formula inputs received after extraction; does not write to the local backend.
- `POST /api/audit/scans/start`, `/pages/{page}`, `/complete` — upload and promote complete list-only scans.
- `GET /api/audit/latest` — latest snapshot metadata.
- `POST /api/reports/generate` — generate CSV, employee CSV and XLSX.
- `GET /api/reports/latest.csv`, `/api/reports/latest.employees.csv`, `/api/reports/latest.xlsx` — download latest files.
- `/api/remote-browser/*` — authenticated server-side Chromium status, start/close, compressed screenshot, constrained pointer/keyboard input, and list-scan start/cancel.
- `GET /api/whatsapp/state` and `/api/whatsapp/qr.svg` — authenticated dashboard status and temporary pairing QR.
- `/api/whatsapp/worker/*` — authenticated worker queue, status, report attachment and archive-job endpoints.

The existing AlphaCode sync endpoint is used only for read-only snapshots by the report/command service. Server-side Sooqify results go to the same Railway audit snapshot used by the previous collector; they are not written back to PHP. Existing local archive routes are unchanged; `backend/` and production PHP are unchanged.
