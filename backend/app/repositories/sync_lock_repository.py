"""Arabic: قراءة/كتابة قفل الإيقاف الطارئ sync_lock.json، ومعه حالة عملية إعادة الرفع.

سبب وجود هذا الملف: ميزة «نسخة احتياطية كاملة ← مسح بيانات السيرفر ← إيقاف المزامنة نهائياً».
بعد تنفيذها يجب ألا يخرج أي طلب شبكة لسيرفر المزامنة إطلاقاً - حتى لو بقيت قيمة Token قديمة
على جهاز أحد الأعضاء - وألا يعود التفعيل إلا بأمر أدمن صريح من اللوحة. القفل ملف مستقل
(لا يُخلط مع sync_config.json) حتى لا تمسحه أي كتابة إعدادات عادية بالخطأ.

English: Read/write the emergency-shutdown lock sync_lock.json, plus the state of the
re-upload job.

Why this file exists: the feature is "full backup -> erase the server data -> stop sync for
good". After it runs, no network request may leave for the sync server at all - even if an old
Token is still sitting on a member's machine - and re-enabling must require an explicit admin
action from the popup. The lock is its own file (never mixed into sync_config.json) so an
ordinary settings write can never wipe it by accident.
"""
from datetime import datetime

from app.core.config import SYNC_LOCK_PATH, RESTORE_STATE_PATH, load_json_file, save_json_atomic


def _empty_lock():
    return {
        "Locked": False,
        "LockedAt": "",
        "ServerErasedAt": "",
        "BackupFile": "",
        "ServerUrl": "",
        "Note": "",
        # Arabic: رمز الحماية المحلي (بصمة + ملح فقط، ولا تُخزَّن الكلمة نفسها أبداً) - يمنع
        #         الدخول المحلي admin/admin بعد الإيقاف إلا لمن يعرف الرمز.
        # English: The local guard (hash + salt only, the password itself is never stored) - it
        #          keeps the local admin/admin login closed after the shutdown to everyone else.
        "LocalGuardHash": "",
        "LocalGuardSalt": "",
    }


def load_sync_lock():
    """Arabic: قراءة القفل مع القيم الافتراضية لو الملف ناقص أو تالف. English: Read the lock with defaults when the file is missing or corrupt."""
    stored = load_json_file(SYNC_LOCK_PATH, {})
    lock = _empty_lock()
    if isinstance(stored, dict):
        lock.update({key: stored.get(key, lock[key]) for key in lock})
    lock["Locked"] = bool(lock["Locked"])
    return lock


def is_sync_locked():
    """Arabic: هل المزامنة موقوفة نهائياً؟ هذا الفحص يسبق أي نداء شبكة. English: Is sync permanently stopped? This check precedes every network call."""
    return bool(load_sync_lock().get("Locked"))


def save_sync_lock(lock):
    """Arabic: حفظ القفل بعد تنظيف الحقول. English: Persist the lock after sanitizing its fields."""
    cleaned = _empty_lock()
    cleaned.update(lock or {})
    cleaned["Locked"] = bool(cleaned["Locked"])
    for key in ("LockedAt", "ServerErasedAt", "BackupFile", "ServerUrl", "Note", "LocalGuardHash", "LocalGuardSalt"):
        cleaned[key] = str(cleaned.get(key) or "")
    save_json_atomic(SYNC_LOCK_PATH, cleaned)
    return cleaned


def lock_sync(server_erased_at="", backup_file="", server_url="", note=""):
    """Arabic: تثبيت القفل - يُستدعى فقط بعد نجاح المسح (أو بطلب أدمن صريح). English: Set the lock - called only after a successful erase (or by an explicit admin action)."""
    return save_sync_lock({
        "Locked": True,
        "LockedAt": datetime.now().isoformat(timespec="seconds"),
        "ServerErasedAt": server_erased_at or datetime.now().isoformat(timespec="seconds"),
        "BackupFile": backup_file,
        "ServerUrl": server_url,
        "Note": note,
    })


def clear_sync_lock():
    """Arabic: فتح القفل - لا يُستدعى إلا من مسار أدمن صريح (استعادة/ConfirmUnlock). English: Release the lock - only called from an explicit admin path (restore / ConfirmUnlock)."""
    return save_sync_lock(_empty_lock())


# ---------------------------------------------------------------------------
# Arabic: حالة عملية إعادة الرفع إلى السيرفر (خيط خلفي).
# English: Re-upload job state (background thread).
# ---------------------------------------------------------------------------

def load_restore_state():
    """Arabic: حالة إعادة الرفع الحالية. English: Current re-upload state."""
    default = {
        "running": False,
        "started_at": "",
        "finished_at": "",
        "backup_file": "",
        "server_url": "",
        "total": 0,
        "pushed": 0,
        "duplicates": 0,
        "skipped": 0,
        "failed": 0,
        "brands_restored": 0,
        "sequence_bumped_to": 0,
        "last_error": "",
        "errors": [],
    }
    stored = load_json_file(RESTORE_STATE_PATH, {})
    if isinstance(stored, dict):
        default.update({key: stored.get(key, default[key]) for key in default})
    return default


def save_restore_state(state):
    """Arabic: حفظ حالة إعادة الرفع. English: Persist the re-upload state."""
    save_json_atomic(RESTORE_STATE_PATH, state)
    return state
