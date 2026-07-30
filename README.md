# AlphaCode Extractor v4.5.2 — Sooqify Batch Automation

> Private Chrome Extension and Flask backend for extracting supplier products, preparing bilingual catalog copy, optimizing images, and submitting products to Sooqify/6amMart individually or as a controlled batch — with optional two-user sync for teams sharing one store.

## Main capabilities

- Extract product name, Style Code, Search Code, sizes, price, and full image gallery from SZWEGO.
- Generate polished English and Arabic footwear copy.
- Restrict generated brands to the brands configured in `BrandMapJson`.
- Prevent duplicated `Air Jordan` and `إير جوردن` text in product titles.
- Run official-site-only research when the operator explicitly requests regeneration.
- Download, resize, compress, and archive product images locally.
- Optionally submit only the main image to Sooqify while keeping every image saved locally at full, untouched quality.
- Organize saved images per brand and per day (`<images root>/<Brand>/<YYYY-MM-DD>/<product>`), each with a `style_code.txt` reference file.
- Send up to six images to Sooqify: one main image and up to five gallery images (or just the main image, if that option is enabled).
- Fill category, subcategory, brand, unit, price, stock, sizes, variants, translations, and images.
- Add one product manually or select several products and run a persistent batch queue.
- Notify the operating system after each submitted product and after batch completion.
- Optionally sync two machines working on the same store, preventing duplicate product IDs and duplicate product additions.

## Batch workflow

1. Open a SZWEGO product-list page.
2. Select two or more products using **تحديد للدفعة**.
3. Click **مراجعة وإضافة** in the fixed AlphaCode toolbar.
4. Review each product using the previous/next slides.
5. Edit English/Arabic content, brand, price, and sizes as needed.
6. Start the batch.
7. AlphaCode prepares products with limited concurrency and submits them to Sooqify one at a time.
8. Use the floating queue panel to pause, resume, cancel, or retry failed submissions.

The queue is saved in `chrome.storage.local`, so it can recover after a Chrome restart or service-worker suspension. Only one Sooqify submission tab is active at a time to reduce memory usage and prevent product data from mixing.

## Project structure

```text
backend/
  app.py                 Flask API, AI, images, archive, Excel, logs, sync client, folder setup
  requirements.txt
extension/
  config.js              Shared defaults
  content.js             Supplier extraction, review UI, batch preparation
  content.css
  background.js          Persistent sequential submission queue and notifications
  admin_autofill.js      Sooqify form adapter
  admin_autofill.css
  page_bridge.js         React/network gallery bridge
  popup.html
  popup.js
  manifest.json
  icons/
hostinger/
  alphacode_storage/
    sync.php             Central two-user sync endpoint (upload to your own hosting)
docs/
  AlphaCode_Project_Documentation_AR.pdf
  AlphaCode_Project_Documentation_EN.pdf
```

`sync.php` does not live in the extension or backend folders because it is not run locally — it is uploaded once to a PHP-capable web host and shared by both machines. It creates its own `archive_shared.json` and `id_counter.json` next to itself on first use.

The backend also creates a few small runtime files next to `app.py` on first run — `paths_config.json`, `sync_config.json`, `sync_queue.json`, `sync_state.json`. These are machine-specific and should stay out of version control (add them to `.gitignore`).

## Requirements

- Windows 10/11.
- Python 3.10 or newer, with the standard `tkinter` component available (needed for the save-folder picker dialog).
- Chrome or Brave with Developer Mode enabled.
- An active Sooqify admin login in the same browser profile.
- A Groq API key when AI generation is enabled.
- A PHP-capable web host only if two-user sync is enabled (optional).

Install requirements:

```bat
INSTALL_REQUIREMENTS.bat
```

Set the Groq key once:

```bat
setx GROQ_API_KEY "your_groq_api_key_here"
```

Open a new terminal after `setx`, then start the backend:

```bat
START_ALPHACODE.bat
```

## Install the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder.
5. After every code update, click **Reload** and hard-refresh supplier/store pages with `Ctrl + Shift + R`.

## First-run setup: choose a save folder

As of v4.5.2 there is no default save path. On first launch, open the popup's **المزامنة والمجلد** tab and click **اختيار / تغيير مجلد الحفظ** to open a native folder picker and choose where product images, the archive, and the Excel file are stored. Product saving is blocked with a clear error until this is done. Each machine keeps its own independent choice — the two saved folders never need to match.

## Two-user sync (optional)

Lets two operators run AlphaCode on two separate machines against the same Sooqify store without colliding on product IDs or duplicating the same product.

1. Upload `hostinger/alphacode_storage/sync.php` to a PHP-capable web host (any shared hosting works, no extra setup needed).
2. Open the file on the host and change the `$SECRET_TOKEN` placeholder to a long random value. Keep it private between the two operators.
3. On **each** machine, open the popup's **المزامنة والمجلد** tab, enable **تفعيل المزامنة**, and enter the same server URL and secret token, plus a short operator name.
4. Save. From then on, new products are ID-reserved and duplicate-checked centrally before any image is downloaded, and every finished product is pushed to the shared archive automatically.

If the sync server is unreachable, AlphaCode keeps working locally: it falls back to local ID numbering (flagged as `local_fallback` in the diagnostics list) and queues the push for automatic retry once the connection returns. Sync only covers products added after it is enabled — products already in an existing local archive are not retroactively uploaded.

## Important defaults

The main settings are in `extension/config.js` and are editable in the popup.

| Setting | Default | Purpose |
|---|---:|---|
| `AIModel` | `openai/gpt-oss-120b` | Final bilingual copy model |
| `BrandMapJson` | `{"Air Jordan":6}` | Allowed store brands and IDs |
| `StoreImageLimit` | `6` | One main + five gallery images |
| `UploadMainImageOnly` | `false` | Submit only the main image to Sooqify; save every image locally untouched |
| `FastAutofillMode` | `true` | Uses short conditional waits |
| `AutoSubmitDelaySeconds` | `0` | Removes the countdown |
| `BatchModeEnabled` | `true` | Enables multi-product selection |
| `BatchPreparationConcurrency` | `1` | Low-resource preparation limit |
| `BatchMaximumProducts` | `25` | Maximum selected batch size |
| `BatchContinueOnFailure` | `true` | Continue after one product fails |
| `BatchNotifyEachProduct` | `true` | Desktop notification per product |
| `BatchMaxRetries` | `1` | One transient retry |
| `BatchDownloadSelectedImagesOnly` | `true` | Download only the six batch images |

For a free Groq account, keep `BatchPreparationConcurrency` at `1` to reduce token-per-minute errors.

## AI behavior

### Normal generation

The first generation uses supplier evidence only and does not search the web.

### Official regeneration

When **official research** is requested, AlphaCode:

- resolves the official domain for the allowed brand;
- searches that domain only;
- performs one research request;
- sends a compact dossier to the final model;
- does not repeat the search during JSON repair;
- returns `retry_after_seconds` on HTTP 429 instead of retrying immediately.

Generated `brand_name` must exist in `BrandMapJson`; otherwise AlphaCode returns to the configured store brand.

## Local data paths

The save folder is chosen per machine from the popup (see **First-run setup** above) instead of being fixed in code. `ALPHACODE_ROOT_DIR` is only used as the suggested value the very first time, before any folder has been explicitly chosen.

Inside the chosen folder:

```text
archive_db.json
items_bulk_format_nodata.xlsx
ai_copy_cache.json
logs\alphacode.log
صور\<Brand>\<YYYY-MM-DD>\<product folder>\
    ...product images...
    style_code.txt
```

## Troubleshooting

### Backend unavailable

Open:

```text
http://127.0.0.1:5000/api/health
```

Then restart `START_ALPHACODE.bat` if needed.

### "No save folder is configured yet"

Open the popup's **المزامنة والمجلد** tab and click **اختيار / تغيير مجلد الحفظ**. If the native picker does not appear, confirm Python's `tkinter` component is installed (`python -c "import tkinter"` should run with no error) and check `logs\alphacode.log` for the exact subprocess error.

### Sync settings do not stick, or a toggle resets after reopening the popup

Reload the extension from `chrome://extensions` after any `extension/` file update — the popup can otherwise keep running its previous cached script.

### Rate limit

AlphaCode does not retry HTTP 429 automatically. Wait for the exact duration shown by the extension, then regenerate. Keep batch AI concurrency at `1`.

### Batch paused because of login

Sign in to Sooqify, return to the supplier page, and press **استكمال** in the queue panel.

### Extension changes not visible

Reload the extension and then use `Ctrl + Shift + R` on both SZWEGO and Sooqify pages.

### Sooqify field or image failure

Check:

```text
<your chosen folder>\logs\alphacode.log
```

Confirm Category ID, Subcategory ID, Brand ID, Unit ID, Size Attribute ID, and the current Sooqify session.

## Documentation

- [Arabic project documentation](docs/AlphaCode_Project_Documentation_AR.pdf)
- [English project documentation](docs/AlphaCode_Project_Documentation_EN.pdf)
- [v4.5.2 changelog](CHANGELOG.md)

The PDF documents describe the core architecture; `CHANGELOG.md` and this README contain the v4.5 batch additions and the v4.5.2 sync/folder/image-quality additions.

## License

This project is proprietary. See [LICENSE](LICENSE).