import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from urllib.parse import unquote
import certifi
import pandas as pd
import requests
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS

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

# Arabic: المسارات الأساسية لم تعد قيماً ثابتة؛ دالة recompute_paths() في الأسفل
# تعيد حسابها من paths_config.json (أو من متغير البيئة كافتراضي أولي فقط).
# English: Core paths are no longer fixed constants; recompute_paths() below
# recalculates them from paths_config.json (env var is only the first-run default).
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from app.core.config import (  # noqa: E402
    PATHS_CONFIG_PATH,
    SYNC_QUEUE_PATH,
    SYNC_STATE_PATH,
    save_json_atomic,
    write_json_temp,
)
from app.repositories import archive_repository  # noqa: E402
from app.repositories.paths_repository import load_paths_config, save_paths_config  # noqa: E402
from app.repositories.sync_config_repository import load_sync_config, save_sync_config  # noqa: E402
from app.repositories.sync_queue_repository import load_sync_queue, save_sync_queue  # noqa: E402
from app.repositories.sync_state_repository import load_sync_state, save_sync_state  # noqa: E402
from app.services.sync_service import (  # noqa: E402
    SYNC_REQUEST_PACING_SECONDS,
    bind_archive_runtime,
    sync_call,
    sync_flush_queue,
    sync_pull_updates,
    sync_push_product,
    sync_reconcile_full,
    sync_reserve_id,
    sync_reserve_key,
)
from app.services.upload_service import (  # noqa: E402
    build_optimized_image_url,
    build_variant_fields,
    build_watch_variations_from_absolute_yuan,
    download_single_image,
    extract_settings,
    get_dominant_bg_color,
    json_cell,
    normalize_image_format,
    prepare_image_for_save,
    resolve_store_images_for_upload,
    sniff_image_extension,
    strip_existing_image_transform,
)

# Arabic: تقارير PDF اختيارية. السلوك المقصود: try/except حتى لا يتعطل الإقلاع بدون reportlab.
# English: Optional PDF reports. Intended behavior: try/except so startup survives missing reportlab.
try:
    from app.services import report_service as reports_module  # noqa: E402
    REPORTS_AVAILABLE = True
except ImportError:
    reports_module = None
    REPORTS_AVAILABLE = False


IMAGES_FOLDER_NAME = "صور"
# Arabic: أي منتج فيه عدد صور أقل من هذا الرقم يُرفض ولا يُضاف للمتجر نهائياً (المتجر يحتاج 6 صور: رئيسية + 5 معرض).
# English: Any product with fewer images than this is rejected and never added to the store (the store needs 6: one main + 5 gallery).
MIN_REQUIRED_PRODUCT_IMAGES = 6

ROOT_DIR = os.getenv("ALPHACODE_ROOT_DIR", SCRIPT_DIR)
BASE_DIR = os.path.join(ROOT_DIR, IMAGES_FOLDER_NAME)
EXCEL_PATH = os.path.join(ROOT_DIR, "items_bulk_format_nodata.xlsx")
ARCHIVE_PATH = os.path.join(ROOT_DIR, "archive_db.json")
LOG_DIR = os.path.join(ROOT_DIR, "logs")
LOG_PATH = os.path.join(LOG_DIR, "alphacode.log")
PRICE_PATTERNS_LOG_PATH = os.path.join(LOG_DIR, "price_patterns.jsonl")
ROOT_DIR_CONFIGURED = False  # Arabic: يصبح True فقط بعد اختيار/التحقق من مجلد صالح.

# Arabic: مزودات الذكاء الاصطناعي مدعومة من الخادم دون أتمتة واجهة ChatGPT الشخصية.
# English: The backend supports API providers without automating a personal ChatGPT web session.
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_OPENAI_MODEL = "gpt-5.2"

# Arabic: القفل يمنع تعارض طلبين أثناء تحديث الصور وExcel والأرشيف.
# English: The lock prevents concurrent requests from corrupting images, Excel, or archive data.
SAVE_LOCK = threading.RLock()

class ColoredConsoleFormatter(logging.Formatter):
    """
    Arabic: منسّق ألوان لطرفية التطوير فقط (لا يُستخدم لملف السجل الخارجي حتى لا تُكتب
            رموز ANSI داخل ملف نصي). كل مستوى له لون خلفية مميز لتسهيل تتبّع السجل بالعين.
    English: Colour formatter for the developer terminal only (never used for the rotating
             file handler, so ANSI escape codes never end up inside a plain-text log file).
             Each level gets a distinct background colour for fast at-a-glance scanning.
    """

    RESET = "\x1b[0m"
    LEVEL_STYLES = {
        logging.DEBUG:    "\x1b[45m\x1b[97m",  # magenta bg, white text
        logging.INFO:     "\x1b[44m\x1b[97m",  # blue bg, white text
        logging.WARNING:  "\x1b[43m\x1b[30m",  # yellow bg, black text
        logging.ERROR:    "\x1b[41m\x1b[97m",  # red bg, white text
        logging.CRITICAL: "\x1b[101m\x1b[97m", # bright red bg, white text
    }
    LEVEL_ICONS = {
        logging.DEBUG: "🔎", logging.INFO: "ℹ️", logging.WARNING: "⚠️",
        logging.ERROR: "❌", logging.CRITICAL: "🔥",
    }

    def format(self, record):
        style = self.LEVEL_STYLES.get(record.levelno, "")
        icon = self.LEVEL_ICONS.get(record.levelno, "")
        timestamp = self.formatTime(record, "%H:%M:%S")
        level_tag = f"{style} {icon} {record.levelname:<8}{self.RESET}"
        name_tag = f"\x1b[36m{record.name}\x1b[0m"  # cyan module name
        message = record.getMessage()
        if record.exc_info:
            message = f"{message}\n{self.formatException(record.exc_info)}"
        return f"\x1b[90m{timestamp}\x1b[0m {level_tag} {name_tag} | {message}"


def _enable_windows_ansi_support():
    """Arabic: تفعيل دعم ANSI على طرفية Windows القديمة (cmd.exe). English: Enable ANSI support on legacy Windows terminals (cmd.exe)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
    except Exception:
        pass  # Arabic: فشل غير حرج - يستمر السجل بدون ألوان. English: Non-critical failure - logging continues without colour.


def configure_application_logging():
    """Arabic: تهيئة سجل خارجي دوّار مع طباعة ملوّنة وواضحة في الطرفية. English: Configure rotating external logs with a clear, colourful console output."""
    _enable_windows_ansi_support()
    file_format = logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
    console_format = ColoredConsoleFormatter()
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    if not any(getattr(handler, "_alphacode_console", False) for handler in root_logger.handlers):
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(console_format)
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
            file_handler.setFormatter(file_format)
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

# Arabic: الشكل المرجعي الكامل لعنصر منتج (تبويب "إصلاح البيانات")، يُستخدم فقط لاكتشاف
#         الحقول الناقصة/الزائدة مقارنة بمنتج مكتمل - لا يُستخدم في أي مكان آخر من التطبيق.
# English: The canonical product-item shape (used by the "Data repair" tab) to detect
#          missing/extra fields against a complete product - not used anywhere else.
REFERENCE_PRODUCT_FIELDS = [
    "id", "product_type", "name", "description", "name_en", "description_en",
    "name_ar", "description_ar", "brand_name", "brand_id", "style_code", "search_code",
    "price", "variants", "sizes", "date", "created_at", "workflow_status",
    "store_submission_status", "folder", "brand_folder", "date_folder", "added_by",
    "id_source", "upload_main_image_only", "images", "store_images", "store_main_image",
    "selected_image_indexes", "download_selected_images_only", "source_image_count",
    "downloaded_image_count", "source_url", "supplier_store_name", "supplier_store_id",
    "settings",
]

# Arabic: حقول ميتاداتا/حالة متغيرة بطبيعتها، تُستبعد من مقارنة "تعارض بيانات مع السيرفر"
#         حتى لا يُعتبر كل منتج متزامن حديثاً "تعارضاً" لمجرد اختلاف وقت المزامنة.
# English: Naturally-volatile metadata/status fields, excluded from the "conflict with
#          server" comparison so a recently-synced product isn't flagged for a timestamp diff.
DATA_REPAIR_CONFLICT_IGNORED_FIELDS = {
    "synced_at", "reserved_at", "workflow_status", "store_submission_status",
    "workflow_updated_at", "workflow_details",
}


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


def load_archive():
    """Arabic: تحميل أرشيف المنتجات المحلي. English: Load the local product archive."""
    return archive_repository.load_archive(ARCHIVE_PATH)


def save_archive(archive):
    """Arabic: حفظ أرشيف المنتجات المحلي كاملاً. English: Persist the full local product archive."""
    archive_repository.save_archive(ARCHIVE_PATH, archive)


bind_archive_runtime(load_archive, save_archive, SAVE_LOCK)


# =========================================================
# Arabic: إدارة المسارات الديناميكية - اختيار مجلد الحفظ يدوياً إن لم يوجد المسار الافتراضي.
# English: Dynamic path management - manual folder picker when the default path is missing.
# =========================================================

def is_root_dir_valid(path):
    """Arabic: التحقق الفعلي من أن المسار موجود وقابل للكتابة. English: Actually verify the path exists and is writable."""
    if not path or not os.path.isdir(path):
        return False
    try:
        probe = os.path.join(path, f".alphacode_write_probe_{uuid.uuid4().hex[:8]}")
        with open(probe, "w") as probe_file:
            probe_file.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def reconfigure_logging_target():
    """Arabic: إعادة توجيه ملف السجل الخارجي عند تغيير مجلد الحفظ. English: Repoint the external log file when the save folder changes."""
    root_logger = logging.getLogger()
    for handler in list(root_logger.handlers):
        if getattr(handler, "_alphacode_file", False):
            root_logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
    configure_application_logging()


def recompute_paths():
    """
    Arabic: إعادة حساب كل المسارات المشتقة من ROOT_DIR الحالي دون إنشاء أي مجلد بصمت
    إلا إذا كان المستخدم قد اختاره صراحة من قبل عبر /api/paths/choose-folder.
    English: Recompute every ROOT_DIR-derived path without silently creating anything
    unless the user has explicitly chosen it before via /api/paths/choose-folder.
    """
    global ROOT_DIR, BASE_DIR, EXCEL_PATH, ARCHIVE_PATH, AI_CACHE_PATH, LOG_DIR, LOG_PATH, PRICE_PATTERNS_LOG_PATH, ROOT_DIR_CONFIGURED

    cfg = load_paths_config()
    chosen = normalize_text(cfg.get("RootDir"))
    candidate = chosen or os.getenv("ALPHACODE_ROOT_DIR", SCRIPT_DIR)

    ROOT_DIR = candidate
    BASE_DIR = os.path.join(ROOT_DIR, IMAGES_FOLDER_NAME)
    EXCEL_PATH = os.path.join(ROOT_DIR, "items_bulk_format_nodata.xlsx")
    ARCHIVE_PATH = os.path.join(ROOT_DIR, "archive_db.json")
    AI_CACHE_PATH = os.path.join(ROOT_DIR, "ai_copy_cache.json")
    LOG_DIR = os.path.join(ROOT_DIR, "logs")
    LOG_PATH = os.path.join(LOG_DIR, "alphacode.log")
    PRICE_PATTERNS_LOG_PATH = os.path.join(LOG_DIR, "price_patterns.jsonl")

    if chosen and not os.path.isdir(ROOT_DIR):
        try:
            os.makedirs(ROOT_DIR, exist_ok=True)
        except OSError as exc:
            logger.warning("Could not create the configured root folder %s: %s", ROOT_DIR, exc)

    ROOT_DIR_CONFIGURED = bool(chosen) and is_root_dir_valid(ROOT_DIR)
    reconfigure_logging_target()
    return ROOT_DIR_CONFIGURED


class RootDirNotConfigured(Exception):
    """Arabic: تُرفع عند محاولة الحفظ قبل اختيار مجلد صالح. English: Raised when a save is attempted before a valid folder is chosen."""


def require_root_dir():
    """Arabic: يمنع أي عملية كتابة على القرص قبل إعداد مجلد صالح. English: Blocks any disk write before a valid folder is configured."""
    if not ROOT_DIR_CONFIGURED or not is_root_dir_valid(ROOT_DIR):
        raise RootDirNotConfigured("No valid save folder is configured yet. Choose one from the extension settings first.")


def open_native_folder_dialog():
    """
    Arabic: يفتح نافذة اختيار مجلد أصلية من نظام التشغيل عبر عملية Python منفصلة (tkinter)
    لتفادي أي تعارض بين tkinter وخيوط Flask. يرجع المسار المختار أو '' عند الإلغاء.
    English: Opens a native OS folder-picker via a separate Python subprocess (tkinter)
    to avoid any conflict between tkinter and Flask's worker threads. Returns the chosen
    path, or '' if the user cancelled.
    """
    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        "path = filedialog.askdirectory(title='AlphaCode - اختر مجلد حفظ المنتجات والصور')\n"
        "print(path)\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-c", script],
            capture_output=True, text=True, timeout=180, encoding="utf-8"
        )
        return normalize_text(result.stdout.splitlines()[-1]) if result.stdout.strip() else ""
    except Exception as exc:
        logger.error("Could not open the native folder dialog: %s", exc)
        raise


def get_brand_folder_name(brand_name):
    """Arabic: اسم مجلد آمن مشتق من البراند الحالي. English: A filesystem-safe folder name derived from the current brand."""
    return clean_folder_name(brand_name, "Other") or "Other"


def get_brand_dir(brand_name):
    """Arabic: مسار مجلد صور البراند المحدد داخل BASE_DIR. English: The brand-specific image folder inside BASE_DIR."""
    return os.path.join(BASE_DIR, get_brand_folder_name(brand_name))


def get_product_image_dir(product):
    """
    Arabic: إعادة بناء مسار مجلد منتج موجود، متوافق مع كل الأنماط السابقة: بمجلد تاريخ (الحالي)،
    أو بمجلد براند (نمط سابق)، أو مباشرة داخل مجلد الصور (أقدم نمط).
    English: Rebuild an existing product's folder location, compatible with every previous scheme:
    date-folder (current), brand-folder (previous), or directly under the images root (oldest).
    """
    folder_name = normalize_text(product.get("folder"))
    date_folder = normalize_text(product.get("date_folder"))
    if date_folder:
        return os.path.join(BASE_DIR, date_folder, folder_name)
    brand_folder = normalize_text(product.get("brand_folder"))
    if brand_folder:
        return os.path.join(BASE_DIR, brand_folder, folder_name)
    return os.path.join(BASE_DIR, folder_name)


# =========================================================
# Arabic: مزامنة اختيارية بين مستخدمين عبر سكربت PHP بسيط (sync.php) على Hostinger.
# لا تُفعَّل هذه المزامنة إلا بعد ضبط SyncConfig (رابط + مفتاح) من لوحة الإضافة.
# منطق المزامنة الحي في app.services.sync_service. الحلقة أدناه كود ميت (قرار الجرد 4) ولا تُشغَّل.
# English: Optional two-user sync via a small PHP endpoint (sync.php) hosted on Hostinger.
# Disabled by default until SyncConfig (URL + token) is set from the extension popup.
# Live sync logic is in app.services.sync_service. The loop below is dead code (inventory decision 4) and is never started.
# =========================================================


def sync_background_worker():
    """Arabic: خيط خلفي يسحب تحديثات الطرف الآخر ويعيد إرسال الطابور دورياً كل 90 ثانية. English: Background thread that pulls the other side's updates and flushes the retry queue every 90 seconds."""
    while True:
        try:
            sync_pull_updates()
            sync_flush_queue()
        except Exception as exc:
            logger.warning("Sync background cycle failed: %s", exc)
        time.sleep(90)


# =============================================================================
# Arabic: هذا الملف أصبح stub فارغاً بعد اكتمال إعادة الهيكلة (Phase 5).
#         كل الـ routes انتقلت إلى:
#           backend/app/api/routes/core_routes.py    (health, paths, brands)
#           backend/app/api/routes/sync_routes.py     (sync/*)
#           backend/app/api/routes/reports_routes.py  (reports, data-repair, logs)
#           backend/app/api/routes/upload_routes.py   (extract, ai, archive, check)
#
#         نقطة التشغيل الجديدة:
#           cd backend && python -m app.main
#
# English: This file is now a legacy stub after Phase 5 refactoring completion.
#          All routes live in backend/app/api/routes/*.py
#          New entry point: cd backend && python -m app.main
# =============================================================================


if __name__ == "__main__":
    import sys as _sys
    print("[app.py] هذا الملف لم يعد نقطة التشغيل. استخدم:", file=_sys.stderr)
    print("  cd backend", file=_sys.stderr)
    print("  python -m app.main", file=_sys.stderr)
    _sys.exit(1)
