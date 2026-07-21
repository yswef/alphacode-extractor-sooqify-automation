# AlphaCode Extractor v4.3 — Sooqify Batch Automation

> Private Chrome Extension and Flask backend for extracting supplier products, preparing bilingual catalog copy, optimizing images, and submitting products to Sooqify/6amMart individually or as a controlled batch.

## Main capabilities

- Extract product name, Style Code, Search Code, sizes, price, and full image gallery from SZWEGO.
- Generate polished English and Arabic footwear copy.
- Restrict generated brands to the brands configured in `BrandMapJson`.
- Prevent duplicated `Air Jordan` and `إير جوردن` text in product titles.
- Run official-site-only research when the operator explicitly requests regeneration.
- Download, resize, compress, and archive product images locally.
- Send six images to Sooqify: one main image and five gallery images.
- Fill category, subcategory, brand, unit, price, stock, sizes, variants, translations, and images.
- Add one product manually or select several products and run a persistent batch queue.
- Notify the operating system after each submitted product and after batch completion.

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
  app.py                 Flask API, AI, images, archive, Excel, logs
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
docs/
  AlphaCode_Project_Documentation_AR.pdf
  AlphaCode_Project_Documentation_EN.pdf
```

## Requirements

- Windows 10/11.
- Python 3.10 or newer.
- Chrome or Brave with Developer Mode enabled.
- An active Sooqify admin login in the same browser profile.
- A Groq API key when AI generation is enabled.

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

## Important defaults

The main settings are in `extension/config.js` and are editable in the popup.

| Setting | Default | Purpose |
|---|---:|---|
| `AIModel` | `openai/gpt-oss-120b` | Final bilingual copy model |
| `BrandMapJson` | `{"Air Jordan":6}` | Allowed store brands and IDs |
| `StoreImageLimit` | `6` | One main + five gallery images |
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

The backend root defaults to:

```text
Y:\سوقفاي
```

Override it with:

```bat
setx ALPHACODE_ROOT_DIR "D:\AlphaCodeData"
```

Files include:

```text
archive_db.json
items_bulk_format_nodata.xlsx
ai_copy_cache.json
logs\alphacode.log
صور\Air Jordan\...
```

## Troubleshooting

### Backend unavailable

Open:

```text
http://127.0.0.1:5000/api/health
```

Then restart `START_ALPHACODE.bat` if needed.

### Rate limit

AlphaCode does not retry HTTP 429 automatically. Wait for the exact duration shown by the extension, then regenerate. Keep batch AI concurrency at `1`.

### Batch paused because of login

Sign in to Sooqify, return to the supplier page, and press **استكمال** in the queue panel.

### Extension changes not visible

Reload the extension and then use `Ctrl + Shift + R` on both SZWEGO and Sooqify pages.

### Sooqify field or image failure

Check:

```text
Y:\سوقفاي\logs\alphacode.log
```

Confirm Category ID, Subcategory ID, Brand ID, Unit ID, Size Attribute ID, and the current Sooqify session.

## Documentation

- [Arabic project documentation](docs/AlphaCode_Project_Documentation_AR.pdf)
- [English project documentation](docs/AlphaCode_Project_Documentation_EN.pdf)
- [v4.3 changelog](CHANGELOG.md)

The PDF documents describe the core architecture; `CHANGELOG.md` and this README contain the v4.3 batch additions.

## License

This project is proprietary. See [LICENSE](LICENSE).
