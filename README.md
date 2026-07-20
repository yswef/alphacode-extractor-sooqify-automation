# AlphaCode Extractor - Sooqify Automation

> **Private automation tool for controlled product extraction, image preparation, bilingual AI copy, and Sooqify/6amMart product submission.**

![Product modal](docs/assets/screenshots/extension-modal.svg)

## Repository name

```text
alphacode-extractor-sooqify-automation
```

## Short description

```text
A private Chrome extension and Flask automation tool that extracts supplier products, compresses images, generates bilingual AI copy, and prepares Sooqify/6amMart product submissions with logging and retry workflows.
```

**Arabic translation**

```text
أداة خاصة مكوّنة من إضافة Chrome وخادم Flask لاستخراج منتجات الموردين، ضغط الصور، توليد محتوى عربي وإنجليزي بالذكاء الاصطناعي، وتجهيز منتجات Sooqify/6amMart مع السجلات وإعادة المحاولة.
```

## What this project does

AlphaCode Extractor is a private workflow tool for extracting products from supplier pages, preparing product data locally, downloading and optimizing images, generating English/Arabic catalog copy, and automating Sooqify/6amMart product entry.

It is designed for an operator who reviews products in a browser, selects/adjusts content, and then sends the product into the store using controlled browser automation and a local Flask backend.

## Main capabilities

- Chrome Extension injected into supplier pages.
- Product data extraction from page text and hidden image sources.
- Style Code, Search Code, sizes, price, category, brand, and supplier metadata handling.
- Image download, compression, folder organization, and store image selection.
- Preferred image ordering with one main image and gallery images.
- Bilingual AI product copy generation.
- Official-site AI regeneration only when requested.
- Sooqify form autofill using the authenticated browser session.
- Automatic retry flow through a temporary Sooqify tab.
- Local archive, Excel database, deletion tools, and diagnostic logs.

## Architecture

![Architecture flow](docs/assets/screenshots/architecture-flow.svg)

```text
Supplier page / SZWEGO
        |
        | Chrome content script extracts data
        v
Local Flask backend on http://127.0.0.1:5000
        |
        | downloads images, compresses, archives product data
        v
Chrome extension stores pending product
        |
        | opens/controls Sooqify admin automation
        v
Sooqify / 6amMart product form
```

## Screenshots to add

| Area | Placeholder | What to capture |
|---|---|---|
| Product review modal | ![Modal](docs/assets/screenshots/extension-modal.svg) | Modal showing generated names, descriptions, sizes, price, and selected images. |
| Settings panel | ![Settings](docs/assets/screenshots/extension-settings.svg) | Extension tabs for settings, search, data clearing, API/model settings. |
| Sooqify autofill | ![Sooqify](docs/assets/screenshots/sooqify-autofill.svg) | Sooqify add-product page with AlphaCode automation panel. |
| Success workflow | ![Success](docs/assets/screenshots/success-workflow.svg) | Result popup with Continue and Verify Submission buttons. |
| Logs | ![Logs](docs/assets/screenshots/logs-diagnostics.svg) | Recent log viewer or `alphacode.log` diagnostics. |

## Requirements

### Backend

- Python 3.10+
- Flask
- Pillow
- pandas
- openpyxl
- requests
- certifi

Install backend requirements:

```bash
cd backend
pip install -r requirements.txt
```

If the repository does not include `requirements.txt`, create it with:

```text
flask
flask-cors
pillow
pandas
openpyxl
requests
certifi
```

### Browser

- Chrome or Brave with Developer Mode enabled.
- Active Sooqify admin login in the same browser profile.

### Optional AI

- Groq API key stored in environment variable:

```bash
setx GROQ_API_KEY "your_groq_api_key_here"
```

Restart your terminal after `setx`.

## Quick start

1. Start the backend:

```bash
cd backend
python app.py
```

2. Open Chrome extensions page:

```text
chrome://extensions
```

3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension/` folder.
6. Open a supplier page.
7. Use the AlphaCode extraction button.
8. Review product data, images, and sizes.
9. Add the product to Sooqify.

## Configuration

The default store configuration is centralized in:

```text
extension/config.js
```

Important values include:

| Key | Purpose |
|---|---|
| `StoreProfileName` | Name of the target store profile. |
| `StoreDomain` | Sooqify admin domain. |
| `SupplierStoreName` | Supplier/store label saved with extracted products. |
| `CategoryId` | Main category ID in Sooqify. |
| `SubCategoryId` | Subcategory ID. |
| `BrandId` | Brand ID. |
| `UnitId` | Measurement unit ID. |
| `SizeAttributeId` | Sooqify attribute ID for sizes. |
| `SizeChoiceNo` | Choice group number for variants. |
| `StoreImageLimit` | Number of images sent to the store. |
| `MaxImages` | Number of images downloaded locally. |
| `AutoAddProduct` | Enables automatic store submission workflow. |
| `AutoSubmitDelaySeconds` | Delay before submitting the Sooqify form. |

## Default folder paths

The backend controls image folders, archive JSON, logs, and Excel files. Check these constants near the top of:

```text
backend/app.py
```

Common paths include:

```text
products_database.xlsx
product_archive.json
logs/alphacode.log
images/<product_id>/
```

## AI behavior

The first AI generation uses normal product data only. If the operator asks for regeneration, the tool can run official-site research for the current product only and rewrite the content.

No output should include supplier names, prices, Search Code, Chinese text, authenticity claims, or unsupported quality claims.

## Troubleshooting

### Backend is not reachable

Open:

```text
http://127.0.0.1:5000/api/health
```

If it fails, restart:

```bash
cd backend
python app.py
```

### Extension changes are not visible

Reload the extension:

```text
chrome://extensions -> Reload
```

Then hard-refresh the supplier/Sooqify page:

```text
Ctrl + Shift + R
```

### Sooqify automation fails

- Confirm you are logged into Sooqify.
- Try manual retry in a visible tab.
- Check `logs/alphacode.log`.
- Confirm category, subcategory, brand, unit, and size attribute IDs are correct.

### AI returns an error

- Check `GROQ_API_KEY`.
- Reduce supplier text length if request is too large.
- Wait when Groq rate limits occur.
- Use normal generation first; official search only when needed.

## Documentation

- [English PDF documentation](docs/pdf/AlphaCode_Project_Documentation_EN.pdf)
- [Arabic PDF documentation](docs/pdf/AlphaCode_Project_Documentation_AR.pdf)
- [Support and installation documentation page](docs/index.html)

## License

This project is proprietary and source-available only for review by authorized people. Use, copying, redistribution, resale, hosting, modification, or derivative work is not allowed without prior written permission from the owner.

See [LICENSE](LICENSE).
