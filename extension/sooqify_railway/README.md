# Sooqify Audit v6 — isolated Railway companion

This directory is the v6 companion service. It is designed to be copied into its own repository and deployed on Railway; it does not replace, move, or modify the existing `backend/` or live PHP sync service. Its AlphaCode integration reads the shared archive only. New v6 APIs and workers live in this folder.

## Read-only Sooqify list collection

An operator signs in to Sooqify normally and solves any CAPTCHA manually. On `/admin/item/list`, the browser companion requests paginated list pages only. It extracts the Sooqify Store ID from visible row action-link URLs; it does **not** request view/detail routes, open edit pages, submit forms, or call a store delete route. A field absent from the list is marked unavailable, never inferred. In particular, an absent image-count column is `null`, not zero.

The collector sends sanitized list records over HTTPS. It does not send Sooqify passwords, CAPTCHA answers, browser cookies/session tokens, or product-image URLs. A snapshot is promoted only after all declared pages arrive and Store IDs are unique. An interrupted scan, login redirect, unexpected page, duplicate page, uncertain pagination end, or upload failure cannot replace the last complete snapshot.

Set the Railway service origin and `AUDIT_API_TOKEN` in the collector card in Chrome. The token is stored in that extension profile's local Chrome storage. Existing pricing-baseline uploads remain queued locally and retry when the service is configured and reachable.

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

1. Deploy with the included `Procfile` (`python run_service.py`). The Nixpacks build must install Python requirements and Node dependencies from `requirements.txt` and `package.json`.
2. Mount a Railway Volume at `/data`. It stores snapshots, reports, durable message/archive queues, backups, the delete audit log, and linked-device credentials. Treat the volume as sensitive; backups and audit records are retained until manually managed.
3. Set private Railway variables (do not commit values):
   - `AUDIT_API_TOKEN` — strong random bearer secret (at least 32 random characters); used by the extension, dashboard API and worker.
   - `ALPHACODE_SYNC_URL` and `ALPHACODE_SYNC_TOKEN` — the existing shared archive read connection.
   - `DATA_DIR=/data`
   - `APP_TIMEZONE=Asia/Aden`
   - `ENABLE_SCHEDULER=true`
   - `WHATSAPP_ENABLED=false` initially; enable only after service and number are checked.
   - `WHATSAPP_PRIMARY_NUMBER` — authorized WhatsApp account in international digits, with no `+`, spaces or punctuation.
   - `AUDIT_SERVICE_URL=https://<this-service>.up.railway.app` — the public HTTPS origin for the Node worker to call this service.
4. Keep **one Railway replica** and the included single Gunicorn web worker while the scheduler is active. The wrapper supervises the optional Node worker in the same container so both use the same `/data` volume.
5. Load/reload the Chrome extension from `extension/`, open a Sooqify list page, configure the Railway origin and bearer token, and run a complete list scan.
6. Visit `/dashboard` over HTTPS, enter the bearer token, verify the configured WhatsApp number, enable `WHATSAPP_ENABLED=true`, and rescan the pairing QR in WhatsApp → Linked devices. If the account logs out, pair again. Never send the QR, API token, or linked-device files to anyone.

For local development, use Python 3.10+ and Node 20+, install `requirements.txt` and `package.json` dependencies, set the environment variables, and run `python run_service.py`. Tests: `python -m pytest -q`; JavaScript syntax checks: `node --check whatsapp_worker/index.js` and `node --check extension/sooqify_railway/extension/service_worker.js`.

## API outline

All `/api/*` routes require `Authorization: Bearer $AUDIT_API_TOKEN`.

- `GET /healthz` — public health/configuration-presence flags only.
- `POST /api/pricing-baselines` — store price formula inputs received after extraction; does not write to the local backend.
- `POST /api/audit/scans/start`, `/pages/{page}`, `/complete` — upload and promote complete list-only scans.
- `GET /api/audit/latest` — latest snapshot metadata.
- `POST /api/reports/generate` — generate CSV, employee CSV and XLSX.
- `GET /api/reports/latest.csv`, `/api/reports/latest.employees.csv`, `/api/reports/latest.xlsx` — download latest files.
- `GET /api/whatsapp/state` and `/api/whatsapp/qr.svg` — authenticated dashboard status and temporary pairing QR.
- `/api/whatsapp/worker/*` — authenticated worker queue, status, report attachment and archive-job endpoints.

The existing AlphaCode sync endpoint is used only for read-only snapshots by the report/command service. The Chrome extension's pre-existing local archive routes are used only after a WhatsApp preview and explicit confirmation; `backend/` and production PHP are unchanged.
