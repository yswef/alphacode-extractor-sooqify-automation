# AlphaCode Extractor Changelog

## v5.0.0 — Main Image Only Upload

### Store upload behavior

- Changed the default behavior so the product gallery stays on the local machine and only the selected main image is sent to Sooqify.
- Kept full local image downloads intact and preserved the toggle for operators who want to re-enable gallery uploads manually.
- Updated the backend coordination and browser autofill flow so the gallery fields are skipped entirely in main-image-only mode.

### Release metadata

- Bumped the backend health version to `5.0.0` and aligned the browser extension manifest and project documentation to the same release number.

## v4.6.0 — Product Info File, Console UX, Stability Fix

### Product folder documentation

- Replaced the minimal `style_code.txt` with a richer `product_info.txt` in every product folder, containing the product's English and Arabic name, style code, date added, and who added it.

### Console output

- Added a colorized ASCII startup banner shown when the backend starts.
- Added a colorized, organized console log formatter (level badge, timestamp, source tag) while keeping the external log file plain text for easy searching.
- Added ANSI color support for Windows `cmd`/PowerShell consoles.
- Added a startup status panel summarizing server URL, save-folder configuration, AI key status, and two-user sync status at a glance.

### Fixes

- Fixed a null-reference crash (`Cannot set properties of null (setting 'disabled')`) in the Sooqify autofill panel's manual fill/submit buttons, caused by reading `event.currentTarget` after an `await` inside the click handler.

## v4.5.2 — Two-User Sync, Manual Folder Setup, Brand/Date Image Folders

### Two-user sync (optional)

- Added an optional central sync endpoint (`sync.php`, hosted on the operator's own web hosting) for two machines sharing one Sooqify store.
- Added atomic remote ID reservation so the two machines never assign the same product ID.
- Added an optimistic remote lock on each product's Search/Style code, requested before any image download, so both machines cannot prepare the same product at once.
- Added an automatic push of every newly archived product to the shared remote archive, with a local retry queue and a 90-second background worker for offline recovery.
- Added a local-only fallback: if the remote server is unreachable, ID assignment and duplicate checks fall back to the local archive and the product is flagged for later review instead of blocking the operator.
- Added a "Sync" popup tab with connection settings (URL, secret token, operator name), last pull/push timestamps, pending-queue count, and a manual "sync now" action.
- Added a small diagnostics list of the most recently added products, showing who added each one and whether its ID came from the remote reservation or a local fallback.

### Manual save-folder setup

- Removed the hardcoded Windows save path; the backend now blocks product saving with a clear error until a folder is explicitly configured.
- Added a native OS folder-picker dialog, triggered from the popup, so each machine chooses its own save folder independently.
- Added a popup banner and a folder-status card that appear whenever no valid folder is configured yet.

### Per-brand and per-date image folders

- Product image folders are now organized as `<images root>/<brand>/<date>/<product folder>` instead of a single flat folder.
- Added a `style_code.txt` file inside every product folder containing its Style Code, Search Code, and product ID.
- Preserved read and delete compatibility for products saved under earlier folder layouts (brand-only or unclassified).

### Store submission and image quality

- Added an option to submit only the main image to Sooqify while still downloading every image locally.
- When that option is enabled, every downloaded image is saved exactly as received — no resize, square-padding, or recompression — with its file extension detected directly from the image data.
- Bypassed the source-side CDN thumbnail transform entirely while this option is active, so local copies are always full quality.

### Fixes

- Fixed a popup settings bug where certain newly added toggle switches did not persist after closing and reopening the extension.

## v4.5.0 — Batch Product Queue

### Batch workflow

- Added product-selection checkboxes to SZWEGO product cards.
- Added a fixed batch toolbar with visible-product selection, review, and clear actions.
- Added a slide-based review screen for English/Arabic copy, brand, price, sizes, and image previews.
- Added a persistent batch queue stored in `chrome.storage.local`.
- Added limited-concurrency preparation with a default of one preparation task to reduce Groq and device load.
- Added pipeline execution: the next product can be prepared while the current product is being submitted.
- Added strictly sequential Sooqify submission using one automated store tab at a time.
- Added pause, resume, cancel, and failed-submission retry controls.
- Added one automatic retry for transient preparation/submission failures when configured.
- Added queue recovery after browser restart or service-worker suspension.
- Added desktop notifications after each product and after the final batch summary.

### AI quality and safety

- Upgraded the default Groq model to `openai/gpt-oss-120b`.
- Restricted optional product research to the resolved official company domain.
- Kept official research opt-in through regeneration instead of running it on every first generation.
- Limited official research to one search request per regeneration.
- Reduced supplier-text, research-dossier, and completion-token budgets.
- Stopped automatic retries on HTTP 429 rate limits.
- Read and returned Groq's `Retry-After` duration to the extension.
- Added one JSON-mode fallback without repeating official research.
- Restricted generated brands to `BrandMapJson` and the configured store brand.
- Prevented duplicate `Air Jordan` / `إير جوردن` brand text in English and Arabic titles.
- Kept the style code exactly once at the end of each title.

### Sooqify performance and reliability

- Added fast autofill mode and removed the automatic submit countdown by default.
- Replaced several fixed delays with conditional polling and short UI-settle delays.
- Preserved dynamic category-to-subcategory loading.
- Preserved real size-option and variant-row generation.
- Kept store submission at six total images: one main image and five gallery images.
- Added preparation retries without duplicating archived products.
- Added a lightweight alarm to recover a suspended queue.

### Compatibility and diagnostics

- Preserved the legacy `SizeactualChoiceNo` setting while standardizing on `SizeChoiceNo`.
- Preserved single-product extraction and submission workflows.
- Preserved archive, Excel, deletion, image, and external-log tools.
- Added bilingual Arabic/English comments to modified code.

## v3.2.0

- Prevented `Extension context invalidated` from appearing as a fatal product-save error.
- Added fallback retrieval of the latest prepared product from Flask.
- Added multi-image validation, archive management, and external diagnostics.