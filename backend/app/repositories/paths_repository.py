"""Arabic: قراءة/كتابة paths_config.json. English: Read/write paths_config.json."""
from app.core.config import PATHS_CONFIG_PATH, load_json_file, save_json_atomic


def load_paths_config():
    """Arabic: قراءة إعداد المجلد المخصص المحفوظ محلياً. English: Read the locally saved custom-folder setting."""
    return load_json_file(PATHS_CONFIG_PATH, {})


def save_paths_config(config):
    """Arabic: حفظ إعداد المجلد المخصص. English: Persist the custom-folder setting."""
    save_json_atomic(PATHS_CONFIG_PATH, config)
