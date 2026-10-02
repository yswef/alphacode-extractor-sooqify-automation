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

## Inspect and import the live store list

1. Open Sooqify Admin → **العلامات التجارية** while logged in.
2. Open DevTools → Console, paste the contents of [`../../tools/sooqify_brand_page_probe.js`](../../tools/sooqify_brand_page_probe.js), and run `__alphaSooqifyBrandProbe.copy()`.
3. The probe is read-only: it does not click or submit forms. It copies the visible `{id, name}` rows and safe form metadata. It redacts token/password/CSRF/cookie fields. If you need to inspect the add-brand request, install the probe **before** manually submitting a brand you actually intend to add; it logs only brand-related requests.
4. In the extension's **البراندات والمقاسات** card, paste the copied JSON into “بيانات العلامات من فاحص الصفحة” and click “مزامنة قائمة البراندات مع الجهازين”. Review the confirmation carefully. The Python API canonicalizes common Arabic brand transliterations to the English names used by the extension, while preserving the Sooqify IDs.
5. Both machines read the same map from the shared sync endpoint. The product upload backend also refreshes that shared map and refuses an upload if the map cannot be read or the selected name has no valid ID; it does not silently fall back to the old numeric ID.

A screenshot-derived reference snapshot (not an authoritative import; re-run the probe before applying) is at [`../../docs/brand-sync/sooqify_brands_2026-10-02.json`](../../docs/brand-sync/sooqify_brands_2026-10-02.json).

## Deployment/security

- Set `ALPHACODE_SYNC_TOKEN` in the PHP-FPM/server environment, or load it from a private PHP config file outside the web root. Never commit it.
- The sync token included in the pasted endpoint source was exposed in chat. Treat it as compromised: rotate it on the endpoint and update the sync settings on **all** operator devices before continuing.
- Do not upload this reference as a replacement until you compare it with the live `sync.php`, `db.php`, `sync_write_helpers.php`, and database schema. Keep those deployment dependencies backed up.
- PHP CLI is not available in this development environment, so `php -l` could not be run here. The PHP reference needs syntax validation on a PHP host before deployment.
