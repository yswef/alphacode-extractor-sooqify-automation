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
CORS(app)

# Arabic: المسارات الأساسية قابلة للتعديل عند نقل المشروع إلى جهاز أو متجر آخر.
# English: Core paths are intentionally centralized for future store migrations.
ROOT_DIR = os.getenv("ALPHACODE_ROOT_DIR", r"Y:\\سوقفاي")
BASE_DIR = os.path.join(ROOT_DIR, "صور", "Air Jordan")
EXCEL_PATH = os.path.join(ROOT_DIR, "items_bulk_format_nodata.xlsx")
ARCHIVE_PATH = os.path.join(ROOT_DIR, "archive_db.json")
AI_CACHE_PATH = os.path.join(ROOT_DIR, "ai_copy_cache.json")
LOG_DIR = os.path.join(ROOT_DIR, "logs")
LOG_PATH = os.path.join(LOG_DIR, "alphacode.log")

# Arabic: Groq Chat Completions متوافق مع تنسيق OpenAI ويوفر حصة مجانية محدودة.
# English: Groq Chat Completions is OpenAI-compatible and offers a limited free tier.
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_AI_MODEL = "openai/gpt-oss-20b"
AI_PROMPT_VERSION = "3.2-bilingual-canonical-brand"

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
        "SizeAttributeId": max(1, safe_int(settings.get("SizeAttributeId"), 1)),
        "SizeChoiceNo": max(1, safe_int(settings.get("SizeChoiceNo"), 1)),
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
        "AIModel": normalize_text(settings.get("AIModel")) or DEFAULT_AI_MODEL,
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
    """Arabic: توحيد أسماء البراندات الشائعة. English: Canonicalize common brand names."""
    brand = normalize_text(value)
    if re.search(r"\b(?:air\s+jordan|jordan|aj\s*\d+)\b", brand, re.I):
        return "Air Jordan"
    if re.search(r"\bnike\b", brand, re.I):
        return "Nike"
    if re.search(r"\badidas\b", brand, re.I):
        return "Adidas"
    return brand


def enforce_product_name_rules(name, source_text, style_code):
    """Arabic: فرض الاسم القياسي Air Jordan ووضع Style Code مرة واحدة. English: Enforce canonical Air Jordan naming and a single trailing Style Code."""
    final_name = re.sub(r"\s+", " ", normalize_text(name)).strip(" -–—|")
    source = normalize_text(source_text)
    exact_style_code = normalize_text(style_code).upper()
    is_air_jordan = bool(re.search(r"\b(?:AIR\s+JORDAN|JORDAN\s*\d+|AJ\s*\d+)\b", source, re.I))
    if is_air_jordan:
        final_name = re.sub(r"^(?:NIKE\s+)?JORDAN(?=\s*\d)", "Air Jordan", final_name, flags=re.I)
        final_name = re.sub(r"^AJ\s*(\d+)", r"Air Jordan \1", final_name, flags=re.I)
        final_name = re.sub(r"^AIR\s+JORDAN\b", "Air Jordan", final_name, flags=re.I)
        final_name = re.sub(r"^AIR\s+AIR\s+JORDAN\b", "Air Jordan", final_name, flags=re.I)
        if not re.match(r"^Air Jordan\b", final_name, flags=re.I):
            model_match = re.search(r"\b(?:Air\s+Jordan|Jordan|AJ)\s*(\d+)(?:\s+(Low|Mid|High))?", source, re.I)
            if model_match:
                prefix = f"Air Jordan {model_match.group(1)}"
                if model_match.group(2):
                    prefix += f" {model_match.group(2).title()}"
                final_name = f"{prefix} {final_name}".strip()
    if exact_style_code:
        final_name = re.sub(rf"\s*[-–—|]?\s*{re.escape(exact_style_code)}\b", "", final_name, flags=re.I).strip(" -–—|")
        final_name = f"{final_name} - {exact_style_code}"
    return re.sub(r"\s+", " ", final_name).strip()[:150]


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
    image_names = archive_item.get("images") or []
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
            for image_name in image_names
        ],
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
    """Arabic: فحص حالة الخادم وإعداد Groq. English: Report server and Groq configuration status."""
    return jsonify({
        "success": True,
        "service": "AlphaCode Extractor",
        "version": "3.2.0",
        "ai_provider": "Groq",
        "ai_configured": bool(os.getenv("GROQ_API_KEY")),
        "default_ai_model": os.getenv("GROQ_MODEL", DEFAULT_AI_MODEL),
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


@app.route("/api/ai/generate", methods=["POST"])
def generate_ai_copy():
    """Arabic: توليد اسم ووصف عربي وإنجليزي عبر Groq. English: Generate bilingual product copy through Groq."""
    data = request.get_json(silent=True) or {}
    source_text = normalize_text(data.get("SourceText"))
    style_code = normalize_text(data.get("StyleCode"))
    search_code = normalize_text(data.get("SearchCode"))
    sizes = unique_text_values(data.get("Sizes") if isinstance(data.get("Sizes"), list) else [])
    configured_brand = canonicalize_brand_name(data.get("BrandName"))
    model = normalize_text(data.get("AIModel")) or os.getenv("GROQ_MODEL", DEFAULT_AI_MODEL)
    if not source_text:
        return jsonify({"success": False, "error": "SourceText is required."}), 400
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return jsonify({"success": False, "error": "GROQ_API_KEY is not configured on the Python server."}), 503

    cache_key = ai_cache_key(style_code, source_text, model)
    with AI_CACHE_LOCK:
        cached = load_json_file(AI_CACHE_PATH, {}).get(cache_key)
        if isinstance(cached, dict) and cached.get("name_en") and cached.get("description_en"):
            return jsonify({"success": True, **cached, "cached": True})

    instructions = (
        "You are a senior footwear product researcher and bilingual Arabic-English e-commerce copywriter. "
        "Use the supplied product text and your reliable product knowledge, but never invent unsupported facts. "
        "If the source mentions Air Jordan, Jordan followed by a model number, or AJ followed by a model number, "
        "the canonical brand must be exactly 'Air Jordan'. Never write 'Jordan' alone or 'Nike Jordan'. "
        "The English product name should use: canonical brand, model, silhouette/edition, verified colorway or key design, "
        "and the exact style code once at the end. Avoid weak names such as Sports Shoe, Sneakers Product, or Jordan 1 Low. "
        "Write a polished 2-3 sentence English description using only verified colors, materials, silhouette, design details, and sizes. "
        "Create a natural Arabic commercial name and description carrying the same verified facts, while keeping brand/model/style code recognizable. "
        "Do not claim authentic, genuine, original, official, replica, or a quality grade. "
        "Do not include prices, supplier names, Search Code, shipping claims, emojis, or Chinese text. "
        "Return valid JSON only with exactly: name_en, description_en, name_ar, description_ar, brand_name."
    )
    user_input = (
        f"Original supplier text:\n{source_text[:8000]}\n\n"
        f"Exact style code: {style_code or 'Not provided'}\n"
        f"Internal search code (do not include in names): {search_code or 'Not provided'}\n"
        f"Available sizes: {', '.join(sizes) if sizes else 'Not provided'}\n"
        f"Configured brand hint: {configured_brand or 'Not provided'}\n"
        "Produce complete bilingual store copy and canonical brand identification."
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": user_input},
        ],
        "temperature": 0.0,
        "max_completion_tokens": 1000,
    }
    response = None
    try:
        response = requests.post(
            GROQ_CHAT_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=(20, 90),
            verify=certifi.where(),
        )
        response.raise_for_status()
        raw_text = response.json().get("choices", [{}])[0].get("message", {}).get("content", "")
        if not raw_text:
            raise ValueError("Groq returned an empty response.")
        clean_text = raw_text.strip()
        clean_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", clean_text, flags=re.I)
        json_match = re.search(r"\{.*\}", clean_text, flags=re.S)
        if not json_match:
            raise ValueError("Groq did not return a valid JSON object.")
        generated = json.loads(json_match.group(0))
        name_en = enforce_product_name_rules(generated.get("name_en"), source_text, style_code)
        description_en = re.sub(r"\s+", " ", normalize_text(generated.get("description_en")))[:1600]
        name_ar = re.sub(r"\s+", " ", normalize_text(generated.get("name_ar")))[:180]
        description_ar = re.sub(r"\s+", " ", normalize_text(generated.get("description_ar")))[:1800]
        brand_name = canonicalize_brand_name(generated.get("brand_name") or configured_brand)
        if len(name_en) < 5 or len(description_en) < 20 or len(name_ar) < 3 or len(description_ar) < 15:
            raise ValueError("The AI response did not contain complete bilingual product copy.")
        result = {
            "name_en": name_en,
            "description_en": description_en,
            "name_ar": name_ar,
            "description_ar": description_ar,
            "brand_name": brand_name,
            "model": model,
            "style_code": style_code,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        with AI_CACHE_LOCK:
            cache = load_json_file(AI_CACHE_PATH, {})
            cache[cache_key] = result
            save_json_atomic(AI_CACHE_PATH, cache)
        return jsonify({"success": True, **result, "cached": False})
    except requests.HTTPError as exc:
        details = ""
        try:
            details = response.json().get("error", {}).get("message", "")
        except Exception:
            details = response.text[:500] if response is not None else ""
        logger.error("Groq request failed: %s | %s", exc, details)
        return jsonify({"success": False, "error": details or str(exc)}), 502
    except (requests.RequestException, ValueError, KeyError, json.JSONDecodeError) as exc:
        logger.error("AI copy generation failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 502


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
    brand_name = canonicalize_brand_name(data.get("BrandName") or settings["BrandName"])
    brand_id = safe_int(data.get("BrandId"), settings["BrandId"])
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
        local_images, failed_images = [], []
        total_download_bytes = 0
        session = requests.Session()
        session.headers.update(HEADERS)
        logger.info(
            "Starting product transaction id=%s, search_code=%s, style_code=%s, images=%s",
            next_id, search_code or "NONE", style_code or "NONE", len(images),
        )
        try:
            for index, image_url in enumerate(images, start=1):
                image_name = f"{today_str}-{uuid.uuid4().hex[:12]}.{extension}"
                image_path = os.path.join(temp_product_folder, image_name)
                try:
                    downloaded_bytes, _ = download_single_image(session, image_url, image_path, settings, index)
                    total_download_bytes += downloaded_bytes
                    local_images.append(image_name)
                except Exception as exc:
                    failed_images.append({"index": index, "url": image_url, "error": str(exc)})
                    logger.error("Image %s could not be downloaded: %s", index, exc)
            if settings["RequireAllImages"] and failed_images:
                raise RuntimeError(f"{len(failed_images)} of {len(images)} images could not be downloaded. Nothing was saved.")
            if not local_images:
                raise RuntimeError("No image could be downloaded. Nothing was saved.")

            variations, choice_options, attributes, total_stock = build_size_variant_fields(
                sizes, data.get("PriceSAR"), settings["Stock"], settings
            )
            new_row = {
                "Id": next_id,
                "Name": name_en,
                "Description": description_en,
                "Image": local_images[0],
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
                "SizeTitle": settings["SizeTitle"],
                "DefaultLanguage": settings["DefaultLanguage"],
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
                "Product saved successfully. id=%s, downloaded=%s/%s, transferred_bytes=%s",
                next_id, len(local_images), len(images), total_download_bytes,
            )
            return jsonify({
                "success": True,
                "id": next_id,
                "folder": final_product_folder,
                "requested_images": len(images),
                "downloaded_images": len(local_images),
                "failed_images": failed_images,
                "image_names": local_images,
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
    logger.info("Groq integration configured: %s", bool(os.getenv("GROQ_API_KEY")))
    logger.info("External log file: %s", LOG_PATH)
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
