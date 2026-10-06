# Changelog — AlphaCode Extractor

## v5.10.0 — 2026-10-06

### Added

- **Admin danger zone: a complete backup, then the server data is erased and sync stops for good.**
  The **المزامنة والمجلد** tab now carries an admin-only card with a fixed, enforced order:
  1. *تنزيل نسخة احتياطية كاملة الآن* pulls **everything** from the server (no time filter) plus the
     brand list, adds this machine's whole `archive_db.json`, and writes one JSON file into
     `<save folder>/backups/` — offered as a download too, and it never contains the sync token.
  2. After typing `DELETE-SERVER` and confirming a second dialog, `sync.php` runs `action=erase`,
     which deletes every row of every table (products, members, aliases, brands, ID reservations) in
     one transaction and writes a `shutdown.lock` file on the host. From then on the endpoint answers
     `410 Gone` to everything, even from a machine still holding the old token.
  3. This machine locks itself: server URL and token wiped, retry queue emptied, and **no network
     request leaves for the sync server again** — `sync_call`, the background worker, the pull/push
     helpers and the retry flush all short-circuit on the lock.
  4. *استعادة النسخة إلى السيرفر* re-uploads a backup later to a new server (brands → products →
     `bump_sequence`) with polled progress, and it is the explicit `ConfirmUnlock` action that
     releases the lock — a plain settings save is rejected with HTTP 409 while locked.
- **Admin-only local login while locked, with an optional local guard.** After the shutdown, sign-in
  accepts only the local `admin` account; set the optional guard password and that login requires it
  too (salted SHA-256 hash only), so a member cannot revive their own extension copy with
  `admin/admin`. Members get a clear "sync is permanently stopped" refusal instead of a fake login.
- **٢‑ج — a server shutdown that works against the deployed old `sync.php` (no host access needed).**
  Because the old copy has no delete action, the card unifies instead: it replaces the brands table
  with one placeholder through `brands/sync` (a wholesale table replacement), then rewrites every
  product **in place** through `push` — same `id`, so the update is accepted instead of being refused
  as a duplicate, while name/description/style/search codes, price, images, sizes and variants are all
  wiped and the placeholder brand is attached. A `neutralized_by` marker makes a second run skip what
  is already done, `reserve_id` can advance the counter, and the machine locks itself like the erase
  path. The **same mandatory backup runs first** — no backup means no neutralizing, and a refused
  `brands/sync` aborts before a single product is touched. The plan endpoint shows every warning and a
  time estimate before anything is written, and the panel states plainly what this cannot do: members
  stay in the database so a valid account can still log in, and rows are overwritten rather than
  deleted (the DB-side `wipe_db.sql` remains the complete answer).
- **`hostinger/alphacode_storage/sync.php` is now tracked in Git** and gains `action=erase`,
  `action=bump_sequence` and the `shutdown.lock` gate, alongside the existing actions unchanged.
  `hostinger/alphacode_storage/README.md` documents the deployment, the safe order and how to revive
  the endpoint.

### Fixed

- **Losing access without a real erase is now impossible.** The backup is written to disk *before* any
  delete, and an unreachable server or a `sync.php` without `action=erase` cancels the whole operation
  and leaves the machine untouched (no lock, no cleared settings).
- **Restored IDs can no longer collide with new ones.** Erasing empties `id_sequence`, so a restore
  raises the counter above the highest restored product ID (`bump_sequence`) — otherwise the next new
  product would reuse an ID the store had already seen.
- The README's sync setup pointed at a `$SECRET_TOKEN` constant that no longer exists; it now describes
  the `ALPHACODE_SYNC_TOKEN` environment variable the endpoint actually reads.

### Added (follow-up: an old `sync.php` that cannot be updated)

- **The wipe kit, for the case where the deployed `sync.php` predates `action=erase` and the hosting
  panel is out of reach.** That copy cannot delete a single row (all its actions are reads or
  inserts/updates; the only delete is `brands/sync`, limited to the brands table), so the erase has to
  run database-side. The danger zone's new section **٢‑ب** prepares, in one click:
  - `alphacode_wipe_db.sql` - lists the tables, disables FK checks, deletes every row of every table
    in one transaction using the real `information_schema` table list, restarts the `id_sequence`
    counter (guarded, since `ALTER TABLE` is an implicit commit in MySQL), prints the remaining row
    count per table as proof, and documents a manual per-table fallback. Canonical copy:
    `backend/app/data/wipe_db.sql`, with a mirrored, drift-tested copy in
    `hostinger/alphacode_storage/wipe_db.sql`.
  - A ready support request (Arabic/English) filled with the tool URL and account hint: run the SQL
    (or drop the database), delete the tool's files, confirm with the numbers.
- **A real explanation instead of `Unknown action`.** When the erase is refused because the deployed
  script is old, the backend now names the cause, points to the wipe kit, and still cancels everything
  (no lock, no cleared credentials) so the machine stays usable.

### Notes

- Member accounts and passwords are **not** in the backup: `sync.php` has no read action for them and
  the backup file states that explicitly. Recreate them on the host after a re-upload.
- `backend/config/sync_lock.json`, `backend/data/restore_state.json`, `backend/backups/` and the host
  credential files are git-ignored (machine state and secrets, never code).

## v5.9.0 — 2026-10-02

### Fixed
- **Sync never ran on its own.** `sync_background_worker` was defined twice and started
  nowhere: a copy in `backend/app.py` explicitly documented as dead code, and a copy in
  `product_helpers.py` that called `sync_pull_updates` / `sync_flush_queue` / `time` without
  importing any of them (a `NameError` had it ever run). The real entry point,
  `backend/app/main.py`, never started either. So products added by one operator stayed
  invisible on the other machine until someone pressed **مزامنة الآن** by hand - the reason
  "sync isn't working". A single real loop now lives in `sync_service.py` and is started from
  the entry point: first cycle 20 s after launch, then every 30 minutes while the backend runs.
- **"Was this product added?" had no answer on screen.** The extension writes a real workflow
  status per product (`prepared → submit_started → submitted / submit_failed`), and
  `/api/archive/recent` already returned it - but the popup never rendered it. Each product now
  carries a colour-coded chip (✓ added / ⏳ submitting / ✗ failed / prepared only), with the
  failure reason when present.
- **Tests wrote into the developer's real settings.** The sync config/state/queue paths are
  constants derived from the `backend/` root and ignore `ALPHACODE_ROOT_DIR`, so a test that
  saved sync settings really replaced `backend/config/sync_config.json`. A new `conftest.py`
  redirects all three files to a temporary directory for every test.

### Added
- **Automatic sync every 30 minutes**, independent of the popup or the browser - it lives in
  the backend process. The interval is editable from the **المزامنة والمجلد** tab (5-1440
  minutes, default 30) and changes take effect without restarting the backend. A retry-queue
  flush runs every 5 minutes in between, so a failed push is not stuck for half an hour.
- **Sync status that answers the question**: a second stats row shows the next automatic run,
  how many products the last pull brought in (and how many came from the other operator), and
  whether the automatic worker is running - with a plain warning when it is not.
- **Archive summary and operator ranking** in the recent-products card: total, added, in
  progress, failed and prepared-only counts, plus how many products each teammate added.
- **"New products arrived" notification** - a `chrome.alarms` check every 10 minutes reports a
  batch of products added by the other operator exactly once, and falls back to triggering a
  sync itself if the backend worker is missing or overdue (older backend builds, unexpected
  stops). The backend keeps a dedicated timestamp for the last pull that actually carried such
  products, so an intervening empty pull can never swallow the notice.
- **The sync tab refreshes itself** every 20 seconds while open, so arrivals and submission
  outcomes appear without pressing anything.
- The "sync now" button and the automatic cycle now share one function, so both return and
  report the same result (including how many new products arrived).

### Removed
- The broken duplicate `sync_background_worker` in `product_helpers.py`, and the duplicated
  `if (tabName === 'sync')` branch in the popup's `activateTab`.

## v5.8.1 — 2026-09-25

### Removed
- **The AI feature, entirely.** Both `/api/ai/*` routes, every AI function in `ai_helpers.py`
  (renamed to `product_helpers.py` since nothing AI remained in it), `variant_extractor_service.py`,
  the AI settings tab, the AI health pill and all Groq configuration. −1,502 lines.
- **Generated fallback copy.** Name and description fields now start empty for manual entry.

### Fixed
- **The default brand field never reached the store.** `BrandName` is a hidden input updated
  only on a `change` event, but `populateForm()` sets `BrandId` programmatically, which fires
  none - so the dropdown showed the right brand while `BrandName` stayed empty. `BrandId` is
  now the single source of truth.
- **Sync broke whenever the backend fell back to another port.** The backend moves to 5001+
  when 5000 is busy while the extension hardcoded 5000, so every call failed silently. The
  extension now discovers the live port and verifies the service name before trusting it.
- **Every image of every product was always downloaded.** `download_selected_only` was ANDed
  with `not UploadMainImageOnly`, which has defaulted to on since v5.0.0 - so the
  "download selected only" option was dead code that could not be switched on from anywhere.
- **`popup.css` was never linked from `popup.html`**, so anything written in it never applied.

### Added
- **Product type follows the configured brand** - picking Rolex selects watches automatically,
  matching on whole words so "Rolexy" does not match "rolex".
- **Per-image exclude control** - excluded images are never fetched, with a counter showing how
  many will actually be downloaded.
- **The CNY price is taken straight from the product title** when it states one ("P300", "¥450"),
  removing the manual entry step in the case that most often demanded it.
- **A full popup redesign** keeping the same palette: segmented tabs, layered shadows, real
  focus states, automatic dark mode, and RTL-correct toggles.
- **Style code is presented as optional for watches**, which often arrive without one.

---

## v5.8.0 — 2026-09-22

### Fixed
- **Arabic user names printed reversed in PDF reports.** "يوسف" rendered as "فسوي" and "معتز"
  as "زتعم". The per-user table was the only place that did not pass its text through the
  bidi/shaping helper `_rtl()`; every other cell did.
- **Sync silently lost records, so a teammate's products were absent from every report.**
  The incremental pull uses a `since` watermark and never looks back, so once the watermark
  moved past a batch of records they were skipped permanently. A real measurement: the server
  held **3,800** records while the local archive had **2,476** — **1,324 missing**, including
  an entire month of one teammate's work (3,379 of his records remotely against 2,013 locally).
  A full reconcile existed but was manual-only and nothing ever called it. It now runs
  automatically every 6 hours, making sync self-healing.
- **Supplier prices could be read in the wrong currency.** szwego picks its displayed currency
  from the request IP, so a VPN rendered a 300 CNY watch as "Ұ7077.3" (JPY) and it reached the
  store as 3,839 SAR. The true CNY price is now recovered from the exchange rate the site
  itself publishes, and an unconfirmed conversion blocks the product for manual entry.
- **`extension/price_patterns.json` was missing from disk** although `content.js` loads it and
  the manifest exposes it, leaving price extraction on a bare-number fallback with no currency
  check at all. Restored.
- **Watches could not be submitted** because the unified profile selected colour attribute #2,
  which does not exist in the Sooqify panel. Watches now submit with no variant attribute.
- **A failed report validation left the previous success message on screen**, so a failure
  looked like a generated report.

### Added
- **Flexible report date scopes.** Besides one day and a whole month, reports can now cover
  hand-picked scattered days combined into one report, or a custom from-to range that may
  cross months. A 366-day cap rejects absurd ranges.
- **Sync fields on the login screen.** Login genuinely runs through the sync server, so the
  sync URL and code now live on the login screen; the check runs a real sync cycle and only
  then enables the login button.
- **Sooqify session verification before extraction.** The add-product page is fetched with the
  operator's cookies and checked for the real product form, instead of assuming a valid login
  and failing late.
- **Adaptive supplier throttling.** The supplier's rate-limiting is *silent* — HTTP 200 with a
  valid page and an empty product list — so a status-code detector catches nothing. The new
  throttle keys off request failure, success-but-empty, and unusual slowness, backing off
  exponentially and recovering gradually, with a visible wait notice.
- **A single source of truth for every shoes/watches difference** (`product_types.js` and its
  Python mirror), with a test that fails if the two sides drift apart.

### Changed
- Extension version to 5.8.0.
- Removed `MIGRATION_PLAN.md`, `HANDOFF_DOCUMENTATION.md` and `Backend refactor plan.md`;
  their content is superseded by `docs/reports/`, `docs/changes/` and `docs/planning/`.

### Tests
55 backend tests, plus 32 currency, 18 throttle and 9 session tests in Node.

---

## Backend refactoring history (pre-5.8)

This changelog documents the complete architectural migration of the Python Flask backend from a monolithic structure (`app.py`) to a modular, service-oriented architecture, executed in 7 distinct phases. All changes adhere strictly to the initial inventory decisions (`docs/reports/00_inventory.md`).

## Phase 0: Inventory & Analysis
- **Goal**: Full discovery and mapping of the monolith before any code modification.
- **Actions**:
  - Mapped all functions, classes, and global variables in the 3750-line `app.py`.
  - Identified all config/state JSON files and their couplings.
  - User decided on 9 critical architectural directions (e.g., ignoring dead AI cache, keeping `sync` as a startup-only process rather than a timer loop, and handling variant extraction as a pure service instead of a watcher).
- **Report**: `docs/reports/00_inventory.md`

## Phase 1: Setup Structure
- **Goal**: Establish the foundational directory tree without breaking existing flows.
- **Actions**:
  - Created the empty `backend/app/` skeleton with `api`, `core`, `repositories`, and `services` subdirectories.
  - Successfully moved fundamental settings reading into `backend/config/` avoiding legacy config loading mechanisms.
- **Report**: `docs/reports/01_phase1.md`

## Phase 2: Config & State Layer
- **Goal**: Isolate configurations and mutable state into dedicated, stateless modules.
- **Actions**:
  - Centralized global variables and path recomputation logic into `core/config.py` and state managers.
  - Decoupled `sync_state.json` and `sync_queue.json` from the main route handlers.
- **Report**: `docs/reports/02_phase2.md`

## Phase 3: Extract Services
- **Goal**: Move business rules out of the HTTP layer.
- **Actions**:
  - Migrated variant extraction, report generation, and other core business logic into domain services under `app/services/`.
  - Identified that the original `watch_variant_extractor.py` was now just re-exporting logic from `app.services.variant_extractor_service.py` (a "shim").
- **Report**: `docs/reports/03_phase3.md`

## Phase 4: Extract Repositories
- **Goal**: Decouple data access (JSON read/writes) from business logic.
- **Actions**:
  - Abstracted the system archive interactions into `app/repositories/archive_repository.py`.
  - Abstracted `sync_config.json` interactions into `app/repositories/sync_config_repository.py`.
  - Allowed repositories to accept dynamic base paths rather than relying on hardcoded global variables.
- **Report**: `docs/reports/04_repositories.md`

## Phase 5: API / Routes Layer Refactoring
- **Goal**: Decompose the monolith into Flask blueprints.
- **Actions**:
  - Created `upload_routes.py`, `sync_routes.py`, and `reports_routes.py` in `app/api/routes/`.
  - Set up an application factory at `backend/app/main.py`.
  - Extracted remaining monolith helper functions into `app/services/ai_helpers.py` to prevent circular dependencies.
  - The backend can now be run entirely from `app/main.py` without executing the original `app.py`.
- **Report**: `docs/reports/05_api_layer.md`

## Phase 6: Watchers / Background Jobs Cleanup
- **Goal**: Finalize or remove background watchers according to architectural decisions.
- **Actions**:
  - Validated that `watch_variant_extractor.py` had exactly 0 imports post-Phase 5.
  - Permanently deleted the legacy `watch_variant_extractor.py`.
  - Deleted the empty `app/watchers/` directory in compliance with Decision #8 (No Watchers).
  - Maintained `app/services/variant_extractor_service.py` as the single source of truth.
- **Report**: `docs/reports/06_watchers.md`

## Phase 7: Final Cleanup & Testing
- **Goal**: Finalize dependencies, run smoke tests, and declare the refactor officially complete.
- **Actions**:
  - Moved legacy test `test_upload_main_image_only.py` to `backend/tests/` and updated it to use absolute service imports, passing 2/2 tests.
  - Implemented `test_services_smoke.py` suite targeting all refactored domain services (using a mocked `ALPHACODE_ROOT_DIR` via `tempfile` to prevent corruption of real user data during test executions). All smoke tests passed successfully.
  - Conducted a full audit of `.py` import statements and upgraded `backend/requirements.txt` to accurately reflect the true dependencies in use (including missing ones noted in Phase 0 like `reportlab`, `arabic-reshaper`, and `python-bidi`).
  - Documented the entire 7-phase migration in this centralized `CHANGELOG.md`.
- **Report**: `docs/reports/07_final_cleanup.md`