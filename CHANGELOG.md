# Changelog — AlphaCode Extractor

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