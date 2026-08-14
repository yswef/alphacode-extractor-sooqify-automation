File: extension/content.js
Change: Improved style-code extraction heuristics, added editable style-code input in single and batch review modals, captured style-code in batch slides, and guarded copy actions. No behavioral change to product-type detection.
Details: Rewrote `extractStyleCode()` with extra patterns and `isReasonableCode()` filter; added `#modStyleCode` input and `.batch-style-code` fields; updated submit flow to include manual style code.
Timestamp: 2026-08-14T08:35:00+03:00
