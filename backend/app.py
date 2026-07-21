import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit

import certifi
import pandas as pd
import requests
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS
from PIL import Image, ImageOps

app = Flask(__name__)

# Arabic: حد وقائي لطلبات الواجهة المحلية مع رسالة JSON مفهومة عند تجاوزه.
# English: Defensive local request-size limit with a JSON error response.
app.config["MAX_CONTENT_LENGTH"] = 512 * 1024
CORS(app)


@app.errorhandler(413)
def handle_local_request_too_large(_error):
    """Arabic: إعادة خطأ 413 بصيغة تفهمها الإضافة. English: Return local HTTP 413 as extension-friendly JSON."""
    return jsonify({
        "success": False,
        "request_too_large": True,
        "error": "حجم البيانات المرسلة إلى الخادم المحلي أكبر من الحد المسموح.",
    }), 413

# Arabic: المسارات الأساسية قابلة للتعديل عند نقل المشروع إلى جهاز أو متجر آخر.
# English: Core paths are intentionally centralized for future store migrations.
ROOT_DIR = os.getenv("ALPHACODE_ROOT_DIR", r"Y:\\سوقفاي")
BASE_DIR = os.path.join(ROOT_DIR, "صور", "Air Jordan")
EXCEL_PATH = os.path.join(ROOT_DIR, "items_bulk_format_nodata.xlsx")
ARCHIVE_PATH = os.path.join(ROOT_DIR, "archive_db.json")
AI_CACHE_PATH = os.path.join(ROOT_DIR, "ai_copy_cache.json")
LOG_DIR = os.path.join(ROOT_DIR, "logs")
LOG_PATH = os.path.join(LOG_DIR, "alphacode.log")

# Arabic: مزودات الذكاء الاصطناعي مدعومة من الخادم دون أتمتة واجهة ChatGPT الشخصية.
# English: The backend supports API providers without automating a personal ChatGPT web session.
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_AI_PROVIDER = "groq"
DEFAULT_AI_MODEL = "openai/gpt-oss-120b"
DEFAULT_OPENAI_MODEL = "gpt-5.2"
GROQ_OFFICIAL_SEARCH_MODEL = "groq/compound-mini"
AI_PROMPT_VERSION = "4.3-batch-official-brand-guard-fast-json"

# Arabic: القفل يمنع تعارض طلبين أثناء تحديث الصور وExcel والأرشيف.
# English: The lock prevents concurrent requests from corrupting images, Excel, or archive data.
SAVE_LOCK = threading.RLock()
AI_CACHE_LOCK = threading.RLock()

def configure_application_logging():
    """Arabic: تهيئة سجل خارجي دوّار مع استمرار الطباعة في الطرفية. English: Configure rotating external logs while preserving console output."""
    log_format = logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    if not any(getattr(handler, "_alphacode_console", False) for handler in root_logger.handlers):
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(log_format)
        console_handler._alphacode_console = True
        root_logger.addHandler(console_handler)

    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        if not any(getattr(handler, "_alphacode_file", False) for handler in root_logger.handlers):
            file_handler = RotatingFileHandler(
                LOG_PATH,
                maxBytes=5 * 1024 * 1024,
                backupCount=5,
                encoding="utf-8",
            )
            file_handler.setFormatter(log_format)
            file_handler._alphacode_file = True
            root_logger.addHandler(file_handler)
    except OSError as exc:
        root_logger.warning("Could not initialize external log file %s: %s", LOG_PATH, exc)


configure_application_logging()
logger = logging.getLogger("alphacode")

# Arabic: ترويسات تشبه المتصفح لتقليل حظر خادم الصور الصيني.
# English: Browser-like headers reduce anti-bot blocking by the image CDN.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    "Referer": "https://szwego.com/",
    "Connection": "keep-alive",
}

INVALID_MARKERS = {"", "NONE", "NULL", "UNDEFINED", "غير محدد", "NO_CODE", "NO_STYLE"}
EXCEL_COLUMNS = [
    "Id", "Name", "Description", "Image", "CategoryId", "SubCategoryId", "UnitId",
    "Stock", "Price", "Discount", "DiscountType", "AvailableTimeStarts", "AvailableTimeEnds",
    "Variations", "ChoiceOptions", "AddOns", "Attributes", "StoreId", "ModuleId", "Status",
    "Veg", "Recommended",
]


def normalize_text(value):
    """Arabic: توحيد النصوص قبل التخزين أو المقارنة. English: Normalize text before storage or comparison."""
    return str(value or "").strip()


def compact_prompt_text(value, maximum_length):
    """Arabic: تقليص نصوص البرومبت وحذف الروابط والرموز الطويلة لتجنب 413. English: Compact prompt text and remove URLs or opaque tokens to prevent HTTP 413."""
    text = re.sub(r"\s+", " ", normalize_text(value))
    text = re.sub(r"https?://\S+", " ", text, flags=re.I)
    text = re.sub(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", " ", text, flags=re.I)
    text = re.sub(r"\b[A-Za-z0-9_-]{180,}\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    safe_length = max(200, min(safe_int(maximum_length, 2000), 10000))
    return text[:safe_length]


def is_valid_marker(value):
    """Arabic: التحقق من أن الكود ليس قيمة فارغة أو وهمية. English: Validate that a code is not empty or synthetic."""
    return normalize_text(value).upper() not in INVALID_MARKERS


def safe_int(value, fallback):
    """Arabic: تحويل آمن إلى عدد صحيح. English: Safely coerce a value to integer."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return int(fallback)


def safe_float(value, fallback):
    """Arabic: تحويل آمن إلى عدد عشري. English: Safely coerce a value to float."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def safe_bool(value, fallback=False):
    """Arabic: قراءة القيم المنطقية القادمة من JavaScript. English: Parse boolean-like values received from JavaScript."""
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def unique_text_values(values):
    """Arabic: إزالة القيم المكررة مع المحافظة على ترتيبها. English: Deduplicate text values while preserving order."""
    result = []
    seen = set()
    for value in values or []:
        normalized = normalize_text(value)
        key = normalized.casefold()
        if not normalized or key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def sanitize_log_value(value, maximum_length=4000):
    """Arabic: تقليص بيانات سجل المتصفح وحذف القيم الحساسة. English: Trim browser-log data and remove sensitive values."""
    sensitive_keys = {"_token", "token", "cookie", "authorization", "x-csrf-token", "x-xsrf-token"}
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if str(key).lower() in sensitive_keys else sanitize_log_value(item, maximum_length)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_log_value(item, maximum_length) for item in value[:100]]
    text = normalize_text(value)
    return text[:maximum_length]


def read_recent_log_lines(limit=200):
    """Arabic: قراءة آخر أسطر السجل الخارجي دون تحميل الملف كاملاً. English: Read the latest external log lines without loading the entire file."""
    safe_limit = max(1, min(safe_int(limit, 200), 1000))
    if not os.path.exists(LOG_PATH):
        return []
    with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as log_file:
        lines = log_file.readlines()
    return [line.rstrip("\n") for line in lines[-safe_limit:]]


def load_json_file(path, default):
    """Arabic: قراءة JSON بأمان مع قيمة افتراضية عند التلف. English: Safely read JSON and fall back when the file is invalid."""
    if not os.path.exists(path):
        return default.copy() if isinstance(default, dict) else default
    try:
        with open(path, "r", encoding="utf-8") as file:
            value = json.load(file)
        return value if isinstance(value, type(default)) else default
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read JSON file %s: %s", path, exc)
        return default.copy() if isinstance(default, dict) else default


def load_archive():
    """Arabic: تحميل أرشيف المنتجات المحلي. English: Load the local product archive."""
    return load_json_file(ARCHIVE_PATH, {})


def write_json_temp(target_path, payload, token):
    """Arabic: كتابة JSON إلى ملف مؤقت على القرص نفسه. English: Write JSON to a same-volume temporary file."""
    directory = os.path.dirname(target_path)
    os.makedirs(directory, exist_ok=True)
    temp_path = os.path.join(directory, f".{os.path.basename(target_path)}.{token}.tmp")
    with open(temp_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=4)
        file.flush()
        os.fsync(file.fileno())
    return temp_path


def save_json_atomic(target_path, payload):
    """Arabic: استبدال ملف JSON دفعة واحدة لتجنب الملفات الجزئية. English: Atomically replace a JSON file to avoid partial writes."""
    token = uuid.uuid4().hex
    temp_path = write_json_temp(target_path, payload, token)
    try:
        os.replace(temp_path, target_path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def clean_folder_name(name, fallback_code):
    """Arabic: تنظيف اسم مجلد المنتج من رموز Windows غير الصالحة. English: Sanitize a product folder name for Windows."""
    clean_name = re.sub(r'[\\/*?:"<>|]', "", normalize_text(name)).strip(" .")
    if not clean_name or clean_name == "منتج بدون عنوان":
        clean_name = f"Product_{normalize_text(fallback_code) or 'Unknown'}"
    return re.sub(r"\s+", " ", clean_name)[:70]


def clean_code_for_path(value):
    """Arabic: تحويل الكود إلى جزء آمن من اسم المسار. English: Convert a code into a path-safe suffix."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", normalize_text(value)).strip("-._")
    return cleaned[:40] or "NO-CODE"


def archive_entries(archive):
    """Arabic: استبعاد مفاتيح الميتاداتا من سجلات المنتجات. English: Exclude metadata keys from product archive entries."""
    return {
        key: value for key, value in archive.items()
        if not str(key).startswith("_") and isinstance(value, dict)
    }


def get_next_id(archive):
    """Arabic: توليد ID من أعلى رقم مسجل وليس من عدد السجلات. English: Generate the next ID from the maximum recorded ID."""
    ids = []
    for item in archive_entries(archive).values():
        try:
            ids.append(int(item.get("id")))
        except (TypeError, ValueError):
            continue
    return (max(ids) if ids else 0) + 1


def find_existing_product(archive, search_code, style_code):
    """Arabic: كشف التكرار بواسطة Search Code ثم Style Code. English: Detect duplicates by Search Code, then Style Code."""
    search_code = normalize_text(search_code)
    style_code = normalize_text(style_code)
    if is_valid_marker(search_code) and search_code in archive and isinstance(archive[search_code], dict):
        return archive[search_code]
    if is_valid_marker(style_code):
        normalized_style = style_code.upper()
        for item in archive_entries(archive).values():
            if normalize_text(item.get("style_code")).upper() == normalized_style:
                return item
    return None


def find_product_by_id(archive, product_id):
    """Arabic: البحث في الأرشيف باستخدام ID المحلي. English: Find an archived product by its local ID."""
    wanted_id = safe_int(product_id, -1)
    for item in archive_entries(archive).values():
        if safe_int(item.get("id"), -2) == wanted_id:
            return item
    return None


def extract_settings(data):
    """Arabic: قراءة جميع الإعدادات مع قيم آمنة للمتاجر المستقبلية. English: Read all settings with safe defaults for future stores."""
    settings = data.get("Settings") if isinstance(data.get("Settings"), dict) else data
    return {
        "CategoryId": safe_int(settings.get("CategoryId"), 41),
        "SubCategoryId": safe_int(settings.get("SubCategoryId"), 42),
        "UnitId": safe_int(settings.get("UnitId"), 1),
        "Stock": max(0, safe_int(settings.get("Stock"), 100)),
        "ExchangeRate": safe_float(settings.get("ExchangeRate"), 0.5),
        "AddedFeeYuan": safe_float(settings.get("AddedFeeYuan"), 250),
        "Discount": safe_float(settings.get("Discount"), 0),
        "DiscountType": normalize_text(settings.get("DiscountType")) or "percent",
        "AvailableTimeStarts": normalize_text(settings.get("AvailableTimeStarts")) or "00:00:00",
        "AvailableTimeEnds": normalize_text(settings.get("AvailableTimeEnds")) or "23:59:59",
        "MaximumCartQuantity": normalize_text(settings.get("MaximumCartQuantity")),
        "StoreId": safe_int(settings.get("StoreId"), 3),
        "ModuleId": safe_int(settings.get("ModuleId"), 2),
        "Status": normalize_text(settings.get("Status")) or "active",
        "Veg": normalize_text(settings.get("Veg")) or "no",
        "Recommended": normalize_text(settings.get("Recommended")) or "yes",
        "BrandId": safe_int(settings.get("BrandId"), 6),
        "BrandName": normalize_text(settings.get("BrandName")) or "Air Jordan",
        "BrandMapJson": normalize_text(settings.get("BrandMapJson")) or '{"Air Jordan":6}',
        "SizeAttributeId": max(1, safe_int(settings.get("SizeAttributeId"), 1)),
        "SizeChoiceNo": max(1, safe_int(
            settings.get("SizeChoiceNo", settings.get("SizeactualChoiceNo")),
            1,
        )),
        "SizeactualChoiceNo": max(1, safe_int(
            settings.get("SizeChoiceNo", settings.get("SizeactualChoiceNo")),
            1,
        )),
        "SizeTitle": normalize_text(settings.get("SizeTitle")) or "الحجم",
        "DefaultLanguage": normalize_text(settings.get("DefaultLanguage")).lower() or "en",
        "SupplierStoreName": normalize_text(settings.get("SupplierStoreName")),
        "SupplierStoreId": normalize_text(settings.get("SupplierStoreId")),
        "ImageMaxDimension": max(300, min(safe_int(settings.get("ImageMaxDimension"), 1200), 3000)),
        "ImageQuality": max(35, min(safe_int(settings.get("ImageQuality"), 75), 95)),
        "ImageFormat": normalize_text(settings.get("ImageFormat")).lower() or "jpeg",
        "OptimizeImageAtSource": safe_bool(settings.get("OptimizeImageAtSource"), True),
        "RequireAllImages": safe_bool(settings.get("RequireAllImages"), True),
        "MaxImages": max(1, min(safe_int(settings.get("MaxImages"), 30), 100)),
        "AIAutoGenerate": safe_bool(settings.get("AIAutoGenerate"), True),
        "AIProvider": normalize_text(settings.get("AIProvider")).lower() or DEFAULT_AI_PROVIDER,
        "AIModel": normalize_text(settings.get("AIModel")) or DEFAULT_AI_MODEL,
        "AIBaseUrl": normalize_text(settings.get("AIBaseUrl")),
        "AIKeyEnv": normalize_text(settings.get("AIKeyEnv")) or "GROQ_API_KEY",
        "AIJsonRepairEnabled": safe_bool(settings.get("AIJsonRepairEnabled"), True),
        "ArabicCopyStyle": normalize_text(settings.get("ArabicCopyStyle")) or "sales-natural",
        "OfficialResearchOnRegenerate": safe_bool(settings.get("OfficialResearchOnRegenerate"), True),
        "DownloadSelectedImagesOnly": safe_bool(settings.get("DownloadSelectedImagesOnly"), False),
    }


def normalize_image_format(value):
    """Arabic: فرض JPEG عند استقبال WebP لأن المتجر الحالي لا يدعمه. English: Force JPEG when WebP is requested because the current store rejects it."""
    aliases = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "jpeg"}
    return aliases.get(normalize_text(value).lower(), "jpeg")


def strip_existing_image_transform(url):
    """Arabic: إزالة تحويل imageMogr2 القديم فقط. English: Remove only an existing imageMogr2 transform."""
    url = normalize_text(url).replace("\\/", "/")
    if not url or "?" not in url:
        return url
    base, query = url.split("?", 1)
    parts = [part for part in query.split("&") if part and not part.lower().startswith("imagemogr2")]
    return f"{base}?{'&'.join(parts)}" if parts else base


def build_optimized_image_url(raw_url, settings):
    """Arabic: طلب نسخة JPEG مصغرة من CDN قبل تنزيلها لتقليل الإنترنت. English: Request a smaller JPEG from the CDN before download to reduce bandwidth."""
    source_url = strip_existing_image_transform(raw_url)
    if not settings["OptimizeImageAtSource"]:
        return source_url
    try:
        parsed = urlsplit(source_url)
    except ValueError:
        return source_url
    if parsed.hostname not in {"xcimg.szwego.com", "img.szwego.com"}:
        return source_url
    transform = (
        f"imageMogr2/thumbnail/{settings['ImageMaxDimension']}x{settings['ImageMaxDimension']}>"
        f"/quality/{settings['ImageQuality']}/format/{normalize_image_format(settings['ImageFormat'])}"
    )
    query = f"{parsed.query}&{transform}" if parsed.query else transform
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def prepare_image_for_save(content, output_path, settings):
    """Arabic: تصغير الصورة وحفظها بصيغة يقبلها المتجر. English: Resize and save an image in a store-compatible format."""
    output_format = normalize_image_format(settings["ImageFormat"])
    with Image.open(BytesIO(content)) as source_image:
        source_image = ImageOps.exif_transpose(source_image)
        source_image.thumbnail(
            (settings["ImageMaxDimension"], settings["ImageMaxDimension"]),
            Image.Resampling.LANCZOS,
        )
        if output_format == "png":
            if source_image.mode not in {"RGB", "RGBA"}:
                source_image = source_image.convert("RGBA" if "transparency" in source_image.info else "RGB")
            source_image.save(output_path, "PNG", optimize=True, compress_level=9)
            return
        if source_image.mode in {"RGBA", "LA"} or (source_image.mode == "P" and "transparency" in source_image.info):
            rgba = source_image.convert("RGBA")
            background = Image.new("RGB", rgba.size, "white")
            background.paste(rgba, mask=rgba.getchannel("A"))
            source_image = background
        else:
            source_image = source_image.convert("RGB")
        source_image.save(
            output_path,
            "JPEG",
            quality=settings["ImageQuality"],
            optimize=True,
            progressive=True,
        )


def download_single_image(session, raw_url, output_path, settings, image_number):
    """Arabic: تنزيل صورة مع ثلاث محاولات والرجوع للرابط الأصلي. English: Download one image with retries and original-URL fallback."""
    optimized_url = build_optimized_image_url(raw_url, settings)
    original_url = strip_existing_image_transform(raw_url)
    candidate_urls = [optimized_url] + ([original_url] if optimized_url != original_url else [])
    last_error = "Unknown download error"
    for candidate_index, candidate_url in enumerate(candidate_urls):
        for attempt in range(1, 4):
            try:
                response = session.get(candidate_url, timeout=(10, 30), stream=True)
                response.raise_for_status()
                content = response.content
                if not content:
                    raise ValueError("The image response was empty")
                prepare_image_for_save(content, output_path, settings)
                logger.info(
                    "Image %s downloaded (%s bytes, source=%s, attempt=%s)",
                    image_number,
                    len(content),
                    "optimized" if candidate_index == 0 and optimized_url != original_url else "original",
                    attempt,
                )
                return len(content), candidate_url
            except Exception as exc:
                last_error = str(exc)
                logger.warning("Image %s download attempt %s failed: %s", image_number, attempt, exc)
                time.sleep(min(attempt, 2))
    raise RuntimeError(last_error)


def json_cell(value):
    """Arabic: تحويل القوائم إلى JSON مضغوط مناسب لخلايا Excel. English: Serialize lists as compact JSON for Excel cells."""
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def build_size_variant_fields(sizes, price, stock, settings):
    """Arabic: إنشاء المقاسات بنفس السعر ونفس الكمية لكل مقاس. English: Build size variants with identical price and stock for every size."""
    normalized_sizes = unique_text_values(sizes)
    if not normalized_sizes:
        return "[]", "[]", "[]", settings["Stock"]
    price_value = safe_float(price, 0)
    if price_value.is_integer():
        price_value = int(price_value)
    variations = [
        {"type": size, "price": price_value, "stock": settings["Stock"]}
        for size in normalized_sizes
    ]
    attribute_id = str(settings["SizeAttributeId"])
    choice_options = [
        {
            "name": f"choice_{attribute_id}",
            "title": settings["SizeTitle"],
            "options": normalized_sizes,
        }
    ]
    attributes = [attribute_id]
    total_stock = settings["Stock"] * len(normalized_sizes)
    return json_cell(variations), json_cell(choice_options), json_cell(attributes), total_stock


def create_temp_excel(new_row, token):
    """Arabic: إنشاء نسخة Excel مؤقتة قبل اعتماد المعاملة. English: Create a temporary Excel copy before committing the transaction."""
    directory = os.path.dirname(EXCEL_PATH)
    os.makedirs(directory, exist_ok=True)
    temp_path = os.path.join(directory, f".{os.path.basename(EXCEL_PATH)}.{token}.xlsx")
    if os.path.exists(EXCEL_PATH):
        dataframe = pd.read_excel(EXCEL_PATH)
    else:
        dataframe = pd.DataFrame(columns=EXCEL_COLUMNS)
    for column in EXCEL_COLUMNS:
        if column not in dataframe.columns:
            dataframe[column] = None
    dataframe = dataframe[EXCEL_COLUMNS]
    dataframe = pd.concat([dataframe, pd.DataFrame([{column: new_row.get(column) for column in EXCEL_COLUMNS}])], ignore_index=True)
    dataframe.to_excel(temp_path, index=False)
    return temp_path


def commit_transaction(temp_product_folder, final_product_folder, temp_excel, temp_archive, token):
    """Arabic: اعتماد الصور وExcel والأرشيف كوحدة قابلة للتراجع. English: Commit images, Excel, and archive as a rollback-capable transaction."""
    targets = [EXCEL_PATH, ARCHIVE_PATH]
    temp_files = [temp_excel, temp_archive]
    backups = {}
    existed_before = {target: os.path.exists(target) for target in targets}
    final_folder_created = False
    try:
        if os.path.exists(final_product_folder):
            raise FileExistsError(f"Product folder already exists: {final_product_folder}")
        for target in targets:
            if existed_before[target]:
                backup_path = f"{target}.{token}.bak"
                shutil.copy2(target, backup_path)
                backups[target] = backup_path
        os.replace(temp_product_folder, final_product_folder)
        final_folder_created = True
        for temp_path, target in zip(temp_files, targets):
            os.replace(temp_path, target)
    except Exception:
        logger.exception("Transaction failed. Starting rollback.")
        for target in reversed(targets):
            backup_path = backups.get(target)
            try:
                if backup_path and os.path.exists(backup_path):
                    os.replace(backup_path, target)
                elif not existed_before[target] and os.path.exists(target):
                    os.remove(target)
            except OSError as rollback_error:
                logger.error("Could not roll back %s: %s", target, rollback_error)
        if final_folder_created and os.path.isdir(final_product_folder):
            shutil.rmtree(final_product_folder, ignore_errors=True)
        raise
    finally:
        for backup_path in backups.values():
            if os.path.exists(backup_path):
                os.remove(backup_path)
        for temp_path in temp_files:
            if os.path.exists(temp_path):
                os.remove(temp_path)


def canonicalize_brand_name(value):
    """Arabic: توحيد اسم البراند دون قبول نصوص طويلة كاسم براند. English: Canonicalize a brand without accepting long product text as a brand name."""
    brand = re.sub(r"\s+", " ", normalize_text(value)).strip(" -–—|,.;:")
    if not brand or len(brand) > 80:
        return ""
    if re.search(r"\b(?:air\s+jordan|jordan\s+brand|jordan\s*\d+|aj\s*\d+)\b", brand, re.I) or brand.casefold() == "jordan":
        return "Air Jordan"
    if re.search(r"\bnike\b", brand, re.I):
        return "Nike"
    if re.search(r"\badidas\b", brand, re.I):
        return "Adidas"
    if re.search(r"\bnew\s+balance\b", brand, re.I):
        return "New Balance"
    if re.search(r"\bpuma\b", brand, re.I):
        return "Puma"
    if re.search(r"\bconverse\b", brand, re.I):
        return "Converse"
    if re.search(r"\bvans\b", brand, re.I):
        return "Vans"
    if re.search(r"\basics\b", brand, re.I):
        return "ASICS"
    if re.search(r"\breebok\b", brand, re.I):
        return "Reebok"
    if re.search(r"\bunder\s+armour\b", brand, re.I):
        return "Under Armour"
    return brand


def parse_brand_map_json(value):
    """Arabic: قراءة خريطة البراندات الآمنة من الإعدادات. English: Parse the configured allow-list brand map safely."""
    try:
        parsed = json.loads(normalize_text(value) or "{}")
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    result = {}
    for raw_name, raw_id in parsed.items():
        name = canonicalize_brand_name(raw_name)
        brand_id = safe_int(raw_id, 0)
        if name and brand_id > 0:
            result[name] = brand_id
    return result


def normalize_allowed_brands(values, configured_brand=""):
    """Arabic: بناء قائمة براندات مسموحة فقط. English: Build a strict allow-list of configured brands."""
    result = []
    seen = set()
    for value in list(values or []) + [configured_brand]:
        brand = canonicalize_brand_name(value)
        key = brand.casefold()
        if brand and key not in seen:
            seen.add(key)
            result.append(brand)
    return result


def detect_allowed_brand_from_text(text, allowed_brands):
    """Arabic: اكتشاف البراند من الدليل النصي ضمن القائمة المسموحة فقط. English: Detect a brand from evidence only when it is in the allow-list."""
    evidence = normalize_text(text)
    for brand in allowed_brands or []:
        canonical = canonicalize_brand_name(brand)
        if canonical == "Air Jordan":
            pattern = r"\b(?:air\s+jordan|jordan\s*\d+|aj\s*\d+)\b"
        else:
            pattern = rf"\b{re.escape(canonical)}\b"
        if re.search(pattern, evidence, re.I):
            return canonical
    return ""


def resolve_allowed_brand(generated_brand, configured_brand, allowed_brands, evidence_text=""):
    """Arabic: رفض أي براند يولده النموذج إذا لم يكن موجوداً في خريطة المتجر. English: Reject model-generated brands that are absent from the store allow-list."""
    allowed = normalize_allowed_brands(allowed_brands, configured_brand)
    generated = canonicalize_brand_name(generated_brand)
    configured = canonicalize_brand_name(configured_brand)

    for allowed_brand in allowed:
        if generated and generated.casefold() == allowed_brand.casefold():
            return allowed_brand

    detected = detect_allowed_brand_from_text(evidence_text, allowed)
    if detected:
        return detected

    for allowed_brand in allowed:
        if configured and configured.casefold() == allowed_brand.casefold():
            return allowed_brand

    return allowed[0] if allowed else configured or generated


def enforce_product_name_rules(name, source_text, style_code, brand_name=""):
    """Arabic: توحيد البراند مرة واحدة وإضافة الكود مرة واحدة. English: Keep the selected brand and style code exactly once."""
    final_name = re.sub(r"\s+", " ", normalize_text(name)).strip(" -–—|")
    exact_style_code = normalize_text(style_code).upper()
    selected_brand = canonicalize_brand_name(brand_name)
    evidence = f"{normalize_text(source_text)} {final_name}"

    if selected_brand == "Air Jordan" or re.search(r"\b(?:air\s+jordan|jordan\s+brand|jordan\s*\d+|aj\s*\d+)\b", evidence, re.I):
        # Arabic: توحيد جميع صيغ البراند ثم حذف كل تكراراته وإضافته مرة واحدة في البداية.
        # English: Normalize all brand aliases, remove every duplicate, and prefix it exactly once.
        final_name = re.sub(r"(?<!Air )\b(?:Nike\s+)?Jordan(?=\s*\d)", "Air Jordan", final_name, flags=re.I)
        final_name = re.sub(r"\bAJ\s*(?=\d)", "Air Jordan ", final_name, flags=re.I)
        final_name = re.sub(r"\bJordan\s+Brand\b", "Air Jordan", final_name, flags=re.I)
        final_name = re.sub(r"\bAir\s+Jordan\b", " ", final_name, flags=re.I)
        final_name = re.sub(r"\s+", " ", final_name).strip(" -–—|")
        final_name = f"Air Jordan {final_name}".strip()
        final_name = re.sub(r"^Air\s+Jordan\s+(\d+)\s+\1\b", r"Air Jordan \1", final_name, flags=re.I)
    elif selected_brand:
        escaped = re.escape(selected_brand)
        final_name = re.sub(rf"\b{escaped}\b", " ", final_name, flags=re.I)
        final_name = re.sub(r"\s+", " ", final_name).strip(" -–—|")
        final_name = f"{selected_brand} {final_name}".strip()

    if exact_style_code:
        final_name = re.sub(
            rf"\s*[-–—|]?\s*{re.escape(exact_style_code)}\b",
            "",
            final_name,
            flags=re.I,
        ).strip(" -–—|")
        final_name = f"{final_name} - {exact_style_code}"

    return re.sub(r"\s+", " ", final_name).strip()[:190]


def enforce_arabic_product_name(name, source_text, style_code, brand_name=""):
    """Arabic: منع تكرار البراند في الاسم العربي وتنسيق الارتفاع والكود. English: Prevent duplicated Arabic branding and normalize silhouette/style code."""
    final_name = re.sub(r"\s+", " ", normalize_text(name)).strip(" -–—|")
    exact_style_code = normalize_text(style_code).upper()
    selected_brand = canonicalize_brand_name(brand_name)

    final_name = re.sub(r"\bAir\s+Jordan\b", "إير جوردن", final_name, flags=re.I)
    final_name = re.sub(r"\bJordan(?=\s*\d)", "إير جوردن", final_name, flags=re.I)
    final_name = re.sub(r"\bAJ\s*(?=\d)", "إير جوردن ", final_name, flags=re.I)
    final_name = re.sub(r"(?:إير\s+جوردن\s*){2,}", "إير جوردن ", final_name)

    final_name = re.sub(r"\bLow(?:-Top)?\b", "منخفض", final_name, flags=re.I)
    final_name = re.sub(r"(?<![\u0600-\u06FF])لو(?![\u0600-\u06FF])", "منخفض", final_name)
    final_name = re.sub(r"\bMid(?:-Top)?\b", "متوسط الارتفاع", final_name, flags=re.I)
    final_name = re.sub(r"\bHigh(?:-Top)?\b", "مرتفع", final_name, flags=re.I)

    final_name = re.sub(r"^حذاء\s+", "", final_name).strip()

    if selected_brand == "Air Jordan":
        final_name = re.sub(r"(?:إير\s+جوردن\s*)+", "", final_name).strip()
        final_name = f"حذاء إير جوردن {final_name}".strip()
        final_name = re.sub(r"^حذاء\s+إير\s+جوردن\s+(\d+)\s+\1\b", r"حذاء إير جوردن \1", final_name)
    else:
        final_name = f"حذاء {final_name}".strip()

    if exact_style_code:
        final_name = re.sub(
            rf"\s*[-–—|]?\s*{re.escape(exact_style_code)}\b",
            "",
            final_name,
            flags=re.I,
        ).strip(" -–—|")
        final_name = f"{final_name} - {exact_style_code}"

    return re.sub(r"\s+", " ", final_name).strip()[:210]

def ai_cache_key(style_code, source_text, model):
    """Arabic: إنشاء مفتاح Cache يتغير عند تعديل نسخة التعليمات. English: Build a cache key that changes with prompt version."""
    raw = "|".join([
        AI_PROMPT_VERSION,
        normalize_text(style_code).upper(),
        normalize_text(model),
        normalize_text(source_text),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_pending_product(product_id, archive_item):
    """Arabic: تجهيز حزمة تعبئة لوحة Sooqify. English: Build the package consumed by the Sooqify form autofill script."""
    all_image_names = archive_item.get("images") or []
    store_image_names = archive_item.get("store_images") or all_image_names[:6]
    return {
        "local_id": product_id,
        "name_en": archive_item.get("name_en") or archive_item.get("name"),
        "description_en": archive_item.get("description_en") or archive_item.get("description"),
        "name_ar": archive_item.get("name_ar") or archive_item.get("name_en") or archive_item.get("name"),
        "description_ar": archive_item.get("description_ar") or archive_item.get("description_en") or archive_item.get("description"),
        "brand_name": archive_item.get("brand_name"),
        "brand_id": archive_item.get("brand_id"),
        "price": archive_item.get("price"),
        "sizes": archive_item.get("sizes") or [],
        "settings": archive_item.get("settings") or {},
        "style_code": archive_item.get("style_code"),
        "search_code": archive_item.get("search_code"),
        "supplier_store_name": archive_item.get("supplier_store_name"),
        "supplier_store_id": archive_item.get("supplier_store_id"),
        "image_files": [
            {
                "name": image_name,
                "url": f"http://127.0.0.1:5000/api/product-images/{product_id}/{image_name}",
            }
            for image_name in store_image_names
        ],
        "all_image_files": [
            {
                "name": image_name,
                "url": f"http://127.0.0.1:5000/api/product-images/{product_id}/{image_name}",
            }
            for image_name in all_image_names
        ],
        "store_main_image": archive_item.get("store_main_image") or (store_image_names[0] if store_image_names else ""),
        "created_at": archive_item.get("created_at"),
        "workflow_status": archive_item.get("workflow_status") or "prepared",
        "store_submission_status": archive_item.get("store_submission_status") or "not_submitted",
    }



def find_archive_key_by_id(archive, product_id):
    """Arabic: العثور على مفتاح سجل المنتج بواسطة ID. English: Find the archive key for a local product ID."""
    wanted_id = safe_int(product_id, -1)
    for key, item in archive_entries(archive).items():
        if safe_int(item.get("id"), -2) == wanted_id:
            return key
    return None


def rebuild_archive_metadata(archive):
    """Arabic: إعادة حساب ميتاداتا آخر ID وآخر Search Code بعد الحذف. English: Recalculate archive metadata after deletions."""
    cleaned = {key: value for key, value in archive.items() if not str(key).startswith("_")}
    entries = archive_entries(cleaned)
    if not entries:
        return cleaned
    ordered = sorted(entries.values(), key=lambda item: safe_int(item.get("id"), 0))
    latest = ordered[-1]
    cleaned["_last_added_id"] = safe_int(latest.get("id"), 0)
    latest_code = normalize_text(latest.get("search_code"))
    if is_valid_marker(latest_code):
        cleaned["_last_added_code"] = latest_code
    return cleaned


def create_filtered_excel_temp(product_ids, token, clear_all=False):
    """Arabic: إنشاء ملف Excel مؤقت بعد حذف صفوف IDs المحددة. English: Build a temporary Excel file with selected IDs removed."""
    directory = os.path.dirname(EXCEL_PATH)
    os.makedirs(directory, exist_ok=True)
    temp_path = os.path.join(directory, f".{os.path.basename(EXCEL_PATH)}.{token}.xlsx")
    if os.path.exists(EXCEL_PATH):
        dataframe = pd.read_excel(EXCEL_PATH)
    else:
        dataframe = pd.DataFrame(columns=EXCEL_COLUMNS)
    for column in EXCEL_COLUMNS:
        if column not in dataframe.columns:
            dataframe[column] = None
    dataframe = dataframe[EXCEL_COLUMNS]
    if clear_all:
        dataframe = dataframe.iloc[0:0]
    elif "Id" in dataframe.columns:
        wanted = {safe_int(value, -1) for value in product_ids}
        dataframe = dataframe[~dataframe["Id"].apply(lambda value: safe_int(value, -2) in wanted)]
    dataframe.to_excel(temp_path, index=False)
    return temp_path


def commit_archive_excel(temp_archive, temp_excel, token):
    """Arabic: اعتماد تحديث الأرشيف وExcel مع نسخ احتياطية قابلة للتراجع. English: Commit archive and Excel updates with rollback backups."""
    targets = [ARCHIVE_PATH, EXCEL_PATH]
    temps = [temp_archive, temp_excel]
    backups = {}
    existed_before = {target: os.path.exists(target) for target in targets}
    try:
        for target in targets:
            if existed_before[target]:
                backup = f"{target}.{token}.bak"
                shutil.copy2(target, backup)
                backups[target] = backup
        for temp_path, target in zip(temps, targets):
            os.replace(temp_path, target)
    except Exception:
        logger.exception("Archive/Excel update failed. Starting rollback.")
        for target in reversed(targets):
            backup = backups.get(target)
            try:
                if backup and os.path.exists(backup):
                    os.replace(backup, target)
                elif not existed_before[target] and os.path.exists(target):
                    os.remove(target)
            except OSError as rollback_error:
                logger.error("Could not roll back %s: %s", target, rollback_error)
        raise
    finally:
        for backup in backups.values():
            if os.path.exists(backup):
                os.remove(backup)
        for temp_path in temps:
            if os.path.exists(temp_path):
                os.remove(temp_path)


def delete_product_folder(product):
    """Arabic: حذف مجلد صور منتج واحد بأمان داخل BASE_DIR فقط. English: Safely remove one product image folder within BASE_DIR."""
    folder_name = normalize_text(product.get("folder"))
    if not folder_name:
        return False
    base_real = os.path.realpath(BASE_DIR)
    folder_real = os.path.realpath(os.path.join(BASE_DIR, folder_name))
    if os.path.commonpath([base_real, folder_real]) != base_real:
        raise ValueError("Refusing to delete a folder outside the configured image directory.")
    if os.path.isdir(folder_real):
        shutil.rmtree(folder_real)
        return True
    return False


def update_product_workflow_status(product_id, workflow_status, details=None):
    """Arabic: تحديث حالة تجهيز/إرسال المنتج داخل الأرشيف. English: Update the archived product preparation/submission status."""
    allowed = {"prepared", "submit_started", "submitted", "submit_failed"}
    status = normalize_text(workflow_status).lower()
    if status not in allowed:
        raise ValueError(f"Unsupported workflow status: {status}")
    with SAVE_LOCK:
        archive = load_archive()
        key = find_archive_key_by_id(archive, product_id)
        if not key:
            return None
        updated = dict(archive)
        item = dict(updated[key])
        item["workflow_status"] = status
        item["store_submission_status"] = status
        item["workflow_updated_at"] = datetime.now().isoformat(timespec="seconds")
        if details:
            item["workflow_details"] = sanitize_log_value(details)
        updated[key] = item
        save_json_atomic(ARCHIVE_PATH, updated)
        return item


@app.route("/api/health", methods=["GET"])
def health_check():
    """Arabic: فحص حالة الخادم ومفاتيح مزودي الذكاء الاصطناعي. English: Report server and configured AI-provider keys."""
    default_provider = normalize_text(os.getenv("ALPHACODE_AI_PROVIDER", DEFAULT_AI_PROVIDER)).lower()
    provider_keys = {
        "groq": bool(os.getenv("GROQ_API_KEY")),
        "openai": bool(os.getenv("OPENAI_API_KEY")),
        "custom": bool(os.getenv(os.getenv("ALPHACODE_AI_KEY_ENV", "ALPHACODE_AI_API_KEY"))),
    }
    default_model = (
        os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
        if default_provider == "openai"
        else os.getenv("GROQ_MODEL", DEFAULT_AI_MODEL)
    )
    return jsonify({
        "success": True,
        "service": "AlphaCode Extractor",
        "version": "4.4.0",
        "ai_provider": default_provider,
        "ai_configured": provider_keys.get(default_provider, False),
        "ai_providers": provider_keys,
        "default_ai_model": default_model,
    })


@app.route("/api/log/client", methods=["POST"])
def record_client_log():
    """Arabic: تسجيل أخطاء وأحداث الإضافة في ملف Python الخارجي. English: Record extension errors and events in the external Python log."""
    data = request.get_json(silent=True) or {}
    level_name = normalize_text(data.get("level")).upper() or "INFO"
    event_name = normalize_text(data.get("event")) or "client_event"
    message = normalize_text(data.get("message")) or "No message"
    details = sanitize_log_value(data.get("details") or {})
    level = getattr(logging, level_name, logging.INFO)
    logger.log(level, "CLIENT | event=%s | message=%s | details=%s", event_name, message, json.dumps(details, ensure_ascii=False))
    return jsonify({"success": True})


@app.route("/api/logs/recent", methods=["GET"])
def get_recent_logs():
    """Arabic: إعادة آخر أسطر السجل للوحة التشخيص. English: Return recent external log lines to the diagnostics tab."""
    return jsonify({
        "success": True,
        "log_path": LOG_PATH,
        "lines": read_recent_log_lines(request.args.get("lines", 200)),
    })


@app.route("/api/logs/download", methods=["GET"])
def download_application_log():
    """Arabic: تنزيل ملف السجل الخارجي من لوحة الإضافة. English: Download the external application log from the popup."""
    if not os.path.exists(LOG_PATH):
        return jsonify({"success": False, "error": "The log file does not exist yet."}), 404
    return send_file(LOG_PATH, as_attachment=True, download_name="alphacode.log")


@app.after_request
def log_failed_http_responses(response):
    """Arabic: تسجيل طلبات HTTP الفاشلة لتسهيل التشخيص. English: Log failed HTTP responses for easier diagnostics."""
    if response.status_code >= 400:
        logger.warning("HTTP %s %s -> %s", request.method, request.path, response.status_code)
    return response


@app.route("/api/check", methods=["POST"])
def check_product():
    """Arabic: فحص وجود المنتج في الأرشيف قبل التنزيل. English: Check the archive for a duplicate before downloading."""
    data = request.get_json(silent=True) or {}
    archive = load_archive()
    existing = find_existing_product(archive, data.get("SearchCode"), data.get("StyleCode"))
    entries = archive_entries(archive)
    response = {
        "exists": bool(existing),
        "last_id": max([safe_int(item.get("id"), 0) for item in entries.values()] or [0]),
        "last_added_code": archive.get("_last_added_code"),
    }
    if existing:
        response["id"] = existing.get("id")
        response["workflow_status"] = existing.get("workflow_status") or "prepared"
        response["store_submission_status"] = existing.get("store_submission_status") or "not_submitted"
        response["image_count"] = len(existing.get("images") or [])
        response["supplier_store_name"] = existing.get("supplier_store_name")
    return jsonify(response)


@app.route("/api/archive/product/<int:product_id>", methods=["GET"])
def get_archived_product(product_id):
    """Arabic: استرجاع بيانات المنتج والمتجر المورد بواسطة ID. English: Retrieve product and supplier-store data by local ID."""
    product = find_product_by_id(load_archive(), product_id)
    if not product:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    return jsonify({"success": True, "product": product})



@app.route("/api/archive/last", methods=["GET"])
def get_last_archived_product():
    """Arabic: إعادة آخر منتج أُضيف مع رابط المورد وكود البحث. English: Return the last added product with its supplier URL and search code."""
    archive = load_archive()
    entries = list(archive_entries(archive).values())
    if not entries:
        return jsonify({"success": False, "error": "No archived product is available."}), 404

    product = max(entries, key=lambda item: safe_int(item.get("id"), 0))
    return jsonify({
        "success": True,
        "product": {
            "id": safe_int(product.get("id"), 0),
            "search_code": normalize_text(product.get("search_code")),
            "style_code": normalize_text(product.get("style_code")),
            "source_url": normalize_text(product.get("source_url")),
            "name_en": normalize_text(product.get("name_en") or product.get("name")),
            "workflow_status": normalize_text(product.get("workflow_status")) or "prepared",
            "store_submission_status": normalize_text(product.get("store_submission_status")) or "not_submitted",
        },
    })


@app.route("/api/archive/stats", methods=["GET"])
def get_archive_stats():
    """Arabic: إحصاءات مختصرة لإدارة بيانات الأرشيف. English: Return archive statistics for data-management controls."""
    archive = load_archive()
    entries = archive_entries(archive)
    image_count = sum(len(item.get("images") or []) for item in entries.values())
    return jsonify({
        "success": True,
        "products": len(entries),
        "images": image_count,
        "last_id": max([safe_int(item.get("id"), 0) for item in entries.values()] or [0]),
        "archive_path": ARCHIVE_PATH,
        "excel_path": EXCEL_PATH,
        "image_root": BASE_DIR,
    })


@app.route("/api/pending/latest", methods=["GET"])
def get_latest_pending_product():
    """Arabic: إعادة آخر منتج مجهز حتى لو تعطل سياق الإضافة في صفحة المورد. English: Return the latest prepared product even when the source-page extension context was reloaded."""
    archive = load_archive()
    entries = list(archive_entries(archive).values())
    if not entries:
        return jsonify({"success": False, "error": "No prepared product is available."}), 404
    product = max(entries, key=lambda item: safe_int(item.get("id"), 0))
    product_id = safe_int(product.get("id"), 0)
    return jsonify({"success": True, "pending_product": build_pending_product(product_id, product)})


@app.route("/api/archive/product/<int:product_id>/status", methods=["POST"])
def set_archived_product_status(product_id):
    """Arabic: تحديث حالة المنتج عند بدء أو نجاح الإرسال إلى المتجر. English: Update product status when store submission starts or completes."""
    data = request.get_json(silent=True) or {}
    try:
        item = update_product_workflow_status(product_id, data.get("status"), data.get("details"))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    if not item:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    logger.info("Product workflow status updated. id=%s status=%s", product_id, item.get("workflow_status"))
    return jsonify({"success": True, "product": item})


@app.route("/api/archive/product/<int:product_id>", methods=["DELETE"])
def delete_archived_product(product_id):
    """Arabic: حذف سجل واحد من JSON وExcel مع خيار حذف صوره. English: Delete one product from JSON and Excel with optional image removal."""
    data = request.get_json(silent=True) or {}
    delete_images = safe_bool(data.get("delete_images"), False)
    with SAVE_LOCK:
        archive = load_archive()
        key = find_archive_key_by_id(archive, product_id)
        if not key:
            return jsonify({"success": False, "error": "Product ID was not found."}), 404
        product = archive[key]
        updated = dict(archive)
        updated.pop(key, None)
        updated = rebuild_archive_metadata(updated)
        token = uuid.uuid4().hex
        temp_archive = write_json_temp(ARCHIVE_PATH, updated, token)
        temp_excel = create_filtered_excel_temp([product_id], token)
        try:
            commit_archive_excel(temp_archive, temp_excel, token)
            images_deleted = delete_product_folder(product) if delete_images else False
            logger.info(
                "Product deleted. id=%s delete_images=%s images_deleted=%s",
                product_id, delete_images, images_deleted,
            )
            return jsonify({
                "success": True,
                "id": product_id,
                "delete_images": delete_images,
                "images_deleted": images_deleted,
            })
        except Exception as exc:
            logger.exception("Could not delete product id=%s: %s", product_id, exc)
            return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/archive/clear", methods=["POST"])
def clear_archive_data():
    """Arabic: مسح جميع المنتجات من JSON وExcel مع خيارات الصور وCache. English: Clear all product data with optional image and AI-cache deletion."""
    data = request.get_json(silent=True) or {}
    delete_images = safe_bool(data.get("delete_images"), False)
    clear_ai_cache = safe_bool(data.get("clear_ai_cache"), False)
    with SAVE_LOCK:
        archive = load_archive()
        products = list(archive_entries(archive).values())
        token = uuid.uuid4().hex
        temp_archive = write_json_temp(ARCHIVE_PATH, {}, token)
        temp_excel = create_filtered_excel_temp([], token, clear_all=True)
        try:
            commit_archive_excel(temp_archive, temp_excel, token)
            deleted_folders = 0
            image_errors = []
            if delete_images:
                for product in products:
                    try:
                        if delete_product_folder(product):
                            deleted_folders += 1
                    except Exception as exc:
                        image_errors.append(str(exc))
                        logger.warning("Could not delete product folder during clear: %s", exc)
            if clear_ai_cache and os.path.exists(AI_CACHE_PATH):
                save_json_atomic(AI_CACHE_PATH, {})
            logger.info(
                "Archive cleared. products=%s delete_images=%s deleted_folders=%s clear_ai_cache=%s",
                len(products), delete_images, deleted_folders, clear_ai_cache,
            )
            return jsonify({
                "success": True,
                "products_deleted": len(products),
                "folders_deleted": deleted_folders,
                "image_errors": image_errors,
                "ai_cache_cleared": clear_ai_cache,
            })
        except Exception as exc:
            logger.exception("Could not clear archive: %s", exc)
            return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/pending/<int:product_id>", methods=["GET"])
def get_pending_product(product_id):
    """Arabic: إعادة حزمة التعبئة المباشرة للوحة المتجر. English: Return the direct store-form autofill package."""
    product = find_product_by_id(load_archive(), product_id)
    if not product:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    return jsonify({"success": True, "pending_product": build_pending_product(product_id, product)})


@app.route("/api/product-images/<int:product_id>/<path:filename>", methods=["GET"])
def serve_product_image(product_id, filename):
    """Arabic: تقديم صورة محلية للإضافة دون كشف مسار القرص. English: Serve a local image to the extension without exposing disk paths."""
    product = find_product_by_id(load_archive(), product_id)
    if not product:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    safe_filename = os.path.basename(filename)
    if safe_filename not in (product.get("images") or []):
        return jsonify({"success": False, "error": "Image is not registered for this product."}), 404
    folder_path = os.path.join(BASE_DIR, normalize_text(product.get("folder")))
    return send_from_directory(folder_path, safe_filename, as_attachment=False)



def resolve_official_store_domains(brand_name, source_text=""):
    """Arabic: تحديد نطاق الموقع الرسمي حسب البراند. English: Resolve the official company domain for the detected brand."""
    combined = f"{normalize_text(brand_name)} {normalize_text(source_text)}".lower()
    mappings = [
        (("air jordan", "jordan ", "aj1", "aj 1", "nike"), ["nike.com"]),
        (("adidas",), ["adidas.com"]),
        (("new balance",), ["newbalance.com"]),
        (("puma",), ["puma.com"]),
        (("converse",), ["converse.com"]),
        (("vans",), ["vans.com"]),
        (("asics",), ["asics.com"]),
        (("reebok",), ["reebok.com"]),
        (("under armour",), ["underarmour.com"]),
    ]
    for keywords, domains in mappings:
        if any(keyword in combined for keyword in keywords):
            return domains
    return []


def extract_first_json_object(raw_text):
    """Arabic: استخراج أول كائن JSON متوازن من أي استجابة نصية. English: Extract the first balanced JSON object from any text response."""
    text = normalize_text(raw_text)
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I).strip()
    if not text:
        raise ValueError("The AI provider returned an empty response.")

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    if start < 0:
        raise ValueError("The AI provider did not return a JSON object.")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        character = text[index]
        if escaped:
            escaped = False
            continue
        if character == "\\" and in_string:
            escaped = True
            continue
        if character == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:index + 1])

    raise ValueError("The AI provider returned an incomplete JSON object.")


def read_retry_after_seconds(response):
    """Arabic: قراءة مدة انتظار Rate Limit دون إعادة الطلب. English: Read the rate-limit wait duration without retrying the request."""
    retry_after = normalize_text(response.headers.get("Retry-After"))
    try:
        return max(0, int(float(retry_after)))
    except (TypeError, ValueError):
        pass
    try:
        message = normalize_text(response.json().get("error", {}).get("message"))
    except Exception:
        message = normalize_text(response.text)
    match = re.search(r"try again in\s*([0-9.]+)s", message, re.I)
    return int(float(match.group(1))) + 1 if match else 0


def validate_generated_copy(generated):
    """Arabic: التأكد من اكتمال حقول المحتوى قبل اعتمادها. English: Validate required generated-copy fields."""
    if not isinstance(generated, dict):
        raise ValueError("The AI response is not a JSON object.")
    required = ["name_en", "description_en", "name_ar", "description_ar", "brand_name"]
    missing = [field for field in required if not normalize_text(generated.get(field))]
    if missing:
        raise ValueError("The AI response is missing fields: " + ", ".join(missing))
    return generated


def product_copy_schema():
    """Arabic: مخطط موحد لمخرجات المحتوى. English: Return the canonical product-copy JSON schema."""
    return {
        "type": "object",
        "properties": {
            "name_en": {"type": "string"},
            "description_en": {"type": "string"},
            "name_ar": {"type": "string"},
            "description_ar": {"type": "string"},
            "brand_name": {"type": "string"},
        },
        "required": ["name_en", "description_en", "name_ar", "description_ar", "brand_name"],
        "additionalProperties": False,
    }


def normalize_ai_provider(value):
    """Arabic: توحيد اسم المزود إلى Groq أو OpenAI أو Custom. English: Normalize the provider name to groq, openai, or custom."""
    provider = normalize_text(value).lower()
    return provider if provider in {"groq", "openai", "custom"} else DEFAULT_AI_PROVIDER


def resolve_ai_runtime(data):
    """Arabic: تحديد الرابط والنموذج ومتغير المفتاح دون تخزين السر داخل الإضافة. English: Resolve endpoint, model, and key environment without storing secrets in the extension."""
    provider = normalize_ai_provider(data.get("AIProvider") or os.getenv("ALPHACODE_AI_PROVIDER"))
    requested_model = normalize_text(data.get("AIModel"))
    requested_base = normalize_text(data.get("AIBaseUrl"))
    requested_key_env = normalize_text(data.get("AIKeyEnv"))

    if provider == "openai":
        endpoint = requested_base or OPENAI_RESPONSES_URL
        key_env = (
            "OPENAI_API_KEY"
            if not requested_key_env or requested_key_env == "GROQ_API_KEY"
            else requested_key_env
        )
        if requested_model and "gpt-oss" not in requested_model.lower():
            model = requested_model
        else:
            model = os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
        api_mode = "responses"
    elif provider == "custom":
        endpoint = requested_base or os.getenv("ALPHACODE_AI_BASE_URL", "")
        key_env = requested_key_env or os.getenv("ALPHACODE_AI_KEY_ENV", "ALPHACODE_AI_API_KEY")
        model = requested_model or os.getenv("ALPHACODE_AI_MODEL", "")
        api_mode = "responses" if endpoint.rstrip("/").endswith("/responses") else "chat"
        if not endpoint:
            raise ValueError("AIBaseUrl is required for the custom provider.")
        if not model:
            raise ValueError("AIModel is required for the custom provider.")
    else:
        endpoint = requested_base or GROQ_CHAT_URL
        key_env = requested_key_env or "GROQ_API_KEY"
        model = requested_model or os.getenv("GROQ_MODEL", DEFAULT_AI_MODEL)
        api_mode = "chat"

    api_key = os.getenv(key_env)
    if not api_key:
        raise ValueError(f"The environment variable {key_env} is not configured on the Python server.")

    return {
        "provider": provider,
        "endpoint": endpoint,
        "key_env": key_env,
        "api_key": api_key,
        "model": model,
        "api_mode": api_mode,
    }


def build_normal_ai_messages(source_text, original_product_name, style_code, search_code, sizes, configured_brand, allowed_brands, arabic_style):
    """Arabic: بناء تعليمات كتابة عادية دون بحث ويب. English: Build normal-generation messages without web research."""
    instructions = f"""
You are a senior footwear e-commerce catalog writer fluent in English and Arabic.
Use only the supplied evidence. Never browse during this first generation and never invent colors, materials, gender, edition, technology, collaboration, authenticity, or performance benefits.

ENGLISH:
- Use the canonical brand and exact model when supported.
- Write a concise title with model, silhouette/type, verified colorway or nickname when present, and the exact Style Code once at the end.
- Write 2–3 factual commercial sentences and mention the available size range in the final sentence.

ARABIC — STYLE: {arabic_style}:
- Create an original Arabic sales title, not a word-for-word translation and not necessarily in the English order.
- Begin with حذاء and write Air Jordan as إير جوردن.
- Lead with the strongest useful verified identity: model, attractive color combination, edition, or silhouette.
- Use natural Arabic suitable for an online store. Avoid awkward transliteration, mixed English filler, and the word لو; use منخفض only when it improves clarity.
- The Arabic description may reorder facts and use a warmer, more persuasive tone than English, but it must remain accurate.
- Never promise comfort, durability, performance, originality, or quality unless explicitly verified.

NEVER include supplier name, Search Code, price, shipping, Chinese text, emojis, replica/authenticity claims, or quality grades.
BRAND SAFETY: brand_name must be one of the ALLOWED BRANDS supplied by the user. Never invent or infer an unlisted brand.
Return exactly one JSON object with: name_en, description_en, name_ar, description_ar, brand_name.
""".strip()

    compact_source = compact_prompt_text(source_text, 3200)
    compact_original = compact_prompt_text(original_product_name, 320)
    compact_sizes = ", ".join(unique_text_values(sizes)[:40])[:300]
    user_input = (
        f"Original supplier name:\n{compact_original or 'Not provided'}\n\n"
        f"Supplier product text:\n{compact_source or 'Not provided'}\n\n"
        f"Exact Style Code: {compact_prompt_text(style_code, 80) or 'Not provided'}\n"
        f"Internal Search Code — never include it: {compact_prompt_text(search_code, 80) or 'Not provided'}\n"
        f"Available sizes: {compact_sizes or 'Not provided'}\n"
        f"Configured brand hint: {compact_prompt_text(configured_brand, 100) or 'Not provided'}\n"
        f"ALLOWED BRANDS: {', '.join(allowed_brands) or configured_brand or 'Not provided'}\n"
        "Write polished bilingual store copy now."
    )
    return [
        {"role": "system", "content": instructions},
        {"role": "user", "content": user_input},
    ]


def build_official_research_prompt(official_domain, original_product_name, style_code):
    """Arabic: برومبت بحث رسمي صغير للمنتج الحالي فقط. English: Build a compact official-domain research prompt for the current product only."""
    return f"""
Search only the official domain {official_domain} for the exact footwear Style Code \"{compact_prompt_text(style_code, 80) or 'Not provided'}\".
Optional supplier name: {compact_prompt_text(original_product_name, 260) or 'Not provided'}
Use one search operation only. Reject mismatched products and all retailers, marketplaces, blogs, social media, and sneaker databases.
Return a factual dossier under 180 words: verification status, canonical brand, exact model/silhouette, official name/edition, colorway, audience, materials, visible design details, footwear type, and uncertainties.
If not found, state NOT FOUND OFFICIALLY. Do not write marketing copy.
""".strip()


def build_official_rewrite_messages(official_research, source_text, original_product_name, style_code, search_code, sizes, configured_brand, allowed_brands, arabic_style):
    """Arabic: بناء صياغة نهائية بعد البحث الرسمي. English: Build final-copy messages after official research."""
    instructions = f"""
You are the final catalog editor for a footwear e-commerce store.
Use official facts first; use supplier facts only when they do not conflict. Omit uncertainty.

ENGLISH: create a precise catalog title and 2–3 factual commercial sentences.

ARABIC — STYLE: {arabic_style}:
- Create a compelling Arabic product identity independently from the English syntax.
- Begin the title with حذاء and use إير جوردن when applicable.
- Highlight the strongest verified reason to notice the product: model, color combination, edition, or design character.
- Use fluent modern Arabic suitable for Gulf e-commerce customers without exaggeration.
- Do not transliterate Low as لو; use منخفض only if useful.
- The Arabic description may use a different sentence order and a warmer selling tone, while keeping all facts verified.
- Avoid generic filler and unsupported claims about comfort, quality, originality, performance, or durability.

Put the exact Style Code once at the end of each title. Never include Search Code, price, supplier name, Chinese text, emojis, or authenticity/grade claims.
BRAND SAFETY: brand_name must be one of the ALLOWED BRANDS supplied by the user. Never invent or infer an unlisted brand.
Return exactly one JSON object with: name_en, description_en, name_ar, description_ar, brand_name.
""".strip()
    compact_sizes = ", ".join(unique_text_values(sizes)[:40])[:300]
    user_input = f"""
OFFICIAL RESEARCH:
{compact_prompt_text(official_research, 1400)}

SUPPLIER NAME:
{compact_prompt_text(original_product_name, 320) or 'Not provided'}

SUPPLIER TEXT:
{compact_prompt_text(source_text, 1200) or 'Not provided'}

STYLE CODE: {compact_prompt_text(style_code, 80) or 'Not provided'}
INTERNAL SEARCH CODE — NEVER INCLUDE: {compact_prompt_text(search_code, 80) or 'Not provided'}
AVAILABLE SIZES: {compact_sizes or 'Not provided'}
BRAND HINT: {compact_prompt_text(configured_brand, 100) or 'Not provided'}
ALLOWED BRANDS: {', '.join(allowed_brands) or configured_brand or 'Not provided'}
""".strip()
    return [
        {"role": "system", "content": instructions},
        {"role": "user", "content": user_input},
    ]


def make_provider_payload(runtime, messages, max_tokens, json_output=True):
    """Arabic: تحويل الرسائل إلى تنسيق المزود المختار. English: Convert messages into the selected provider API format."""
    if runtime["api_mode"] == "responses":
        payload = {
            "model": runtime["model"],
            "input": [
                {
                    "role": message["role"],
                    "content": [{"type": "input_text", "text": message["content"]}],
                }
                for message in messages
            ],
            "max_output_tokens": max_tokens,
            "store": False,
        }
        if json_output:
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "alphacode_product_copy",
                    "strict": True,
                    "schema": product_copy_schema(),
                }
            }
        return payload

    payload = {
        "model": runtime["model"],
        "messages": messages,
        "temperature": 0.38,
        "max_completion_tokens": max_tokens,
    }
    if json_output:
        payload["response_format"] = {"type": "json_object"}
    if runtime["provider"] == "groq" and "gpt-oss" in runtime["model"].lower():
        payload["reasoning_effort"] = "low"
        payload["reasoning_format"] = "hidden"
    return payload


def extract_ai_output_text(response_data):
    """Arabic: قراءة النص من Responses API أو Chat Completions. English: Read text from Responses API or Chat Completions responses."""
    if not isinstance(response_data, dict):
        return ""
    direct = normalize_text(response_data.get("output_text"))
    if direct:
        return direct

    choices = response_data.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    parts.append(normalize_text(item.get("text") or item.get("content")))
            combined = "\n".join(part for part in parts if part)
            if combined:
                return combined
        for key in ("reasoning_content", "reasoning"):
            fallback = normalize_text(message.get(key))
            if fallback:
                return fallback

    output = response_data.get("output") or []
    parts = []
    for item in output:
        if not isinstance(item, dict):
            continue
        for content_item in item.get("content") or []:
            if isinstance(content_item, dict):
                parts.append(normalize_text(content_item.get("text") or content_item.get("output_text")))
    return "\n".join(part for part in parts if part)


class AIProviderRequestError(RuntimeError):
    """Arabic: خطأ من مزود الذكاء الاصطناعي يحتفظ بحالة HTTP وRetry-After. English: Provider error that preserves HTTP status and retry metadata."""

    def __init__(self, payload, status_code):
        self.payload = payload if isinstance(payload, dict) else {"success": False, "error": str(payload)}
        self.status_code = int(status_code or 502)
        super().__init__(self.payload.get("error") or f"AI provider request failed ({self.status_code}).")


def send_ai_request(runtime, payload, timeout_seconds, stage):
    """Arabic: إرسال طلب واحد وعدم إعادة 413 أو 429 تلقائياً. English: Send one request and never auto-retry HTTP 413 or 429."""
    response = requests.post(
        runtime["endpoint"],
        headers={
            "Authorization": f"Bearer {runtime['api_key']}",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        json=payload,
        timeout=(20, timeout_seconds),
        verify=certifi.where(),
    )

    if response.status_code == 429:
        retry_after = read_retry_after_seconds(response)
        try:
            message = response.json().get("error", {}).get("message", "AI rate limit reached.")
        except Exception:
            message = response.text[:500] or "AI rate limit reached."
        return None, {
            "success": False,
            "error": message,
            "rate_limited": True,
            "retry_after_seconds": retry_after,
            "stage": stage,
            "provider": runtime["provider"],
        }, 429

    if response.status_code == 413:
        return None, {
            "success": False,
            "request_too_large": True,
            "stage": stage,
            "provider": runtime["provider"],
            "error": "رفض مزود الذكاء الاصطناعي الطلب لأن حجمه كبير. تم الاحتفاظ بالنص الحالي.",
        }, 413

    if response.status_code >= 400:
        try:
            error_body = response.json().get("error", {})
            message = normalize_text(error_body.get("message"))
            failed_generation = error_body.get("failed_generation")
        except Exception:
            message = ""
            failed_generation = ""

        # Arabic: بعض نماذج Groq ترفض JSON mode قبل إعادة المحتوى؛ نسمح بمحاولة نصية واحدة فقط.
        # English: Some Groq models reject JSON mode before returning content; allow one plain-text fallback only.
        if response.status_code == 400 and (
            failed_generation
            or re.search(r"(?:failed_generation|validate json|valid json|json object)", message, re.I)
        ):
            return None, {
                "success": False,
                "json_mode_failed": True,
                "stage": stage,
                "provider": runtime["provider"],
                "error": message or "The provider rejected JSON mode.",
            }, 400

        raise RuntimeError(message or f"AI provider HTTP {response.status_code}: {response.text[:500]}")

    return response, None, None


def send_copy_generation(runtime, messages, max_tokens, stage):
    """Arabic: طلب JSON ثم محاولة نصية واحدة إذا رفض المزود وضع JSON، دون تكرار البحث. English: Request JSON and use one plain-text fallback if the provider rejects JSON mode, without repeating research."""
    payload = make_provider_payload(runtime, messages, max_tokens, json_output=True)
    response, error, status = send_ai_request(runtime, payload, 100, stage)

    if error is not None and error.get("json_mode_failed"):
        fallback_messages = list(messages)
        fallback_messages.append({
            "role": "user",
            "content": (
                "Return exactly one complete JSON object now. Do not use Markdown or code fences. "
                "Use only these keys: name_en, description_en, name_ar, description_ar, brand_name."
            ),
        })
        fallback_payload = make_provider_payload(
            runtime,
            fallback_messages,
            max_tokens,
            json_output=False,
        )
        return send_ai_request(runtime, fallback_payload, 100, f"{stage}_plain_json_fallback")

    return response, error, status


def repair_json_once(runtime, malformed_text, original_messages=None):
    """Arabic: محاولة واحدة لإصلاح JSON أو إعادة إخراج فارغ دون إعادة البحث. English: Repair invalid JSON or regenerate an empty output once without repeating research."""
    compact_malformed = compact_prompt_text(malformed_text, 4200)
    if compact_malformed:
        messages = [
            {
                "role": "system",
                "content": (
                    "Repair the supplied output into exactly one valid JSON object. "
                    "Keep the original meaning and use exactly these keys: "
                    "name_en, description_en, name_ar, description_ar, brand_name. "
                    "Do not add Markdown or commentary."
                ),
            },
            {"role": "user", "content": compact_malformed},
        ]
    else:
        messages = list(original_messages or [])
        messages.append({
            "role": "user",
            "content": (
                "The previous response was empty. Generate the requested catalog copy now and return exactly one JSON object only "
                "with name_en, description_en, name_ar, description_ar, and brand_name."
            ),
        })
    response, error, status = send_copy_generation(
        runtime,
        messages,
        700,
        "json_repair",
    )
    if error is not None:
        raise AIProviderRequestError(error, status)
    return extract_ai_output_text(response.json())


def generate_official_research(runtime, official_domain, original_product_name, style_code):
    """Arabic: تنفيذ بحث رسمي واحد عبر Groq أو OpenAI. English: Run one official-domain research operation through Groq or OpenAI."""
    prompt = build_official_research_prompt(official_domain, original_product_name, style_code)

    if runtime["provider"] == "openai" and runtime["api_mode"] == "responses":
        payload = {
            "model": runtime["model"],
            "input": prompt,
            "tools": [{"type": "web_search", "filters": {"allowed_domains": [official_domain]}}],
            "max_tool_calls": 1,
            "max_output_tokens": 450,
            "store": False,
        }
        response, error, status = send_ai_request(runtime, payload, 90, "official_search")
    else:
        groq_key = os.getenv("GROQ_API_KEY")
        if not groq_key:
            raise ValueError("Official-site research requires GROQ_API_KEY or the OpenAI provider.")
        research_runtime = {
            "provider": "groq",
            "endpoint": GROQ_CHAT_URL,
            "api_key": groq_key,
            "model": GROQ_OFFICIAL_SEARCH_MODEL,
            "api_mode": "chat",
        }
        payload = {
            "model": GROQ_OFFICIAL_SEARCH_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "search_settings": {"include_domains": [official_domain]},
            "citation_options": "disabled",
            "max_completion_tokens": 450,
        }
        response, error, status = send_ai_request(research_runtime, payload, 90, "official_search")

    if error is not None:
        raise AIProviderRequestError(error, status)
    research_text = extract_ai_output_text(response.json())
    if not research_text:
        raise ValueError("Official search returned no usable facts.")
    return research_text


@app.route("/api/ai/generate", methods=["POST"])
def generate_ai_copy():
    """Arabic: توليد عادي أولاً، وبحث رسمي للمنتج الحالي فقط عند الطلب الثاني. English: Generate normally first and research only the current product on explicit regeneration."""
    data = request.get_json(silent=True) or {}
    source_text = compact_prompt_text(data.get("SourceText"), 4000)
    original_product_name = compact_prompt_text(data.get("OriginalProductName"), 400)
    style_code = compact_prompt_text(data.get("StyleCode"), 80)
    search_code = compact_prompt_text(data.get("SearchCode"), 80)
    sizes = unique_text_values(data.get("Sizes") if isinstance(data.get("Sizes"), list) else [])[:40]
    configured_brand = canonicalize_brand_name(compact_prompt_text(data.get("BrandName"), 100))
    allowed_brands = normalize_allowed_brands(
        data.get("AllowedBrands") if isinstance(data.get("AllowedBrands"), list) else [],
        configured_brand,
    )
    configured_brand = resolve_allowed_brand(
        configured_brand,
        configured_brand,
        allowed_brands,
        f"{original_product_name} {source_text}",
    )
    research_official = safe_bool(data.get("ResearchOfficial"), False)
    arabic_style = compact_prompt_text(data.get("ArabicCopyStyle"), 80) or "sales-natural"
    json_repair_enabled = safe_bool(data.get("AIJsonRepairEnabled"), True)

    if not source_text and not original_product_name:
        return jsonify({"success": False, "error": "SourceText or OriginalProductName is required."}), 400

    try:
        runtime = resolve_ai_runtime(data)
        official_domain = ""
        official_research = ""

        if research_official:
            official_domains = resolve_official_store_domains(
                configured_brand,
                f"{original_product_name} {source_text}",
            )
            if not official_domains:
                return jsonify({"success": False, "error": "لا يوجد نطاق رسمي مهيأ لهذا البراند."}), 400
            official_domain = official_domains[0]
            official_research = generate_official_research(
                runtime,
                official_domain,
                original_product_name,
                style_code,
            )
            messages = build_official_rewrite_messages(
                official_research,
                source_text,
                original_product_name,
                style_code,
                search_code,
                sizes,
                configured_brand,
                allowed_brands,
                arabic_style,
            )
            stage = "official_rewrite"
        else:
            messages = build_normal_ai_messages(
                source_text,
                original_product_name,
                style_code,
                search_code,
                sizes,
                configured_brand,
                allowed_brands,
                arabic_style,
            )
            stage = "normal_generation"

        response, error_response, error_status = send_copy_generation(
            runtime,
            messages,
            1200,
            stage,
        )
        if error_response is not None:
            return jsonify(error_response), error_status

        raw_text = extract_ai_output_text(response.json())
        try:
            generated = validate_generated_copy(extract_first_json_object(raw_text))
        except (ValueError, json.JSONDecodeError) as first_error:
            if not json_repair_enabled:
                raise first_error
            logger.warning("AI JSON validation failed; running one repair attempt. provider=%s error=%s", runtime["provider"], first_error)
            repaired_text = repair_json_once(runtime, raw_text, messages)
            generated = validate_generated_copy(extract_first_json_object(repaired_text))

        brand_name = resolve_allowed_brand(
            generated.get("brand_name"),
            configured_brand,
            allowed_brands,
            f"{original_product_name} {source_text}",
        )
        name_en = enforce_product_name_rules(
            generated.get("name_en"), source_text, style_code, brand_name
        )
        description_en = re.sub(r"\s+", " ", normalize_text(generated.get("description_en")))[:1800]
        name_ar = enforce_arabic_product_name(
            generated.get("name_ar"), source_text, style_code, brand_name
        )
        description_ar = re.sub(r"\s+", " ", normalize_text(generated.get("description_ar")))[:2000]

        if len(name_en) < 8 or len(description_en) < 20 or len(name_ar) < 8 or len(description_ar) < 15:
            raise ValueError("The AI response did not contain complete bilingual product copy.")

        return jsonify({
            "success": True,
            "name_en": name_en,
            "description_en": description_en,
            "name_ar": name_ar,
            "description_ar": description_ar,
            "brand_name": brand_name,
            "provider": runtime["provider"],
            "model": runtime["model"],
            "research_model": GROQ_OFFICIAL_SEARCH_MODEL if research_official and runtime["provider"] != "openai" else runtime["model"] if research_official else "",
            "style_code": style_code,
            "generation_mode": "official_research_and_rewrite" if research_official else "normal",
            "official_domain": official_domain,
            "official_store_only": research_official,
            "cached": False,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        })

    except AIProviderRequestError as exc:
        payload = dict(exc.payload)
        payload["retained_current_text"] = True
        logger.warning(
            "AI provider request stopped without retry. official=%s status=%s error=%s",
            research_official,
            exc.status_code,
            exc,
        )
        return jsonify(payload), exc.status_code

    except (requests.RequestException, RuntimeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        logger.exception("AI copy generation failed. official=%s error=%s", research_official, exc)
        return jsonify({
            "success": False,
            "error": str(exc),
            "retained_current_text": True,
        }), 502


@app.route("/api/extract", methods=["POST"])
def extract_product():
    """Arabic: تنزيل الصور وحفظ Excel والأرشيف ثم تجهيز المنتج للوحة Sooqify. English: Download images, commit Excel/archive, and prepare the Sooqify autofill package."""
    data = request.get_json(silent=True) or {}
    settings = extract_settings(data)
    search_code = normalize_text(data.get("SearchCode"))
    style_code = normalize_text(data.get("StyleCode"))
    name_en = normalize_text(data.get("NameEN") or data.get("Name")) or "Unnamed Product"
    description_en = normalize_text(data.get("DescriptionEN") or data.get("Description"))
    name_ar = normalize_text(data.get("NameAR")) or name_en
    description_ar = normalize_text(data.get("DescriptionAR")) or description_en
    brand_map = parse_brand_map_json(settings.get("BrandMapJson"))
    allowed_store_brands = list(brand_map.keys()) or [settings["BrandName"]]
    brand_name = resolve_allowed_brand(
        data.get("BrandName"),
        settings["BrandName"],
        allowed_store_brands,
        f"{data.get('NameEN', '')} {data.get('NameAR', '')} {data.get('DescriptionEN', '')}",
    )
    brand_id = brand_map.get(brand_name, safe_int(data.get("BrandId"), settings["BrandId"]))
    sizes = unique_text_values(data.get("Sizes") if isinstance(data.get("Sizes"), list) else [])
    supplier_store_name = normalize_text(data.get("SupplierStoreName") or settings["SupplierStoreName"])
    supplier_store_id = normalize_text(data.get("SupplierStoreId") or settings["SupplierStoreId"])

    raw_images = data.get("Images") if isinstance(data.get("Images"), list) else []
    images, seen_images = [], set()
    for image_url in raw_images:
        normalized_url = strip_existing_image_transform(image_url)
        if not normalized_url or normalized_url in seen_images:
            continue
        seen_images.add(normalized_url)
        images.append(normalized_url)
        if len(images) >= settings["MaxImages"]:
            break
    if not images:
        return jsonify({"success": False, "error": "No product images were received."}), 400

    # Arabic: ترتيب الصور المختارة مع دعم تنزيل المحدد فقط وعدم إضافة صور لم يخترها المستخدم.
    # English: Normalize selected images and optionally download only the exact user selection.
    # Arabic: المتجر الحالي يدعم ست صور إجمالاً: رئيسية وخمس صور معرض.
    # English: The current store supports six total images: one main and five gallery images.
    store_image_limit = max(1, min(safe_int(data.get("StoreImageLimit"), 6), 6))
    selected_indexes = []
    supplied_selection = data.get("SelectedImageIndexes") if isinstance(data.get("SelectedImageIndexes"), list) else []
    for value in supplied_selection:
        index = safe_int(value, -1)
        if 0 <= index < len(images) and index not in selected_indexes:
            selected_indexes.append(index)

    main_image_index = safe_int(data.get("MainImageIndex"), selected_indexes[0] if selected_indexes else 0)
    if not 0 <= main_image_index < len(images):
        main_image_index = selected_indexes[0] if selected_indexes else 0

    if not selected_indexes:
        selected_indexes = list(range(min(store_image_limit, len(images))))
    if main_image_index in selected_indexes:
        selected_indexes.remove(main_image_index)
    selected_indexes.insert(0, main_image_index)
    selected_indexes = selected_indexes[:store_image_limit]

    download_selected_only = safe_bool(
        data.get("DownloadSelectedImagesOnly"),
        settings["DownloadSelectedImagesOnly"],
    )
    download_indexes = selected_indexes if download_selected_only else list(range(len(images)))
    download_plan = [(index, images[index]) for index in download_indexes]

    with SAVE_LOCK:
        archive = load_archive()
        existing = find_existing_product(archive, search_code, style_code)
        if existing:
            return jsonify({
                "success": False,
                "exists": True,
                "id": existing.get("id"),
                "workflow_status": existing.get("workflow_status") or "prepared",
                "store_submission_status": existing.get("store_submission_status") or "not_submitted",
                "error": "This product already exists in the archive.",
            }), 409

        next_id = get_next_id(archive)
        transaction_id = uuid.uuid4().hex
        today_str = datetime.now().strftime("%Y-%m-%d")
        identifier = search_code if is_valid_marker(search_code) else style_code
        folder_base = clean_folder_name(name_en, identifier or next_id)
        folder_suffix = clean_code_for_path(identifier or f"ID-{next_id}")
        final_folder_name = f"{folder_base}__{folder_suffix}"[:115].rstrip(" .")
        final_product_folder = os.path.join(BASE_DIR, final_folder_name)
        os.makedirs(BASE_DIR, exist_ok=True)
        temp_root = os.path.join(BASE_DIR, ".alphacode_tmp")
        os.makedirs(temp_root, exist_ok=True)
        temp_product_folder = os.path.join(temp_root, transaction_id)
        os.makedirs(temp_product_folder, exist_ok=False)

        output_format = normalize_image_format(settings["ImageFormat"])
        extension = "png" if output_format == "png" else "jpg"
        local_images, downloaded_image_records, failed_images = [], [], []
        total_download_bytes = 0
        session = requests.Session()
        session.headers.update(HEADERS)
        logger.info(
            "Starting product transaction id=%s, search_code=%s, style_code=%s, images=%s",
            next_id, search_code or "NONE", style_code or "NONE", len(images),
        )
        try:
            for sequence_number, (source_index, image_url) in enumerate(download_plan, start=1):
                image_name = f"{today_str}-{uuid.uuid4().hex[:12]}.{extension}"
                image_path = os.path.join(temp_product_folder, image_name)
                try:
                    downloaded_bytes, _ = download_single_image(
                        session,
                        image_url,
                        image_path,
                        settings,
                        source_index + 1,
                    )
                    total_download_bytes += downloaded_bytes
                    local_images.append(image_name)
                    downloaded_image_records.append({"source_index": source_index, "name": image_name})
                except Exception as exc:
                    failed_images.append({
                        "index": source_index + 1,
                        "sequence": sequence_number,
                        "url": image_url,
                        "error": str(exc),
                    })
                    logger.error("Image source index %s could not be downloaded: %s", source_index + 1, exc)
            if settings["RequireAllImages"] and failed_images:
                raise RuntimeError(
                    f"{len(failed_images)} of {len(download_plan)} planned images could not be downloaded. Nothing was saved."
                )
            if not local_images:
                raise RuntimeError("No image could be downloaded. Nothing was saved.")

            downloaded_by_index = {item["source_index"]: item["name"] for item in downloaded_image_records}
            store_images = [downloaded_by_index[index] for index in selected_indexes if index in downloaded_by_index]
            if not store_images:
                store_images = local_images[:store_image_limit]
            store_main_image = downloaded_by_index.get(main_image_index) or store_images[0]
            store_images = [store_main_image] + [name for name in store_images if name != store_main_image]
            store_images = store_images[:store_image_limit]
            logger.info(
                "Store image selection prepared. id=%s selected=%s main=%s all_downloaded=%s",
                next_id, store_images, store_main_image, len(local_images),
            )

            variations, choice_options, attributes, total_stock = build_size_variant_fields(
                sizes, data.get("PriceSAR"), settings["Stock"], settings
            )
            new_row = {
                "Id": next_id,
                "Name": name_en,
                "Description": description_en,
                "Image": store_main_image,
                "CategoryId": settings["CategoryId"],
                "SubCategoryId": settings["SubCategoryId"],
                "UnitId": settings["UnitId"],
                "Stock": total_stock,
                "Price": data.get("PriceSAR"),
                "Discount": settings["Discount"],
                "DiscountType": settings["DiscountType"],
                "AvailableTimeStarts": settings["AvailableTimeStarts"],
                "AvailableTimeEnds": settings["AvailableTimeEnds"],
                "Variations": variations,
                "ChoiceOptions": choice_options,
                "AddOns": "[]",
                "Attributes": attributes,
                "StoreId": settings["StoreId"],
                "ModuleId": settings["ModuleId"],
                "Status": settings["Status"],
                "Veg": settings["Veg"],
                "Recommended": settings["Recommended"],
            }
            archive_key = search_code if is_valid_marker(search_code) else f"STYLE_{clean_code_for_path(style_code)}_{next_id}"
            settings_for_store = {
                "StoreId": settings["StoreId"],
                "CategoryId": settings["CategoryId"],
                "SubCategoryId": settings["SubCategoryId"],
                "UnitId": settings["UnitId"],
                "Stock": settings["Stock"],
                "Discount": settings["Discount"],
                "DiscountType": settings["DiscountType"],
                "AvailableTimeStarts": settings["AvailableTimeStarts"],
                "AvailableTimeEnds": settings["AvailableTimeEnds"],
                "MaximumCartQuantity": settings["MaximumCartQuantity"],
                "Veg": settings["Veg"],
                "SizeAttributeId": settings["SizeAttributeId"],
                "SizeChoiceNo": settings["SizeChoiceNo"],
                "SizeactualChoiceNo": settings["SizeactualChoiceNo"],
                "SizeTitle": settings["SizeTitle"],
                "DefaultLanguage": settings["DefaultLanguage"],
                "DownloadSelectedImagesOnly": download_selected_only,
            }
            archive_item = {
                "id": next_id,
                "name": name_en,
                "description": description_en,
                "name_en": name_en,
                "description_en": description_en,
                "name_ar": name_ar,
                "description_ar": description_ar,
                "brand_name": brand_name,
                "brand_id": brand_id,
                "style_code": style_code,
                "search_code": search_code,
                "price": data.get("PriceSAR"),
                "sizes": sizes,
                "date": today_str,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "workflow_status": "prepared",
                "store_submission_status": "not_submitted",
                "folder": final_folder_name,
                "images": local_images,
                "store_images": store_images,
                "store_main_image": store_main_image,
                "selected_image_indexes": selected_indexes,
                "download_selected_images_only": download_selected_only,
                "source_image_count": len(images),
                "downloaded_image_count": len(local_images),
                "source_url": normalize_text(data.get("SourceUrl")),
                "supplier_store_name": supplier_store_name,
                "supplier_store_id": supplier_store_id,
                "settings": settings_for_store,
            }
            updated_archive = dict(archive)
            updated_archive[archive_key] = archive_item
            if is_valid_marker(search_code):
                updated_archive["_last_added_code"] = search_code
            updated_archive["_last_added_id"] = next_id

            temp_excel = create_temp_excel(new_row, transaction_id)
            temp_archive = write_json_temp(ARCHIVE_PATH, updated_archive, transaction_id)
            commit_transaction(temp_product_folder, final_product_folder, temp_excel, temp_archive, transaction_id)
            pending_product = build_pending_product(next_id, archive_item)
            logger.info(
                "Product saved successfully. id=%s, downloaded=%s/%s, source_images=%s, selected_only=%s, transferred_bytes=%s",
                next_id,
                len(local_images),
                len(download_plan),
                len(images),
                download_selected_only,
                total_download_bytes,
            )
            return jsonify({
                "success": True,
                "id": next_id,
                "folder": final_product_folder,
                "source_images": len(images),
                "requested_images": len(download_plan),
                "downloaded_images": len(local_images),
                "download_selected_only": download_selected_only,
                "download_mode": "selected_only" if download_selected_only else "all_source_images",
                "failed_images": failed_images,
                "image_names": local_images,
                "store_image_names": store_images,
                "store_main_image": store_main_image,
                "transferred_bytes": total_download_bytes,
                "pending_product": pending_product,
            })
        except Exception as exc:
            logger.exception("Product transaction failed: %s", exc)
            shutil.rmtree(temp_product_folder, ignore_errors=True)
            return jsonify({"success": False, "error": str(exc), "failed_images": failed_images}), 500


if __name__ == "__main__":
    """Arabic: تشغيل خادم Flask محلياً دون وضع Debug. English: Run the local Flask server without debug mode."""
    logger.info("AlphaCode Extractor server is ready on http://127.0.0.1:5000")
    logger.info("AI keys configured. Groq=%s OpenAI=%s", bool(os.getenv("GROQ_API_KEY")), bool(os.getenv("OPENAI_API_KEY")))
    logger.info("External log file: %s", LOG_PATH)
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
