import os
import logging
from app.repositories.paths_repository import load_paths_config
from app.core.utils import normalize_text

logger = logging.getLogger(__name__)

# Arabic: تحديد ثوابت البيئة. English: Environment constants.
SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMAGES_FOLDER_NAME = "images"

class RuntimePaths:
    """Arabic: مدير حالة المسارات وقت التشغيل. English: Runtime paths state manager."""
    def __init__(self):
        self.ROOT_DIR = ""
        self.BASE_DIR = ""
        self.EXCEL_PATH = ""
        self.ARCHIVE_PATH = ""
        self.AI_CACHE_PATH = ""
        self.LOG_DIR = ""
        self.LOG_PATH = ""
        self.PRICE_PATTERNS_LOG_PATH = ""
        self.ROOT_DIR_CONFIGURED = False
        
        self.recompute()
        
    def recompute(self):
        cfg = load_paths_config()
        chosen = normalize_text(cfg.get("RootDir"))
        candidate = chosen or os.getenv("ALPHACODE_ROOT_DIR", SCRIPT_DIR)

        self.ROOT_DIR = candidate
        self.BASE_DIR = os.path.join(self.ROOT_DIR, IMAGES_FOLDER_NAME)
        self.EXCEL_PATH = os.path.join(self.ROOT_DIR, "items_bulk_format_nodata.xlsx")
        self.ARCHIVE_PATH = os.path.join(self.ROOT_DIR, "archive_db.json")
        self.AI_CACHE_PATH = os.path.join(self.ROOT_DIR, "ai_copy_cache.json")
        self.LOG_DIR = os.path.join(self.ROOT_DIR, "logs")
        self.LOG_PATH = os.path.join(self.LOG_DIR, "alphacode.log")
        self.PRICE_PATTERNS_LOG_PATH = os.path.join(self.LOG_DIR, "price_patterns.jsonl")

        if chosen and not os.path.isdir(self.ROOT_DIR):
            try:
                os.makedirs(self.ROOT_DIR, exist_ok=True)
            except OSError as exc:
                logger.warning("Could not create the configured root folder %s: %s", self.ROOT_DIR, exc)

        self.ROOT_DIR_CONFIGURED = bool(chosen) and self.is_root_dir_valid(self.ROOT_DIR)
        
        # Logging reconfiguration happens centrally in main.py, so we just set variables here.
        return self.ROOT_DIR_CONFIGURED

    def is_root_dir_valid(self, path):
        """Arabic: التحقق من صلاحية المجلد. English: Validate folder permissions."""
        if not path or not os.path.isdir(path):
            return False
        try:
            test_file = os.path.join(path, ".write_test")
            with open(test_file, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(test_file)
            return True
        except Exception:
            return False

paths_state = RuntimePaths()

def get_archive_path():
    return paths_state.ARCHIVE_PATH

def get_excel_path():
    return paths_state.EXCEL_PATH

def get_base_dir():
    return paths_state.BASE_DIR

def get_root_dir():
    return paths_state.ROOT_DIR

def get_log_path():
    return paths_state.LOG_PATH

def get_price_patterns_log_path():
    return paths_state.PRICE_PATTERNS_LOG_PATH
