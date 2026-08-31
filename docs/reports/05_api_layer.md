# Phase 5: API / Routes Layer Refactoring

## Overview
This phase decoupled all HTTP endpoints from the monolithic `backend/app.py` into a modular Flask application using the App Factory pattern. **Phase 5 is now fully and verifiably complete** — the old `app.py` file no longer contains any route handlers, and the new entry point `app/main.py` has been successfully tested live.

## Accomplishments

### 1. All Five Blueprints Registered and Verified

All 38 original `@app.route` handlers from `app.py` now live in focused Blueprints under `backend/app/api/routes/`:

| Blueprint | File | Routes covered |
|-----------|------|----------------|
| `core_bp` | `core_routes.py` | `/api/health`, `/api/paths/status`, `/api/paths/choose-folder`, `/api/brands`, `/api/brands/add` |
| `sync_bp` | `sync_routes.py` | `/api/sync/pull`, `/api/sync/reconcile`, `/api/sync/config` (GET+POST), `/api/sync/status`, `/api/sync/now`, `/api/sync/login`, `/api/sync/logout` |
| `reports_bp` | `reports_routes.py` | `/api/reports/generate`, `/api/reports/download/<filename>`, `/api/data-repair/scan`, `/api/data-repair/apply`, `/api/data-repair/report`, `/api/data-repair/download/<filename>`, `/api/logs/price-patterns`, `/api/log/client`, `/api/logs/recent`, `/api/logs/download` |
| `upload_bp` | `upload_routes.py` | `/api/extract`, `/api/dry-run`, `/api/check`, `/api/ai/generate`, `/api/ai/extract-watch-variants`, `/api/archive/*`, `/api/pending/*`, `/api/product-images/*` |

### 2. App Factory (`backend/app/main.py`)

- `create_app()` registers all four Blueprints.
- Global error handler for HTTP 413 (oversized local requests) included.
- `@app.after_request` logs all 5xx errors centrally.

### 3. `core_bp` Was Missing Registration — Fixed

The `core_routes.py` file was created during Phase 5 but was never registered in `main.py`. This was the root cause of the user-identified gap. Fixed by:
- Rewriting `core_routes.py` to use correct imports (`save_paths_config`, `sync_call` returning `(data, error)`)
- Adding `app.register_blueprint(core_bp)` to `create_app()`

### 4. Verified Live Execution (2026-08-31)

`python -m app.main` started successfully and the following endpoints were tested live and returned correct responses:

| Endpoint | Result |
|----------|--------|
| `GET /api/health` | ✅ `{"status":"ok","root_dir_configured":true,...}` |
| `GET /api/paths/status` | ✅ `{"configured":true,"root_dir":"D:/sooqify",...}` |
| `GET /api/brands` | ✅ Returns live brand list from sync server |
| `GET /api/sync/status` | ✅ Returns sync state |
| `GET /api/archive/stats` | ✅ Returns archive statistics |
| `GET /api/logs/recent` | ✅ Returns recent log lines |
| `POST /api/extract` | ✅ Business logic reached (returns validation error for missing images — correct) |

### 5. `app.py` Routes Deleted

All 38 `@app.route` handlers were removed from `backend/app.py`. The file now:
- Retains only utility/helper code in its first ~505 lines (used internally by `ai_helpers.py`)
- Has a clear legacy stub comment explaining migration
- Redirects `python app.py` to `python -m app.main` with a clear error message

### 6. New Entry Point

```
cd backend
python -m app.main
```

The `app.py` direct invocation now exits with code 1 and a clear redirect message.

## Current State (Verified)

- `backend/app.py`: 530 lines (was 3,142). Zero `@app.route` decorators remain.
- `backend/app/main.py`: Full `create_app()` with all 4 Blueprints registered.
- `backend/app/api/routes/core_routes.py`: 5 routes (health, paths, brands).
- `backend/app/api/routes/sync_routes.py`: 9 routes (all sync endpoints).
- `backend/app/api/routes/reports_routes.py`: 10 routes (reports, data-repair, logs).
- `backend/app/api/routes/upload_routes.py`: 14 routes (extract, ai, archive, pending, images).
