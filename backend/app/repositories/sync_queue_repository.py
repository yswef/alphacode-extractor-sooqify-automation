"""Arabic: قراءة/كتابة sync_queue.json. English: Read/write sync_queue.json."""
from app.core.config import SYNC_QUEUE_PATH, load_json_file, save_json_atomic


def load_sync_queue():
    return load_json_file(SYNC_QUEUE_PATH, [])


def save_sync_queue(queue):
    save_json_atomic(SYNC_QUEUE_PATH, queue)
