# AlphaCode Extractor Changelog

## v4.3.0 — Batch Product Queue

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
