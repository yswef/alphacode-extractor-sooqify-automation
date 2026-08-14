File: extension/background.js
Change: Respect `UploadMainImageOnly` when building FormData for store submission; only append gallery images when the flag is false.
Details: Added checks to avoid appending gallery images to FormData when main-only is enabled.
Timestamp: 2026-08-14T08:55:00+03:00
