"""Arabic: تحميل ملفات الإعداد JSON ومساراتها. English: Load JSON config files and their paths."""
import json
import logging
import os
import uuid

logger = logging.getLogger("alphacode")

# Arabic: جذر backend/ = أب حزمة app (نفس SCRIPT_DIR في app.py).
# English: backend/ root = parent of the app package (same as SCRIPT_DIR in app.py).
_CORE_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_PACKAGE_DIR = os.path.dirname(_CORE_DIR)
BACKEND_ROOT = os.path.dirname(_APP_PACKAGE_DIR)

PATHS_CONFIG_PATH = os.path.join(BACKEND_ROOT, "config", "paths_config.json")
SYNC_CONFIG_PATH = os.path.join(BACKEND_ROOT, "config", "sync_config.json")
SYNC_QUEUE_PATH = os.path.join(BACKEND_ROOT, "data", "sync_queue.json")
SYNC_STATE_PATH = os.path.join(BACKEND_ROOT, "data", "sync_state.json")


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
