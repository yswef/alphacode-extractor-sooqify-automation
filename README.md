# AlphaCode Extractor v5.8 — Sooqify Batch Automation

> Private Chrome Extension and Flask backend for extracting supplier products, optimizing images, and submitting products to Sooqify/6amMart individually or as a controlled batch — with optional two-user sync for teams sharing one store. Product copy is written by the operator; there is no AI generation.

## Main capabilities

- Extract product name, Style Code, Search Code, sizes, price, and full image gallery from SZWEGO.
- Download, resize, compress, and archive product images locally.
- Submit only the selected main image to Sooqify by default while keeping the full gallery saved locally at full, untouched quality.
- Organize saved images per brand and per day (`<images root>/<Brand>/<YYYY-MM-DD>/<product>`), each with a `product_info.txt` reference file.
- Send only the selected main image to Sooqify; the remaining gallery stays local on the operator device unless the toggle is turned off.
- Fill category, subcategory, brand, unit, price, stock, sizes, variants, translations, and images.
- Add one product manually or select several products and run a persistent batch queue.
- Notify the operating system after each submitted product and after batch completion.
- Optionally sync two machines working on the same store, preventing duplicate product IDs and duplicate product additions.
- Detect and repair older products missing newer fields via the **إصلاح البيانات** (Data Repair) tab, with operator-approved defaults, an automatic backup before any write, and downloadable error/extra-field reports.
- Automatically back off for a cooldown period when the sync host returns HTTP 403 (rate-limit/anti-flood block), instead of hammering it with more requests.
- Enter product names and descriptions by hand, or paste a JSON template - the AI feature was removed entirely, and the fields start empty rather than pre-filled with generated text.
- Pick the product type automatically from the configured default brand (choosing Rolex selects watches).
- Find the backend port automatically, so a fallback to 5001 when 5000 is busy no longer breaks sync.
- Exclude individual images from download to cut bandwidth, and download only the selected images by default.
- Recover the **true CNY price** when the supplier displays a foreign currency: szwego picks the currency from the request IP, so a VPN can render a 300 CNY watch as "Ұ7077.3" (JPY). The extension reads the exchange rate the site itself publishes and converts back exactly, refusing to continue on an unconfirmed conversion.
- Throttle supplier requests adaptively, detecting the site's *silent* rate-limiting (HTTP 200 with an empty product list) and backing off instead of hammering a wall.
- Verify the Sooqify admin session **before** extraction starts, rather than failing late after all the work is done.
- Configure and test sync directly on the login screen, since login itself runs through the sync server.
- Build PDF reports over **any** set of dates: one day, a whole month, hand-picked scattered days, or a custom from-to range that may cross months.
- Self-heal the archive with an automatic periodic full reconcile, so the incremental pull can no longer silently lose records.

## Batch workflow

1. Open a SZWEGO product-list page.
2. Select two or more products using **تحديد للدفعة**.
3. Click **مراجعة وإضافة** in the fixed AlphaCode toolbar.
4. Review each product using the previous/next slides.
5. Edit English/Arabic content, brand, price, and sizes as needed.
6. Start the batch.
7. AlphaCode prepares products with limited concurrency and submits them to Sooqify one at a time.
8. Use the floating queue panel to pause, resume, cancel, or retry failed submissions.

The queue is saved in `chrome.storage.local`, so it can recover after a Chrome restart or service-worker suspension. Only one Sooqify submission tab is active at a time to reduce memory usage and prevent product data from mixing.

## Project structure

```text
backend/
  app.py                 Flask API, images, archive, Excel, logs, sync client, folder setup
  requirements.txt
extension/
  config.js              Shared defaults
  popup.css              Popup design system (linked stylesheet, dark mode aware)
  backend_discovery.js   Finds the live backend port instead of assuming 5000
  product_types.js       Single source of truth for every shoes/watches difference
  supplier_currency.js   Recovers the true CNY price from the supplier's IP-derived currency
  supplier_throttle.js   Adaptive back-off for supplier requests (detects silent rate-limiting)
  price_patterns.json    Extensible price-extraction patterns loaded at runtime
  content.js             Supplier extraction, review UI, batch preparation
  content.css
  background.js          Persistent sequential submission queue and notifications
  admin_autofill.js      Sooqify form adapter
  admin_autofill.css
  page_bridge.js         React/network gallery bridge
  popup.html
  popup.js
  manifest.json
  icons/
hostinger/
  alphacode_storage/
    sync.php               Central sync endpoint (MySQL edition — same API contract as before)
    db.php                 PDO connection helper (MySQL in production, SQLite for local tests)
    db_config.php           Database credentials (fill in on the host, never commit real values)
    sync_write_helpers.php Shared write/lock helpers used by sync.php
    migrate_json_to_mysql.php  One-time import from an old archive_shared.json/id_counter.json
    test_connection.php    Temporary connection debug tool — delete from the host after use
    check_db_health.php    Read-only diagnostic: connection, required tables/columns, orphan rows, product counts
docs/
  AlphaCode_Project_Documentation_AR.pdf
  AlphaCode_Project_Documentation_EN.pdf
```

`sync.php` (and the rest of the `hostinger/alphacode_storage/` files) do not live in the extension or backend folders because they are not run locally — they are uploaded once to a PHP-capable web host with a MySQL database and shared by every machine. Run `schema.sql` once, fill in `db_config.php`, and change `$SECRET_TOKEN` in `sync.php` before going live.

The backend also creates a few small runtime files next to `app.py` on first run — `paths_config.json`, `sync_config.json`, `sync_queue.json`, `sync_state.json`. These are machine-specific and should stay out of version control (add them to `.gitignore`).

## Requirements

- Windows 10/11.
- Python 3.10 or newer, with the standard `tkinter` component available (needed for the save-folder picker dialog).
- Chrome or Brave with Developer Mode enabled.
- An active Sooqify admin login in the same browser profile.
- A PHP-capable web host only if two-user sync is enabled (optional).

Install requirements:

```bat
INSTALL_REQUIREMENTS.bat
```

Start the backend:

```bat
START_ALPHACODE.bat
```

## Install the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder.
5. After every code update, click **Reload** and hard-refresh supplier/store pages with `Ctrl + Shift + R`.

## First-run setup: choose a save folder

As of v4.5.2 there is no default save path. On first launch, open the popup's **المزامنة والمجلد** tab and click **اختيار / تغيير مجلد الحفظ** to open a native folder picker and choose where product images, the archive, and the Excel file are stored. Product saving is blocked with a clear error until this is done. Each machine keeps its own independent choice — the two saved folders never need to match.

## Two-user sync (optional)

Lets two operators run AlphaCode on two separate machines against the same Sooqify store without colliding on product IDs or duplicating the same product.

1. Upload `hostinger/alphacode_storage/sync.php` to a PHP-capable web host (any shared hosting works, no extra setup needed).
2. Open the file on the host and change the `$SECRET_TOKEN` placeholder to a long random value. Keep it private between the two operators.
3. On **each** machine, open the popup's **المزامنة والمجلد** tab, enable **تفعيل المزامنة**, and enter the same server URL and secret token, plus a short operator name.
4. Save. From then on, new products are ID-reserved and duplicate-checked centrally before any image is downloaded, and every finished product is pushed to the shared archive automatically.

If the sync server is unreachable, AlphaCode keeps working locally: it falls back to local ID numbering (flagged as `local_fallback` in the diagnostics list) and queues the push for automatic retry once the connection returns. Sync only covers products added after it is enabled — products already in an existing local archive are not retroactively uploaded.

Every action on `sync.php`, including sign-in (`whoami`), requires the same secret token — so login is blocked upfront with a clear message ("أدخل كود المزامنة من تبويب الإعدادات أولاً") if the token field is empty, instead of failing later with a generic server rejection.

### Sync resilience & host rate-limiting

Shared hosts (Hostinger included) commonly rate-limit or briefly block a client that sends many requests in a short burst — this can happen the first time a device with a large local archive reconciles against the server, since every missing product is pushed one request at a time. To avoid that:

- A short pacing delay (`SYNC_REQUEST_PACING_SECONDS`, default `0.3s`) is applied between consecutive push requests during a full reconcile or a Data Repair apply, so a big batch never floods the host fast enough to trigger a block in the first place.
- If the host still responds with HTTP 403, AlphaCode stops calling it immediately, records a cooldown (`SYNC_THROTTLE_COOLDOWN_SECONDS`, default `300s` / 5 minutes) in `sync_state.json`, and shows a plain-language explanation in the sync status panel instead of retrying and extending the block. Normal syncing resumes automatically once the cooldown passes.

Both values are constants near the top of `backend/app.py` and can be tuned to match your host's specific rate-limit policy.

## Data repair tab (optional maintenance)

Older products saved before a field existed can be missing it entirely. The **إصلاح البيانات** tab in the popup:

1. Scans the local archive (and the server copy, when sync is enabled) against the full reference product shape.
2. Shows one input per missing field type, and reports extra/unexpected fields and errors (no `id`, duplicate `id`, a corrupted entry, or a real data conflict with the server copy) without changing anything yet.
3. After you fill in a default value per field and confirm, it fills that value **only** into the products actually missing it (never overwrites an existing value), takes an automatic timestamped backup of `archive_db.json` first, then pushes every changed product to the server.
4. A background check runs every 60 minutes and shows a browser notification only when the issue state changes since the last notice, so it never repeats the same alert every hour.
5. Two separate downloadable reports — errors and extra fields — are generated as `.xlsx` files inside the `reports/` folder.

## Important defaults

The main settings are in `extension/config.js` and are editable in the popup.

| Setting | Default | Purpose |
|---|---:|---|
| `AIModel` | `openai/gpt-oss-120b` | Final bilingual copy model |
| `BrandMapJson` | `{"Air Jordan":6}` | Allowed store brands and IDs |
| `StoreImageLimit` | `6` | One main + five gallery images |
| `UploadMainImageOnly` | `true` | Submit only the main image to Sooqify; save the full gallery locally untouched |
| `FastAutofillMode` | `true` | Uses short conditional waits |
| `AutoSubmitDelaySeconds` | `0` | Removes the countdown |
| `BatchModeEnabled` | `true` | Enables multi-product selection |
| `BatchPreparationConcurrency` | `1` | Low-resource preparation limit |
| `BatchMaximumProducts` | `25` | Maximum selected batch size |
| `BatchContinueOnFailure` | `true` | Continue after one product fails |
| `BatchNotifyEachProduct` | `true` | Desktop notification per product |
| `BatchMaxRetries` | `1` | One transient retry |
| `BatchDownloadSelectedImagesOnly` | `true` | Download only the six batch images |

Keep `BatchPreparationConcurrency` at `1` unless the supplier site tolerates more - the extension throttles itself when it detects rate limiting, but fewer parallel requests is gentler on it.

## AI behavior

### Normal generation

The first generation uses supplier evidence only and does not search the web.

### Official regeneration

When **official research** is requested, AlphaCode:

- resolves the official domain for the allowed brand;
- searches that domain only;
- performs one research request;
- sends a compact dossier to the final model;
- does not repeat the search during JSON repair;
- returns `retry_after_seconds` on HTTP 429 instead of retrying immediately.

Generated `brand_name` must exist in `BrandMapJson`; otherwise AlphaCode returns to the configured store brand.

## Local data paths

The save folder is chosen per machine from the popup (see **First-run setup** above) instead of being fixed in code. `ALPHACODE_ROOT_DIR` is only used as the suggested value the very first time, before any folder has been explicitly chosen.

Inside the chosen folder:

```text
archive_db.json
items_bulk_format_nodata.xlsx
ai_copy_cache.json
logs\alphacode.log
صور\<Brand>\<YYYY-MM-DD>\<product folder>\
    ...product images...
    product_info.txt
```

## Troubleshooting

### Backend unavailable

Open:

```text
http://127.0.0.1:5000/api/health
```

Then restart `START_ALPHACODE.bat` if needed.

### "No save folder is configured yet"

Open the popup's **المزامنة والمجلد** tab and click **اختيار / تغيير مجلد الحفظ**. If the native picker does not appear, confirm Python's `tkinter` component is installed (`python -c "import tkinter"` should run with no error) and check `logs\alphacode.log` for the exact subprocess error.

### Sync settings do not stick, or a toggle resets after reopening the popup

Reload the extension from `chrome://extensions` after any `extension/` file update — the popup can otherwise keep running its previous cached script.

### Rate limit

AlphaCode does not retry HTTP 429 automatically. Wait for the exact duration shown by the extension, then regenerate. Keep batch AI concurrency at `1`.

### Batch paused because of login

Sign in to Sooqify, return to the supplier page, and press **استكمال** in the queue panel.

### Extension changes not visible

Reload the extension and then use `Ctrl + Shift + R` on both SZWEGO and Sooqify pages.

### Sooqify field or image failure

Check:

```text
<your chosen folder>\logs\alphacode.log
```

Confirm Category ID, Subcategory ID, Brand ID, Unit ID, Size Attribute ID, and the current Sooqify session.

### "المزامنة مفعّلة لكن كود المزامنة فاضي" on login

Open the popup's **المزامنة والمجلد** tab, enter the secret token from `sync.php`, save, then try logging in again. The server rejects every request without it, including sign-in.

### Sync host returning 403 / connection blocked for a while

This is normally the shared host's own anti-flood protection reacting to a burst of requests (e.g., a large first-time reconcile). AlphaCode now backs off automatically for a few minutes and shows the reason in the sync status panel — no action needed beyond waiting. See **Sync resilience & host rate-limiting** above to tune the cooldown/pacing values.

### A price looks far too high (thousands of SAR for a cheap item)

The supplier site picks its displayed currency from your IP, so a VPN can make it show
Japanese yen while you assume Chinese yuan. AlphaCode now reads the exchange rate the site
publishes and converts back to CNY, showing a banner such as
`JPY ← 300 يوان (سعر صرف 23.591)`. If it cannot confirm the conversion it blocks the product
and asks for the price manually — enter the CNY price and tick the confirmation box.

### "الخادم يبطئ استجابته — جاري الانتظار N ثانية"

The supplier started rate-limiting. Its limiting is silent: the page returns HTTP 200 with a
valid page but an empty product list, so there is no error code to read. AlphaCode detects
that pattern, slows down automatically and retries. Just wait — it speeds back up on its own.
Practical guidance measured from a real incident: roughly 8 full product-list reloads within
two minutes was enough to trigger it, so keep list reloads well under ~4 per minute.

### A teammate's products are missing from reports

The incremental sync pull can skip records once its watermark moves past them. As of v5.8 a
full reconcile runs automatically every few hours to repair this, and you can force one
immediately from the sync tab. A real case: the server held 3,800 records while one machine
had 2,476 — an entire teammate's month of work was absent from every report while sync still
reported success.

### Search Code keeps coming back empty

`extension/content.js` logs each extraction stage to the browser Console under the `[AlphaCode][SearchCode]` prefix whenever it fails to find a value. Open DevTools Console on the SZWEGO product page, trigger the extraction, and check those log lines (they include the raw HTML/text AlphaCode looked at) to see exactly which stage — and which selector — is not matching the site's current markup.

## Documentation

- [Arabic project documentation](docs/AlphaCode_Project_Documentation_AR.pdf)
- [English project documentation](docs/AlphaCode_Project_Documentation_EN.pdf)
- [Changelog](CHANGELOG.md)
- [Per-change notes](docs/changes/) — one file per change, with the reason, the design and the tests
- [VPS migration plan](docs/planning/vps_migration_plan.md) — planning only, not yet implemented

The PDF documents describe the core architecture. `docs/changes/` is the authoritative record
of every behavioural change; the most recent are:

| Change | Summary |
|--------|---------|
| [Shoes/watches unification](docs/changes/2026-09-22_unify_shoes_watches_product_type_profiles.md) | One profile object replaces every scattered `if product_type == "watches"` branch |
| [Supplier currency recovery](docs/changes/2026-09-22_supplier_currency_cny_recovery.md) | Recovers the true CNY price from the site's own published exchange rate |
| [Reports, login sync, session gate, throttle](docs/changes/2026-09-22_reports_login_session_throttle.md) | Flexible report dates, sync on the login screen, store-session check, adaptive back-off |
| [Reversed names and the sync data gap](docs/changes/2026-09-22_report_names_and_sync_data_gap.md) | Fixes reversed Arabic names in PDFs and the silently lossy incremental sync |
| [AI removal, UI redesign, field fixes](docs/changes/2026-09-25_remove_ai_redesign_ui_and_field_fixes.md) | Removes AI entirely, redesigns the popup, fixes the brand field, backend port discovery and image bandwidth |

## License

This project is proprietary. See [LICENSE](LICENSE).