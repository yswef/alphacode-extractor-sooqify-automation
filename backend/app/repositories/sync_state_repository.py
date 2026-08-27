"""Arabic: قراءة/كتابة sync_state.json. English: Read/write sync_state.json."""
from app.core.config import SYNC_STATE_PATH, load_json_file, save_json_atomic


def load_sync_state():
    return load_json_file(SYNC_STATE_PATH, {"last_pull_at": "", "last_push_at": "", "last_error": ""})


def save_sync_state(state):
    save_json_atomic(SYNC_STATE_PATH, state)
