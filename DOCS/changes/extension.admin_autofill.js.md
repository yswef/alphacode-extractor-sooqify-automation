File: extension/admin_autofill.js
Change: When `UploadMainImageOnly` is true, skip assigning gallery images to store fields and return early with `mode: 'main_only_store_upload'` for background flows.
Details: Prevents unintended gallery uploads while preserving local saves.
Timestamp: 2026-08-14T09:00:00+03:00
