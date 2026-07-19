AlphaCode Extractor 3.2
=======================

PROJECT STRUCTURE
-----------------
backend/
  app.py
  requirements.txt
extension/
  manifest.json
  config.js
  content.js
  content.css
  page_bridge.js
  background.js
  admin_autofill.js
  admin_autofill.css
  popup.html
  popup.js

IMPORTANT NAMING
----------------
Target store profile: Sooqify Online
Supplier store on SZWEGO: BRANDKINGDOM

INSTALLATION
------------
1. Open Command Prompt inside the backend folder.
2. Install dependencies:
   python -m pip install -r requirements.txt

3. Configure Groq once:
   setx GROQ_API_KEY "gsk_YOUR_KEY"
   setx GROQ_MODEL "openai/gpt-oss-20b"

4. Close Command Prompt and open a new one.
5. Start the server:
   python app.py

6. Open Chrome:
   chrome://extensions

7. Enable Developer mode.
8. Remove or disable the old AlphaCode extension.
9. Choose Load unpacked and select the extension folder.
10. Refresh every already-open SZWEGO and Sooqify page once after reloading the extension.

WHY A PAGE REFRESH IS REQUIRED
------------------------------
Chrome invalidates old content scripts whenever an extension is reloaded. Version 3.2 protects the workflow and can recover the latest prepared product from Flask, but an already-open page must still be refreshed once to load the new script version.

DATA MANAGEMENT
---------------
Open the extension popup, then open the Data tab.

Delete one product:
- Removes its record from archive_db.json.
- Removes its row from Excel.
- Optionally removes its product image folder.

Clear all data:
- Clears all product records from archive_db.json.
- Clears product rows from Excel.
- Optionally deletes all registered image folders.
- Optionally clears the Groq AI cache.

PRODUCT STATUS
--------------
prepared       = Saved locally and ready for Sooqify.
submit_started = The native Sooqify Add button was clicked.
submitted      = Navigation after submission was detected.
submit_failed  = Autofill or automatic submission failed.

MULTI-IMAGE SUBMISSION
----------------------
- First image is assigned to the image field.
- Remaining images are assigned to item_images[].
- The adapter validates the actual FormData before submitting.
- Missing images are added through generated file inputs.
- A detailed payload summary is written to alphacode.log.

EXTERNAL LOG
------------
Default location:
Y:\سوقفاي\logs\alphacode.log

The log records:
- Backend image downloads.
- AI errors.
- Extension and admin-page JavaScript errors.
- Main and gallery image names included in FormData.
- Product workflow-status changes.
- Data deletion operations.

SUPPLIER / TARGET STORE MIGRATION
---------------------------------
StoreProfileName identifies the target e-commerce platform.
SupplierStoreName identifies the source supplier on SZWEGO.
The old configuration that used BRANDKINGDOM for both is migrated automatically:
- StoreProfileName -> Sooqify Online
- SupplierStoreName -> BRANDKINGDOM
