# Phase 6: Watchers / Background Jobs Refactoring (Cleanup)

> **⚠️ Correction Note (2026-08-31):** When this report was originally written, Phase 5 was marked complete but `core_routes.py` had never been registered in `main.py`, and `backend/app.py` still contained all 38 `@app.route` handlers. Phase 5 was completed for real on 2026-08-31: `core_bp` was registered, all routes were verified live, and all route handlers were deleted from `app.py`. The Phase 6 cleanup described below was valid and remains unchanged.

## Overview
This phase focused on the validation and integration of the background/watcher jobs as per the project restructuring plan. However, based on the documented design decisions from Phase 0 (`docs/reports/00_inventory.md` - Decision #8), the planned watcher module for variant extraction (`watch_variant_extractor.py`) was identified as an architectural anti-pattern for this specific project.

## Accomplishments

### 1. Enforcement of Decision #8 (No Watchers)
- **Validation**: We validated that the logic for extracting variants belongs strictly in the service layer (`app/services/variant_extractor_service.py`), and it does NOT warrant a continuous background "watcher" or distinct cron job for this operation. The service is cleanly invoked by the HTTP layer as part of the normal flow.
- **Verification of Dead Code**: A comprehensive textual search across all Python files in the `backend/` directory confirmed exactly **0 imports** or references to the legacy `backend/watch_variant_extractor.py` shim file. It was safely determined to be 100% dead code post-Phase 5.

### 2. Cleanup & Deletion
- **Deleted `watch_variant_extractor.py`**: The legacy shim file located at the root of `backend/` was permanently deleted.
- **Removed `app/watchers/` directory**: The placeholder directory `backend/app/watchers/` (which only contained an empty `__init__.py`) was completely deleted from the project file structure to prevent future developers from introducing incorrect patterns.

### 3. Preserved Service Logic
- `app/services/variant_extractor_service.py` was left entirely untouched. It remains the single source of truth for the variant parsing logic, faithfully acting as the domain service intended by the Phase 3 migration.

## Next Steps
The backend is now completely free of legacy watcher files and rogue shims. We are ready to proceed to **Phase 7 (Tests & Cleanup)**, which will involve standardizing error handling, tidying up old test files (`test_upload_main_image_only.py`), and verifying the final demolition of the original monolithic `backend/app.py`.
