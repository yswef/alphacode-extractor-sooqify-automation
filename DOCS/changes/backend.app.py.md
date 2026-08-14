File: backend/app.py
Change: Added `sync_reconcile_full()` endpoint and a lightweight `POST /api/sync/logout` endpoint; started a one-off reconcile thread at startup when sync is enabled. Bumped health-check version string to 5.0.0.
Details: Centralized reconcile logic to pull remote archive and queue local-only pushes; logout endpoint returns success for client-side logout. Added startup reconcile background thread.
Timestamp: 2026-08-14T08:40:00+03:00
