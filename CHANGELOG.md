# AlphaCode Extractor 3.2

## Fixed
- Prevented `Extension context invalidated` from appearing as a fatal product-save error.
- Added fallback retrieval of the latest prepared product from Flask.
- Changed duplicate wording from “added” to “prepared locally” until store submission is confirmed.
- Added a direct “open prepared product” workflow for existing archive records.
- Corrected the target-store/supplier-store naming mix-up.
- Removed Groq JSON-mode enforcement and added resilient JSON extraction.

## Multi-image reliability
- Validates the real native `FormData` before submission.
- Assigns all remaining images to `item_images[]`.
- Adds only missing files through generated inputs.
- Logs exact main/gallery filenames and missing files.

## Data management
- Added archive statistics.
- Added single-product deletion from JSON and Excel.
- Added optional product-image-folder deletion.
- Added clear-all with optional image and AI-cache deletion.

## Diagnostics
- Added global JavaScript error and unhandled rejection logging.
- Added form-payload summary logging before native store submission.
- Added product workflow statuses: prepared, submit_started, submitted, submit_failed.
