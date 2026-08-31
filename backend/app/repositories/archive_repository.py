"""Arabic: قراءة/كتابة أرشيف المنتجات archive_db.json. English: Read/write the product archive archive_db.json."""
from app.core.config import load_json_file, save_json_atomic


def load_archive(archive_path):
    """Arabic: تحميل أرشيف المنتجات من المسار الحالي (المسار متغيّر حسب مجلد الحفظ المُعدّ من المستخدم). English: Load the product archive from its current path (the path varies with the user's configured save folder)."""
    return load_json_file(archive_path, {})


def save_archive(archive_path, archive):
    """Arabic: حفظ أرشيف المنتجات كاملاً بالمسار الحالي. English: Persist the full product archive at its current path."""
    save_json_atomic(archive_path, archive)
