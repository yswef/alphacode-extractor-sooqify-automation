# Shared brand-ID sync reference

`sync.php.example` is the secret-free, versioned reference for the PHP endpoint the desktop app calls. The production endpoint is **not** deployed from this folder automatically. It depends on the private `db.php` and `sync_write_helpers.php` files already present on the hosting account; those dependencies and DB credentials must not be committed here.

## Why the brand IDs drifted

The extension's shared `brands` table is a mapping, not Sooqify's live database. Sooqify assigns the actual numeric IDs. If the mapping table contains old IDs, a product's `brand_id` points at the wrong store brand. Also, the old PHP `push` path resolved the SQL `brand_id` but serialized the old value into `payload_json`, so `/pull` could send a different ID to the other machine.

The reference endpoint fixes that contract:

- `GET ?action=brands` returns the shared map.
- `POST ?action=brands/sync` imports a reviewed `{ "brands": [{"id": 1, "name": "Air Jordan"}], "confirm_replace": true }` list from the store page. It validates duplicate IDs/names, uses a transaction, updates shared archive `brand_id` values by **brand name** where possible, and reports historical rows with names that no longer exist in the current map.
- `POST ?action=add_brand` and `POST ?action=brands/add` are both accepted for compatibility. The ID must be the actual ID shown by Sooqify; the central endpoint never invents it.
- `push` resolves the authoritative ID from the shared map by name and writes that resolved ID into both the SQL row and `payload_json` before `/pull` can replicate it.
- Replacing the map is refused if the sync database has a foreign key pointing at `brands`; review/migrate that schema rather than risking a cascade.

The import only changes the **shared sync database mapping/archive**. It does not connect to or rewrite Sooqify's live product table. Existing products in the shop must be audited separately if they were already submitted with an incorrect `brand_id`. Product primary IDs are never changed by this code.

## Display the live store brand IDs

The extension content script on `https://admin.sooqifyonline.com/admin/brand` reads each row's own edit/delete action URL and temporarily replaces the first-column row number with the actual brand ID. It runs automatically when the page opens; no DevTools paste is needed. This is a browser-only visual overlay: it sends no requests, submits no forms, and does not change Sooqify data. Reloading the page restores the server-rendered display.

The optional diagnostic at [`../../tools/sooqify_brand_page_probe.js`](../../tools/sooqify_brand_page_probe.js) can still copy a redacted JSON report for troubleshooting. Its `id` values come from row action URLs and the original first-column value is retained as `displayed_number`.

The popup no longer has a bulk “sync IDs from page” textarea/button. The visual overlay does not update the separate shared uploader mapping or alter existing products. The PHP `brands/sync` endpoint remains in the reference for server-side maintenance, but the popup's failed `/api/brands/sync` flow is not used. Diagnose the observed 502 response before re-enabling a bulk import workflow.

A row-verified snapshot from probe v2.1.0, authoritative for its capture time (2026-10-02), is at [`../../docs/brand-sync/sooqify_brands_2026-10-02.json`](../../docs/brand-sync/sooqify_brands_2026-10-02.json). Re-run the probe if the store list changes.

## Deployment/security

- Set `ALPHACODE_SYNC_TOKEN` in the PHP-FPM/server environment, or load it from a private PHP config file outside the web root. Never commit it.
- The sync token included in the pasted endpoint source was exposed in chat. Treat it as compromised: rotate it on the endpoint and update the sync settings on **all** operator devices before continuing.
- Do not upload this reference as a replacement until you compare it with the live `sync.php`, `db.php`, `sync_write_helpers.php`, and database schema. Keep those deployment dependencies backed up.
- PHP CLI is not available in this development environment, so `php -l` could not be run here. The PHP reference needs syntax validation on a PHP host before deployment.
