import os
import re
import sys
import json
import uuid
import shutil
import hashlib
import subprocess
from datetime import datetime
import logging
from logging.handlers import RotatingFileHandler
import pandas as pd
import requests
from app.core.runtime import paths_state
from app.repositories import archive_repository
logger = logging.getLogger(__name__)

from flask import request, jsonify
import certifi

SYNC_REQUEST_PACING_SECONDS = 0.5
ROOT_DIR = paths_state.ROOT_DIR
LOG_DIR = paths_state.LOG_DIR
PRICE_PATTERNS_LOG_PATH = paths_state.PRICE_PATTERNS_LOG_PATH
DEFAULT_AI_PROVIDER = 'groq'
DEFAULT_AI_MODEL = 'llama-3.1-70b-versatile'
DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'
GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/chat/completions'



# Stub variables from app.py
EXCEL_COLUMNS = ['Id', 'Name', 'Description', 'Image', 'CategoryId', 'SubCategoryId', 'UnitId', 'Stock', 'Price', 'Discount', 'DiscountType', 'AvailableTimeStarts', 'AvailableTimeEnds', 'Variations', 'ChoiceOptions', 'AddOns', 'Attributes', 'StoreId', 'ModuleId', 'Status', 'Veg', 'Recommended']
INVALID_MARKERS = {"", "NONE", "NULL", "UNDEFINED", "غير محدد", "NO_CODE", "NO_STYLE"}
MIN_REQUIRED_PRODUCT_IMAGES = 1
AI_PROMPT_VERSION = 'v4'
GROQ_OFFICIAL_SEARCH_MODEL = 'llama-3.1-70b-versatile'
HEADERS = {'User-Agent': 'Mozilla/5.0'}
import threading
SAVE_LOCK = threading.RLock()
class AIProviderRequestError(Exception):
    def __init__(self, message, status_code, payload):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload

def handle_local_request_too_large(_error):
    """Arabic: إعادة خطأ 413 بصيغة تفهمها الإضافة. English: Return local HTTP 413 as extension-friendly JSON."""
    return jsonify({
        "success": False,
        "request_too_large": True,
        "error": "حجم البيانات المرسلة إلى الخادم المحلي أكبر من الحد المسموح.",
    }), 413

class ColoredConsoleFormatter(logging.Formatter):
    """
    Arabic: منسّق ألوان لطرفية التطوير فقط (لا يُستخدم لملف السجل الخارجي حتى لا تُكتب
            رموز ANSI داخل ملف نصي). كل مستوى له لون خلفية مميز لتسهيل تتبّع السجل بالعين.
            نُقلت هذي الكلاس من app.py (الـstub الميت) - كانت configure_application_logging()
            هنا تستدعيها بدون أي تعريف/استيراد لها بهذا الملف (NameError لو استُدعيت فعلياً)،
            نفس نمط "نقل جزئي" موثّق 3 مرات سابقة بمشروع الريفاكتور.
    English: Colour formatter for the developer terminal only (never used for the rotating
             file handler, so ANSI escape codes never end up inside a plain-text log file).
             Each level gets a distinct background colour for fast at-a-glance scanning.
             Moved here from app.py (the dead stub) - configure_application_logging() here
             was calling it without any definition/import in this file (a NameError if ever
             actually invoked), the same "partial move" pattern documented 3 prior times in
             this refactor.
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
        pass

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")


class PlainFileFormatter(logging.Formatter):
    """
    Arabic: نفس تنسيق الملف الخام، لكن يجرّد أي رمز ANSI ملوَّن من الرسالة قبل الكتابة.
            Werkzeug نفسه يُضمّن رموز ألوان داخل نص بعض رسائله (تحذير وضع التطوير،
            طلبات بحالة غير 200) - هذي الرموز تتسرّب لملف السجل الخام بدون هذا التجريد
            (اكتُشف بتشغيل فعلي: أسطر قديمة بـalphacode.log فيها \\x1b[33m...\\x1b[0m حرفياً).
    English: Same plain file format, but strips any ANSI colour codes from the message
             before writing. Werkzeug itself embeds colour codes inside some of its own
             messages (the dev-server warning, non-200 request lines) - without this
             stripping they leak straight into the plain-text log file (found via live
             testing: old alphacode.log lines contained literal \\x1b[33m...\\x1b[0m).
    """

    def format(self, record):
        return _ANSI_ESCAPE_RE.sub("", super().format(record))


def configure_application_logging():
    """Arabic: تهيئة سجل خارجي دوّار مع طباعة ملوّنة وواضحة في الطرفية. English: Configure rotating external logs with a clear, colourful console output."""
    _enable_windows_ansi_support()
    file_format = PlainFileFormatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
    console_format = ColoredConsoleFormatter()
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    if not any(getattr(handler, "_alphacode_console", False) for handler in root_logger.handlers):
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(console_format)
        console_handler._alphacode_console = True
        root_logger.addHandler(console_handler)

    try:
        # Arabic: نستخدم مجلد paths_state.LOG_PATH الحي (مو ثابت LOG_DIR المحسوب وقت
        #         الاستيراد) لأن مسار الحفظ متغيّر وقت التشغيل حسب اختيار المستخدم.
        # English: Using paths_state.LOG_PATH's live directory (not the import-time LOG_DIR
        #          constant) since the save path is recomputed at runtime based on the
        #          user's chosen folder.
        os.makedirs(os.path.dirname(paths_state.LOG_PATH), exist_ok=True)
        if not any(getattr(handler, "_alphacode_file", False) for handler in root_logger.handlers):
            file_handler = RotatingFileHandler(
                paths_state.LOG_PATH,
                maxBytes=5 * 1024 * 1024,
                backupCount=5,
                encoding="utf-8",
            )
            file_handler.setFormatter(file_format)
            file_handler._alphacode_file = True
            root_logger.addHandler(file_handler)
    except OSError as exc:
        root_logger.warning("Could not initialize external log file %s: %s", paths_state.LOG_PATH, exc)

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
    if not os.path.exists(paths_state.LOG_PATH):
        return []
    with open(paths_state.LOG_PATH, "r", encoding="utf-8", errors="replace") as log_file:
        lines = log_file.readlines()
    return [line.rstrip("\n") for line in lines[-safe_limit:]]

def load_archive():
    """Arabic: تحميل أرشيف المنتجات المحلي. English: Load the local product archive."""
    return archive_repository.load_archive(paths_state.ARCHIVE_PATH)

def save_archive(archive):
    """Arabic: حفظ أرشيف المنتجات المحلي كاملاً. English: Persist the full local product archive."""
    archive_repository.save_archive(paths_state.ARCHIVE_PATH, archive)

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
    

    cfg = load_paths_config()
    chosen = normalize_text(cfg.get("RootDir"))
    candidate = chosen or os.getenv("ALPHACODE_ROOT_DIR", SCRIPT_DIR)

    ROOT_DIR = candidate
    paths_state.BASE_DIR = os.path.join(ROOT_DIR, IMAGES_FOLDER_NAME)
    paths_state.EXCEL_PATH = os.path.join(ROOT_DIR, "items_bulk_format_nodata.xlsx")
    paths_state.ARCHIVE_PATH = os.path.join(ROOT_DIR, "archive_db.json")
    AI_CACHE_PATH = os.path.join(ROOT_DIR, "ai_copy_cache.json")
    LOG_DIR = os.path.join(ROOT_DIR, "logs")
    paths_state.LOG_PATH = os.path.join(LOG_DIR, "alphacode.log")
    PRICE_PATTERNS_LOG_PATH = os.path.join(LOG_DIR, "price_patterns.jsonl")

    if chosen and not os.path.isdir(ROOT_DIR):
        try:
            os.makedirs(ROOT_DIR, exist_ok=True)
        except OSError as exc:
            logger.warning("Could not create the configured root folder %s: %s", ROOT_DIR, exc)

    ROOT_DIR_CONFIGURED = bool(chosen) and is_root_dir_valid(ROOT_DIR)
    reconfigure_logging_target()
    return ROOT_DIR_CONFIGURED

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
    """Arabic: مسار مجلد صور البراند المحدد داخل paths_state.BASE_DIR. English: The brand-specific image folder inside paths_state.BASE_DIR."""
    return os.path.join(paths_state.BASE_DIR, get_brand_folder_name(brand_name))

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
        return os.path.join(paths_state.BASE_DIR, date_folder, folder_name)
    brand_folder = normalize_text(product.get("brand_folder"))
    if brand_folder:
        return os.path.join(paths_state.BASE_DIR, brand_folder, folder_name)
    return os.path.join(paths_state.BASE_DIR, folder_name)

def sync_background_worker():
    """Arabic: خيط خلفي يسحب تحديثات الطرف الآخر ويعيد إرسال الطابور دورياً كل 90 ثانية. English: Background thread that pulls the other side's updates and flushes the retry queue every 90 seconds."""
    while True:
        try:
            sync_pull_updates()
            sync_flush_queue()
        except Exception as exc:
            logger.warning("Sync background cycle failed: %s", exc)
        time.sleep(90)

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

def scan_data_repair_issues():
    """
    Arabic: يفحص الأرشيف المحلي (وقاعدة السيرفر عند تفعيل المزامنة) ويرجّع:
            missing_fields: كل حقل مرجعي ناقص مع قائمة المنتجات (key/id) الناقصة له.
            extra_fields: كل حقل زائد غير موجود بالشكل المرجعي (للتبليغ فقط بدون تعديل).
            errors: منتج بدون id، id مكرر، سجل تالف (ليس Object)، أو تعارض بيانات مع السيرفر.
    English: Scans the local archive (and the server when sync is enabled) and returns
             missing_fields (each missing reference field with the affected product
             key/id), extra_fields (fields outside the reference shape, report-only), and
             errors (no id, duplicate id, a corrupted non-dict entry, or a real data
             conflict against the server copy of the same product).
    """
    raw_archive = load_archive()

    missing_fields = {}
    extra_fields = {}
    errors = []
    seen_ids = {}

    for key, item in raw_archive.items():
        if str(key).startswith("_"):
            continue
        if not isinstance(item, dict):
            errors.append({
                "type": "corrupted_entry", "key": key, "id": None,
                "message": "هذا السجل ليس بصيغة منتج صالحة (Corrupted / not a JSON object).",
            })
            continue

        product_id = item.get("id")
        if product_id is None:
            errors.append({
                "type": "missing_id", "key": key, "id": None,
                "message": "منتج بدون id (قد يكون سجل حجز معلّق).",
            })
        elif product_id in seen_ids:
            errors.append({
                "type": "duplicate_id", "key": key, "id": product_id,
                "message": f"id مكرر مع المفتاح {seen_ids[product_id]}.",
            })
        else:
            seen_ids[product_id] = key

        for field in REFERENCE_PRODUCT_FIELDS:
            if field not in item:
                missing_fields.setdefault(field, []).append({"key": key, "id": product_id})

        for field in item.keys():
            if field not in REFERENCE_PRODUCT_FIELDS:
                extra_fields.setdefault(field, []).append({"key": key, "id": product_id})

    # Arabic: مقارنة مع نسخة السيرفر إن كانت المزامنة مفعّلة - قراءة فقط، بدون أي تعديل.
    # English: Compare against the server copy when sync is enabled - read-only, no writes.
    sync_config = load_sync_config()
    if sync_config.get("Enabled"):
        data, error = sync_call("pull", {"since": ""}, method="POST")
        if error:
            errors.append({
                "type": "server_unreachable", "key": None, "id": None,
                "message": f"تعذر الوصول للسيرفر لمقارنة البيانات: {error}",
            })
        else:
            remote_items = (data or {}).get("items") or {}
            for key, local_item in raw_archive.items():
                if str(key).startswith("_") or not isinstance(local_item, dict):
                    continue
                remote_item = remote_items.get(key)
                if not remote_item:
                    continue
                local_compare = {k: v for k, v in local_item.items() if k not in DATA_REPAIR_CONFLICT_IGNORED_FIELDS}
                remote_compare = {k: v for k, v in remote_item.items() if k not in DATA_REPAIR_CONFLICT_IGNORED_FIELDS}
                if local_compare != remote_compare:
                    errors.append({
                        "type": "server_conflict", "key": key, "id": local_item.get("id"),
                        "message": "بيانات المنتج على الجهاز تختلف عن نسخة السيرفر.",
                    })

    return {"missing_fields": missing_fields, "extra_fields": extra_fields, "errors": errors}

def apply_data_repair_fix(field_values):
    """
    Arabic: يعبّئ كل حقل ناقص بالقيمة الافتراضية اللي أدخلها المشغّل، لكل المنتجات المحلية
            الناقصة لذلك الحقل فقط (لا يلمس منتجاً آخر ولا يستبدل قيمة موجودة أصلاً). يأخذ
            نسخة احتياطية كاملة من archive_db.json قبل أي تعديل، يحفظ، ثم يرفع كل منتج
            تم تعديله للسيرفر عبر آلية المزامنة الموجودة.
    English: Fills each missing field with the operator-entered default value, only for
             local products actually missing that field (never touches other products or
             overwrites an existing value). Takes a full backup of archive_db.json before
             any change, saves, then pushes every changed product to the server through
             the existing sync mechanism.
    """
    if not isinstance(field_values, dict) or not field_values:
        return {"success": False, "error": "No field values were provided."}

    with SAVE_LOCK:
        archive = load_archive()

        backup_path = None
        if os.path.exists(paths_state.ARCHIVE_PATH):
            backup_name = f"archive_db.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            backup_path = os.path.join(os.path.dirname(paths_state.ARCHIVE_PATH), backup_name)
            shutil.copy2(paths_state.ARCHIVE_PATH, backup_path)

        updated_keys = []
        per_field_counts = {}
        for field, default_value in field_values.items():
            count = 0
            for key, item in archive.items():
                if str(key).startswith("_") or not isinstance(item, dict):
                    continue
                if field not in item:
                    item[field] = default_value
                    if key not in updated_keys:
                        updated_keys.append(key)
                    count += 1
            per_field_counts[field] = count

        save_archive(archive)

    push_errors = []
    pushed = 0
    for key in updated_keys:
        try:
            sync_push_product(key, archive.get(key))
            pushed += 1
        except Exception as exc:
            logger.warning("Data-repair sync push failed for %s: %s", key, exc)
            push_errors.append({"key": key, "error": str(exc)})
        # Arabic: نفس تأخير التهدئة المستخدم في المزامنة الجماعية، لتفادي إغراق الاستضافة.
        # English: Same pacing delay used in bulk sync, to avoid flooding the host.
        time.sleep(SYNC_REQUEST_PACING_SECONDS)

    logger.info(
        "Data repair applied. fields=%s updated_products=%s pushed=%s backup=%s",
        per_field_counts, len(updated_keys), pushed, backup_path,
    )
    return {
        "success": True, "backup_path": backup_path, "updated_products": len(updated_keys),
        "per_field_counts": per_field_counts, "pushed": pushed, "push_errors": push_errors,
    }

def generate_data_repair_reports():
    """Arabic: يولّد ملفي Excel: تقرير الأخطاء وتقرير الحقول الزائدة، داخل مجلد reports. English: Generates two Excel files - an errors report and an extra-fields report - inside the reports folder."""
    scan = scan_data_repair_issues()
    reports_dir = os.path.join(ROOT_DIR, "reports")
    os.makedirs(reports_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    errors_filename = f"data_repair_errors_{timestamp}.xlsx"
    errors_rows = [
        {"النوع / Type": e["type"], "المفتاح / Key": e["key"], "ID": e["id"], "التفاصيل / Details": e["message"]}
        for e in scan["errors"]
    ]
    pd.DataFrame(errors_rows, columns=["النوع / Type", "المفتاح / Key", "ID", "التفاصيل / Details"]).to_excel(
        os.path.join(reports_dir, errors_filename), index=False
    )

    extra_filename = f"data_repair_extra_fields_{timestamp}.xlsx"
    extra_rows = [
        {"الحقل الزائد / Extra field": field, "المفتاح / Key": entry["key"], "ID": entry["id"]}
        for field, entries in scan["extra_fields"].items() for entry in entries
    ]
    pd.DataFrame(extra_rows, columns=["الحقل الزائد / Extra field", "المفتاح / Key", "ID"]).to_excel(
        os.path.join(reports_dir, extra_filename), index=False
    )

    return errors_filename, extra_filename

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

def create_temp_excel(new_row, token):
    """Arabic: إنشاء نسخة Excel مؤقتة قبل اعتماد المعاملة. English: Create a temporary Excel copy before committing the transaction."""
    directory = os.path.dirname(paths_state.EXCEL_PATH)
    os.makedirs(directory, exist_ok=True)
    temp_path = os.path.join(directory, f".{os.path.basename(paths_state.EXCEL_PATH)}.{token}.xlsx")
    if os.path.exists(paths_state.EXCEL_PATH):
        dataframe = pd.read_excel(paths_state.EXCEL_PATH)
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
    targets = [paths_state.EXCEL_PATH, paths_state.ARCHIVE_PATH]
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

def enforce_arabic_product_name(name, source_text, style_code, brand_name="", product_type="shoes"):
    """Arabic: منع تكرار البراند في الاسم العربي وتنسيق الارتفاع والكود؛ يتفرّع حسب نوع المنتج. English: Prevent duplicated Arabic branding and normalize silhouette/style code; branches by product type."""
    final_name = re.sub(r"\s+", " ", normalize_text(name)).strip(" -–—|")
    exact_style_code = normalize_text(style_code).upper()
    selected_brand = canonicalize_brand_name(brand_name)

    if product_type == "watches":
        # Arabic: بدون أي تحويل لمصطلحات الارتفاع (خاصة بالأحذية فقط)؛ فقط بادئة "ساعة" وكود الستايل إن وُجد.
        # English: No silhouette-word translation (shoes-only); just a "ساعة" prefix and the style code if present.
        final_name = re.sub(r"^ساعة\s+", "", final_name).strip()
        if selected_brand:
            escaped = re.escape(selected_brand)
            final_name = re.sub(rf"\b{escaped}\b", " ", final_name, flags=re.I)
            final_name = re.sub(r"\s+", " ", final_name).strip(" -–—|")
            final_name = f"ساعة {selected_brand} {final_name}".strip()
        else:
            final_name = f"ساعة {final_name}".strip()

        if exact_style_code:
            final_name = re.sub(
                rf"\s*[-–—|]?\s*{re.escape(exact_style_code)}\b",
                "",
                final_name,
                flags=re.I,
            ).strip(" -–—|")
            final_name = f"{final_name} - {exact_style_code}"

        return re.sub(r"\s+", " ", final_name).strip()[:210]

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
        "variants": archive_item.get("variants") or [],
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
    directory = os.path.dirname(paths_state.EXCEL_PATH)
    os.makedirs(directory, exist_ok=True)
    temp_path = os.path.join(directory, f".{os.path.basename(paths_state.EXCEL_PATH)}.{token}.xlsx")
    if os.path.exists(paths_state.EXCEL_PATH):
        dataframe = pd.read_excel(paths_state.EXCEL_PATH)
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
    targets = [paths_state.ARCHIVE_PATH, paths_state.EXCEL_PATH]
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
    """Arabic: حذف مجلد صور منتج واحد بأمان داخل مجلد البراند الخاص به فقط. English: Safely remove one product image folder within its own brand folder only."""
    folder_name = normalize_text(product.get("folder"))
    if not folder_name:
        return False
    base_real = os.path.realpath(paths_state.BASE_DIR)
    folder_real = os.path.realpath(get_product_image_dir(product))
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
        save_archive(updated)
        return item

def log_price_pattern(source_text, raw_price_token, parsed_price, product_type, style_code, search_code, extra=None):
    """
    Arabic: يسجّل كل نمط سعر جديد يصادفه المستخرج في ملف JSONL منفصل (price_patterns.jsonl)
            للمطور فقط — يساعد في رصد صيغ البائعين غير المعروفة وتحسين استخراج الأسعار لاحقاً.
            لا يحتوي على بيانات شخصية ولا أسعار نهائية للمتجر.
    English: Logs every price pattern the extractor encounters into a separate JSONL file
             (price_patterns.jsonl) for the developer only - helps track unknown seller
             formats and improve price extraction later. Contains no personal data or final
             store prices.
    """
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        entry = {
            "ts": datetime.now().isoformat(),
            "product_type": product_type,
            "style_code": style_code or "",
            "search_code": search_code or "",
            "raw_token": str(raw_price_token or "")[:200],
            "parsed_price": parsed_price,
            "source_sample": str(source_text or "")[:300],
            **(extra or {}),
        }
        with open(PRICE_PATTERNS_LOG_PATH, "a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as exc:
        logger.debug("price_pattern log write failed: %s", exc)

def record_client_log_internal(level_name, event_name, message, details):
    level = getattr(logging, level_name.upper(), logging.INFO)
    logger.log(level, "CLIENT | event=%s | message=%s | details=%s", event_name, message, json.dumps(details, ensure_ascii=False))
    # Arabic: لو الحدث من نوع اكتشاف نمط سعر جديد، نسجّله في ملف منفصل.
    # English: If the event is a new price pattern discovery, log it separately.
    if event_name in ("price_pattern_new", "price_pattern_unknown"):
        log_price_pattern(
            source_text=details.get("source_sample"),
            raw_price_token=details.get("raw_token"),
            parsed_price=details.get("parsed_price"),
            product_type=details.get("product_type"),
            style_code=details.get("style_code"),
            search_code=details.get("search_code"),
            extra={"event": event_name, "message": message},
        )

def log_failed_http_responses(response):
    """Arabic: تسجيل طلبات HTTP الفاشلة لتسهيل التشخيص. English: Log failed HTTP responses for easier diagnostics."""
    if response.status_code >= 400:
        logger.warning("HTTP %s %s -> %s", request.method, request.path, response.status_code)
    return response

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

def build_normal_ai_messages(source_text, original_product_name, style_code, search_code, sizes, configured_brand, allowed_brands, arabic_style, product_type="shoes"):
    """Arabic: بناء تعليمات كتابة عادية دون بحث ويب. English: Build normal-generation messages without web research."""
    if product_type == "watches":
        role_line = "You are a senior luxury-watch e-commerce catalog writer fluent in English and Arabic."
        english_bullets = (
            "- Use the canonical brand and exact model/collection when supported.\n"
            "- Write a concise title with model/collection name, case material or dial color when verified, "
            "and the exact reference/style code once at the end only if one was supplied.\n"
            "- Write 2–3 factual commercial sentences about the movement, case, or design details actually present in the evidence."
        )
        arabic_open_line = "- Begin with ساعة and keep the configured brand name as written."
        never_line = "NEVER include supplier name, Search Code, price, shipping, Chinese text, emojis, authenticity/grade claims, or invented available colors/sizes."
        available_line = f"Reference/style code (only if supplied): {compact_prompt_text(style_code, 80) or 'Not provided'}\n"
    else:
        role_line = "You are a senior footwear e-commerce catalog writer fluent in English and Arabic."
        english_bullets = (
            "- Use the canonical brand and exact model when supported.\n"
            "- Write a concise title with model, silhouette/type, verified colorway or nickname when present, "
            "and the exact Style Code once at the end.\n"
            "- Write 2–3 factual commercial sentences and mention the available size range in the final sentence."
        )
        arabic_open_line = "- Begin with حذاء and write Air Jordan as إير جوردن."
        never_line = "NEVER include supplier name, Search Code, price, shipping, Chinese text, emojis, replica/authenticity claims, or quality grades."
        available_line = f"Available sizes: {', '.join(unique_text_values(sizes)[:40])[:300] or 'Not provided'}\n"

    instructions = f"""
{role_line}
Use only the supplied evidence. Never browse during this first generation and never invent colors, materials, gender, edition, technology, collaboration, authenticity, or performance benefits.

ENGLISH:
{english_bullets}

ARABIC — STYLE: {arabic_style}:
- Create an original Arabic sales title, not a word-for-word translation and not necessarily in the English order.
{arabic_open_line}
- Lead with the strongest useful verified identity: model, attractive color combination, edition, or design character.
- Use natural Arabic suitable for an online store. Avoid awkward transliteration and mixed English filler.
- The Arabic description may reorder facts and use a warmer, more persuasive tone than English, but it must remain accurate.
- Never promise comfort, durability, performance, originality, or quality unless explicitly verified.

{never_line}
BRAND SAFETY: brand_name must be one of the ALLOWED BRANDS supplied by the user. Never invent or infer an unlisted brand.
Return exactly one JSON object with: name_en, description_en, name_ar, description_ar, brand_name.
""".strip()

    compact_source = compact_prompt_text(source_text, 3200)
    compact_original = compact_prompt_text(original_product_name, 320)
    user_input = (
        f"Original supplier name:\n{compact_original or 'Not provided'}\n\n"
        f"Supplier product text:\n{compact_source or 'Not provided'}\n\n"
        f"Exact Style Code: {compact_prompt_text(style_code, 80) or 'Not provided'}\n"
        f"Internal Search Code — never include it: {compact_prompt_text(search_code, 80) or 'Not provided'}\n"
        f"{available_line}"
        f"Configured brand hint: {compact_prompt_text(configured_brand, 100) or 'Not provided'}\n"
        f"ALLOWED BRANDS: {', '.join(allowed_brands) or configured_brand or 'Not provided'}\n"
        "Write polished bilingual store copy now."
    )
    return [
        {"role": "system", "content": instructions},
        {"role": "user", "content": user_input},
    ]

def build_official_research_prompt(official_domain, original_product_name, style_code, product_type="shoes"):
    """Arabic: برومبت بحث رسمي صغير للمنتج الحالي فقط. English: Build a compact official-domain research prompt for the current product only."""
    if product_type == "watches":
        subject_line = (
            f'Search only the official domain {official_domain} for this exact watch, '
            f'reference/style code if provided: "{compact_prompt_text(style_code, 80) or "Not provided"}".'
        )
        fields_line = (
            "Return a factual dossier under 180 words: verification status, canonical brand, exact model/collection, "
            "official name/reference, case material, dial color, movement type if stated, and uncertainties."
        )
    else:
        subject_line = (
            f'Search only the official domain {official_domain} for the exact footwear Style Code '
            f'"{compact_prompt_text(style_code, 80) or "Not provided"}".'
        )
        fields_line = (
            "Return a factual dossier under 180 words: verification status, canonical brand, exact model/silhouette, "
            "official name/edition, colorway, audience, materials, visible design details, footwear type, and uncertainties."
        )
    return f"""
{subject_line}
Optional supplier name: {compact_prompt_text(original_product_name, 260) or 'Not provided'}
Use one search operation only. Reject mismatched products and all retailers, marketplaces, blogs, social media, and reseller databases.
{fields_line}
If not found, state NOT FOUND OFFICIALLY. Do not write marketing copy.
""".strip()

def build_official_rewrite_messages(official_research, source_text, original_product_name, style_code, search_code, sizes, configured_brand, allowed_brands, arabic_style, product_type="shoes"):
    """Arabic: بناء صياغة نهائية بعد البحث الرسمي. English: Build final-copy messages after official research."""
    if product_type == "watches":
        role_line = "You are the final catalog editor for a luxury-watch e-commerce store."
        arabic_open_line = "- Begin the title with ساعة and keep the configured brand name as written."
        available_line = f"REFERENCE/STYLE CODE (only if supplied): {compact_prompt_text(style_code, 80) or 'Not provided'}\n"
    else:
        role_line = "You are the final catalog editor for a footwear e-commerce store."
        arabic_open_line = "- Begin the title with حذاء and use إير جوردن when applicable."
        available_line = f"AVAILABLE SIZES: {', '.join(unique_text_values(sizes)[:40])[:300] or 'Not provided'}\n"

    instructions = f"""
{role_line}
Use official facts first; use supplier facts only when they do not conflict. Omit uncertainty.

ENGLISH: create a precise catalog title and 2–3 factual commercial sentences.

ARABIC — STYLE: {arabic_style}:
- Create a compelling Arabic product identity independently from the English syntax.
{arabic_open_line}
- Highlight the strongest verified reason to notice the product: model, color combination, edition, or design character.
- Use fluent modern Arabic suitable for Gulf e-commerce customers without exaggeration.
- The Arabic description may use a different sentence order and a warmer selling tone, while keeping all facts verified.
- Avoid generic filler and unsupported claims about comfort, quality, originality, performance, or durability.

Put the exact Style Code once at the end of each title only if one was supplied. Never include Search Code, price, supplier name, Chinese text, emojis, or authenticity/grade claims.
BRAND SAFETY: brand_name must be one of the ALLOWED BRANDS supplied by the user. Never invent or infer an unlisted brand.
Return exactly one JSON object with: name_en, description_en, name_ar, description_ar, brand_name.
""".strip()
    user_input = f"""
OFFICIAL RESEARCH:
{compact_prompt_text(official_research, 1400)}

SUPPLIER NAME:
{compact_prompt_text(original_product_name, 320) or 'Not provided'}

SUPPLIER TEXT:
{compact_prompt_text(source_text, 1200) or 'Not provided'}

STYLE CODE: {compact_prompt_text(style_code, 80) or 'Not provided'}
INTERNAL SEARCH CODE — NEVER INCLUDE: {compact_prompt_text(search_code, 80) or 'Not provided'}
{available_line}BRAND HINT: {compact_prompt_text(configured_brand, 100) or 'Not provided'}
ALLOWED BRANDS: {', '.join(allowed_brands) or configured_brand or 'Not provided'}
""".strip()
    return [
        {"role": "system", "content": instructions},
        {"role": "user", "content": user_input},
    ]

def make_provider_payload(runtime, messages, max_tokens, json_output=True, schema=None, schema_name="alphacode_product_copy"):
    """Arabic: تحويل الرسائل إلى تنسيق المزود المختار - schema اختياري لاستخدامات غير توليد المحتوى (افتراضياً يبقى نفس سلوك الأسماء/الأوصاف كما هو). English: Convert messages into the selected provider API format - schema is optional for non-copy uses (defaults to the exact same name/description behavior as before)."""
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
                    "name": schema_name,
                    "strict": True,
                    "schema": schema if schema is not None else product_copy_schema(),
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

        # Arabic: أي HTTP 4xx آخر غير متوقع (401/403/422 إلخ) — نرجّع tuple خطأ منظّم بدل
        #         raise RuntimeError عشان كل الـendpoints تتعامل معه بنفس الطريقة.
        # English: Any other unexpected HTTP 4xx (401/403/422 etc.) — return a structured
        #          error tuple instead of raising RuntimeError so every caller handles it the same way.
        return None, {
            "success": False,
            "error": message or f"AI provider HTTP {response.status_code}: {response.text[:200]}",
            "http_status": response.status_code,
            "stage": stage,
            "provider": runtime.get("provider"),
        }, response.status_code

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

def generate_official_research(runtime, official_domain, original_product_name, style_code, product_type="shoes"):
    """Arabic: تنفيذ بحث رسمي واحد عبر Groq أو OpenAI. English: Run one official-domain research operation through Groq or OpenAI."""
    prompt = build_official_research_prompt(official_domain, original_product_name, style_code, product_type)

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

