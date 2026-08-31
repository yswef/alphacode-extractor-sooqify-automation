"""Arabic: قراءة/كتابة sync_config.json. English: Read/write sync_config.json."""
from app.core.config import SYNC_CONFIG_PATH, load_json_file, save_json_atomic


def _normalize_text(value):
    """Arabic: توحيد النصوص قبل التخزين. English: Normalize text before storage."""
    return str(value or "").strip()


def _safe_bool(value, fallback=False):
    """Arabic: قراءة القيم المنطقية. English: Parse boolean-like values."""
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def load_sync_config():
    """Arabic: قراءة إعدادات المزامنة (تفعيل، رابط، مفتاح، اسم المستخدم). English: Read sync settings (enabled, URL, token, user name)."""
    defaults = {"Enabled": False, "ServerUrl": "", "Token": "", "AddedByName": ""}
    stored = load_json_file(SYNC_CONFIG_PATH, {})
    defaults.update({key: stored.get(key, defaults[key]) for key in defaults})
    return defaults


def save_sync_config(config):
    """Arabic: حفظ إعدادات المزامنة بعد تنظيفها. English: Persist sanitized sync settings."""
    save_json_atomic(SYNC_CONFIG_PATH, {
        "Enabled": _safe_bool(config.get("Enabled"), False),
        "ServerUrl": _normalize_text(config.get("ServerUrl")).rstrip("/"),
        "Token": _normalize_text(config.get("Token")),
        "AddedByName": _normalize_text(config.get("AddedByName"))[:60],
    })
