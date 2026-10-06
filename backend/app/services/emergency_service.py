"""Arabic: ميزة الأدمن للإيقاف الطارئ — نسخة احتياطية كاملة، ثم مسح بيانات السيرفر، ثم قفل
        المزامنة نهائياً على هذا الجهاز، مع إمكانية إعادة الرفع لاحقاً.

لماذا هذا الملف موجود: طلب المشغّل أن يوقف مزامنة السيرفر ويوقف تشغيل الإضافة تماماً ويمسح
بيانات السيرفر (المنتجات والأعضاء والبراندات) بعد تنزيل نسخة احتياطية كاملة على جهازه، وأن
تبقى الميزة للأدمن فقط، وأن يقدر لاحقاً يعيد رفع البيانات إلى السيرفر ويفتح الإضافة من جديد.

ترتيب التنفيذ إلزامي ولا يُخالف (كل خطوة تسبق التي بعدها):
  1) النسخة الاحتياطية تُكتب على القرص فعلياً (أرشيف الجهاز + كل ما على السيرفر) قبل أي مسح —
     ولو فشلت الكتابة أو كان السيرفر غير قابل للوصول، تُلغى العملية كلها ولا يُمسح شيء.
  2) ثم يُطلب من sync.php تنفيذ ‎action=erase لمسح الجداول (منتجات، أعضاء، براندات، حجوزات).
     ولو رفض السيرفر الأمر، تُلغى العملية ولا يُقفل الجهاز حتى لا يضيع الوصول بلا مسح فعلي.
  3) ثم يُكتب قفل الإيقاف sync_lock.json، ويُفرَّغ رابط السيرفر والمفتاح السري من الإعدادات،
     فيتوقف كل نداء شبكة فوراً (sync_call يرفض الخروج) ويبقى الوضع قابلاً للاستعادة لاحقاً
     بأمر أدمن صريح من اللوحة.

English: The admin emergency-shutdown feature - a full backup, then erase the server data, then
lock sync permanently on this machine, with a re-upload path for later.

Why this file exists: the operator asked to stop the server sync, stop the extension entirely and
erase the server data (products, members, brands) after downloading a complete backup onto his
own machine, to keep the feature admin-only, and to be able to re-upload the data to the server
and open the extension again later.

The order is mandatory and never violated (every step precedes the next):
  1) The backup is really written to disk (this machine's archive + everything on the server)
     before any erase - if the write fails or the server is unreachable, the whole operation is
     cancelled and nothing is touched.
  2) Then sync.php is asked to run action=erase to clear the tables (products, members, brands,
     reservations). If the server refuses, the operation is cancelled and the machine is NOT
     locked, so access is never lost without a real erase.
  3) Then the shutdown lock sync_lock.json is written and the server URL and secret token are
     cleared from the settings, so every network call stops at once (sync_call refuses to leave)
     while the state stays restorable later by an explicit admin action from the popup.
"""
import hashlib
import json
import logging
import os
import re
import secrets
import threading
from datetime import datetime

from app.core.config import EMERGENCY_BACKUP_DIR
from app.core.runtime import paths_state
from app.repositories import sync_lock_repository
from app.services import sync_service

logger = logging.getLogger("alphacode")

# Arabic: العبارة التي يكتبها الأدمن بنفسه لتأكيد المسح - لا تُنفَّذ العملية بدونها حرفياً.
# English: The phrase the admin types to confirm the erase - nothing runs without it verbatim.
EMERGENCY_CONFIRM_PHRASE = "DELETE-SERVER"
# Arabic: عبارة تأكيد إعادة الرفع لاحقاً.
# English: Confirmation phrase for the later re-upload.
RESTORE_CONFIRM_PHRASE = "RESTORE"
# Arabic: القيمة التي يتحقق منها sync.php قبل تنفيذ الحذف (حماية من نداء عابر).
# English: The value sync.php checks before deleting anything (guards against a stray call).
ERASE_PAYLOAD_CONFIRM = "ERASE"

BACKUP_FORMAT = "alphacode-emergency-backup"
BACKUP_VERSION = 1

# Arabic: تأخير بسيط بين كل منتج وآخر أثناء إعادة الرفع، بنفس فلسفة المزامنة العادية
#         (تفادي إغراق الاستضافة والوصول لحد الحظر).
# English: A small delay between products during the re-upload, same philosophy as the normal
#          sync (never flood the host into a block).
RESTORE_PACING_SECONDS = 0.3

_BACKUP_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.json$")

_restore_thread = None
_restore_thread_lock = threading.Lock()


def _now():
    """Arabic: طابع زمني للقراءة فقط. English: A timestamp for readability only."""
    return datetime.now().isoformat(timespec="seconds")


def _friendly_error(error):
    """
    Arabic: تحويل أخطاء الشبكة الطويلة (رسائل requests الخام) إلى رسالة عربية قصيرة تُعرض في
            اللوحة - رسالة requests الكاملة تملأ الشاشة ولا تفيد الأدمن.
    English: Turn long network errors (raw requests messages) into a short Arabic message for the
             popup - the full requests text floods the screen and tells the admin nothing useful.
    """
    text = str(error or "")
    lowered = text.lower()
    if "failed to resolve" in lowered or "nameresolutionerror" in lowered or "name or service not known" in lowered:
        return "تعذر الوصول للرابط (النطاق غير موجود أو خدمة DNS غير متاحة)."
    if "timed out" in lowered or "timeout" in lowered:
        return "انتهت مهلة الاتصال بالسيرفر."
    if "max retries exceeded" in lowered or "connection" in lowered:
        return "تعذر الاتصال بالسيرفر (تأكد من الرابط ومن أن sync.php مرفوع عليه)."
    return text[:200]


def _configured_credentials():
    """
    Arabic: رابط السيرفر وكود المزامنة المحفوظان على هذا الجهاز (بلا اعتبار لحالة التفعيل).

            لماذا نتجاوز حقل Enabled هنا: هو خيار محلي في اللوحة، وليس قدرة على السيرفر. من
            عطّل المزامنة محلياً ثم أراد أخذ نسخة كاملة أو مسح بيانات السيرفر (طلب المشغّل
            الحقيقي: «ما عاد معي وصول للاستضافة») لا يجوز أن يُمنع بسبب مفتاح في اللوحة.
    English: The server URL and sync token stored on this machine (regardless of the enabled flag).

             Why the Enabled flag is bypassed here: it is a local UI preference, not a server
             capability. Someone who disabled sync locally and then wants a full backup or to
             erase the server data (the operator's actual request: "I lost hosting access") must
             not be blocked by a switch in the popup.
    """
    config = sync_service.load_sync_config()
    return str(config.get("ServerUrl") or ""), str(config.get("Token") or "")


def _stamp():
    """Arabic: طابع زمني صالح لاسم ملف. English: A filename-safe timestamp."""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


# ---------------------------------------------------------------------------
# Arabic: مجلد النسخ الاحتياطية والوصول الآمن لأسماء الملفات.
# English: The backup folder and safe access to file names.
# ---------------------------------------------------------------------------

def emergency_backup_dir():
    """
    Arabic: مجلد النسخ الاحتياطية: داخل مجلد الحفظ المُعدّ من المستخدم (فينتقل مع بياناته)،
            وإلا المجلد الافتراضي backend/backups.
    English: The backup folder: inside the operator's configured save folder (so it travels with
             their data), otherwise the default backend/backups.
    """
    root = getattr(paths_state, "ROOT_DIR", "") or ""
    if root and os.path.isdir(root):
        return os.path.join(root, "backups")
    return EMERGENCY_BACKUP_DIR


def ensure_backup_dir():
    """Arabic: إنشاء مجلد النسخ الاحتياطية عند الحاجة. English: Create the backup folder when needed."""
    directory = emergency_backup_dir()
    os.makedirs(directory, exist_ok=True)
    return directory


def resolve_backup_path(name):
    """
    Arabic: تحويل اسم ملف إلى مسار كامل داخل مجلد النسخ الاحتياطية فقط - يرفض أي محاولة
            خروج من المجلد (‎../ أو مسار مطلق) لأن الاسم يأتي من الواجهة.
    English: Turn a file name into a full path inside the backup folder only - refuses any
             attempt to escape it (../ or an absolute path), because the name comes from the UI.
    """
    name = str(name or "").strip()
    if not name or os.path.basename(name) != name or not _BACKUP_NAME_RE.match(name):
        return None
    return os.path.join(emergency_backup_dir(), name)


def _read_backup_file(path):
    """Arabic: قراءة ملف نسخة احتياطية والتحقق من صيغته. English: Read a backup file and verify its format."""
    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict) or payload.get("format") != BACKUP_FORMAT:
        raise ValueError("الملف ليس نسخة احتياطية من AlphaCode.")
    return payload


# Arabic: كاش ملخصات النسخ الاحتياطية - ملف النسخة قد يكون عدة ميجابايت، ولوحة الإضافة تطلب
#         القائمة عند كل فتح للتبويب، فإعادة قراءة كل الملفات في كل مرة تُبطئ الرد بلا داعٍ.
#         المفتاح هو المسار الكامل + وقت التعديل بالنانوثانية + الحجم، فأي تغيير حقيقي للملف
#         يُبطل الكاش فوراً (ولا يلزم أي ملف فهرس إضافي يمكن أن يخرج عن التزامن مع الواقع).
# English: A cache of backup summaries - a backup file can be several megabytes and the popup asks
#          for the list on every tab open, so re-parsing every file each time slows the response
#          for nothing. The key is the full path + mtime in nanoseconds + size, so any real change
#          to the file invalidates it at once (no extra index file that could drift out of sync).
_SUMMARY_CACHE = {}


def describe_backup(name):
    """Arabic: ملخص صغير لملف نسخة احتياطية (يُقرأ من الكاش إن لم يتغيّر الملف). English: A small summary of a backup file (served from the cache when the file has not changed)."""
    path = resolve_backup_path(name)
    if not path or not os.path.exists(path):
        return None
    stat = os.stat(path)
    cached = _SUMMARY_CACHE.get(path)
    if cached and cached.get("_mtime_ns") == stat.st_mtime_ns and cached.get("_size") == stat.st_size:
        return {key: value for key, value in cached.items() if not key.startswith("_")}

    summary = {
        "name": os.path.basename(path),
        "path": path,
        "size_bytes": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "local_products": 0,
        "server_products": 0,
        "server_brands": 0,
        "server_reachable": None,
    }
    try:
        payload = _read_backup_file(path)
        local = payload.get("local") or {}
        server = payload.get("server") or {}
        summary["local_products"] = int(local.get("product_count") or 0)
        summary["server_products"] = int(server.get("product_count") or 0)
        summary["server_brands"] = int(server.get("brand_count") or 0)
        summary["server_reachable"] = bool(server.get("reachable"))
        summary["generated_at"] = payload.get("generated_at") or summary["created_at"]
        summary["server_url"] = server.get("url") or ""
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        summary["error"] = f"تعذر قراءة الملف: {exc}"
    summary["_mtime_ns"] = stat.st_mtime_ns
    summary["_size"] = stat.st_size
    _SUMMARY_CACHE[path] = summary
    return {key: value for key, value in summary.items() if not key.startswith("_")}


def list_emergency_backups():
    """Arabic: كل النسخ الاحتياطية الموجودة، الأحدث أولاً. English: Every backup on disk, newest first."""
    directory = emergency_backup_dir()
    if not os.path.isdir(directory):
        return []
    backups = []
    for entry in os.listdir(directory):
        if entry.endswith(".json") and _BACKUP_NAME_RE.match(entry):
            summary = describe_backup(entry)
            if summary:
                backups.append(summary)
    backups.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return backups


# ---------------------------------------------------------------------------
# Arabic: جمع النسخة الاحتياطية (الجهاز + السيرفر).
# English: Gathering the backup (this machine + the server).
# ---------------------------------------------------------------------------

def collect_local_snapshot():
    """
    Arabic: لقطة من أرشيف هذا الجهاز كما هو على القرص - بلا أي تعديل عليه.
    English: A snapshot of this machine's archive exactly as stored on disk - never modified.
    """
    archive_path = getattr(paths_state, "ARCHIVE_PATH", "") or ""
    archive = {}
    error = ""
    if archive_path and os.path.exists(archive_path):
        try:
            with open(archive_path, "r", encoding="utf-8") as file:
                loaded = json.load(file)
            if isinstance(loaded, dict):
                archive = loaded
        except (OSError, json.JSONDecodeError) as exc:
            error = f"تعذر قراءة أرشيف الجهاز: {exc}"
            logger.warning("Emergency backup could not read the local archive: %s", exc)
    products = [key for key in archive.keys() if not str(key).startswith("_")]
    return {
        "root_dir": getattr(paths_state, "ROOT_DIR", "") or "",
        "archive_path": archive_path,
        "product_count": len(products),
        "archive": archive,
        "error": error,
    }


def collect_server_snapshot():
    """
    Arabic: كل ما يستطيع العميل قراءته من السيرفر المركزي: كل المنتجات (بلا شرط زمني) وقائمة
            البراندات. الأعضاء وكلمات المرور لا يوجد لها action قراءة في sync.php، فالنسخة
            الاحتياطية لا تحتويها ويسجَّل ذلك صراحة في الملف (members_backed_up=false) حتى لا
            يظن الأدمن أنهم محفوظون.
    English: Everything the client can read from the central server: all products (no time
             filter) and the brand list. Members and passwords have no read action in sync.php,
             so the backup cannot contain them and says so explicitly (members_backed_up=false)
             rather than letting the admin assume they were saved.
    """
    snapshot = {
        "url": "",
        "reachable": False,
        "error": "",
        "product_count": 0,
        "brand_count": 0,
        "items": {},
        "brands": [],
        "members_backed_up": False,
        "members_note": (
            "حسابات الأعضاء وكلمات المرور لا يمكن قراءتها من sync.php (لا يوجد action للقراءة)، "
            "فلا تشملها النسخة الاحتياطية. بعد إعادة الرفع أعد إنشاءهم من قاعدة بيانات الاستضافة."
        ),
    }
    server_url, token = _configured_credentials()
    snapshot["url"] = server_url
    if sync_lock_repository.is_sync_locked():
        snapshot["error"] = "المزامنة موقوفة نهائياً على هذا الجهاز — لم تُقرأ بيانات السيرفر."
        return snapshot
    if not server_url or not token:
        snapshot["error"] = "لا يوجد رابط سيرفر وكود مزامنة محفوظان على هذا الجهاز — لم تُقرأ بيانات السيرفر."
        return snapshot

    data, error = sync_service.sync_http_call(server_url, token, "pull", {"since": ""}, method="POST")
    if error:
        snapshot["error"] = f"تعذر سحب المنتجات من السيرفر: {_friendly_error(error)}"
        return snapshot
    items = (data or {}).get("items") or {}
    if not isinstance(items, dict):
        items = {}
    snapshot["items"] = items
    snapshot["product_count"] = len(items)

    brands_data, brands_error = sync_service.sync_http_call(server_url, token, "brands", {}, method="GET")
    if brands_error:
        # Arabic: فشل قراءة البراندات لا يُسقط النسخة كلها — المنتجات هي الأهم، والخطأ مسجَّل.
        # English: A brand-read failure must not sink the whole backup - the products matter
        #          most, and the failure is recorded.
        snapshot["error"] = f"تعذر قراءة البراندات من السيرفر: {_friendly_error(brands_error)}"
    else:
        brands = (brands_data or {}).get("brands") or []
        snapshot["brands"] = brands if isinstance(brands, list) else []
        snapshot["brand_count"] = len(snapshot["brands"])

    snapshot["reachable"] = True
    return snapshot


def create_emergency_backup(note="", actor=""):
    """
    Arabic: إنشاء ملف النسخة الاحتياطية الكاملة على القرص وإرجاع ملخصه.
            الملف يحتوي: أرشيف هذا الجهاز كاملاً + كل منتجات السيرفر + قائمة البراندات + تعليمات
            الاستعادة. ولا يحتوي مفتاح المزامنة السري أبداً (الملف يُرسل/يُحفظ ويتنقل بين الأجهزة).
    English: Write the full backup file to disk and return its summary.
             It holds this machine's whole archive + every server product + the brand list +
             restore instructions. It never contains the sync secret token (the file gets
             downloaded/copied and travels between machines).
    """
    directory = ensure_backup_dir()
    server = collect_server_snapshot()
    local = collect_local_snapshot()
    name = f"alphacode_emergency_backup_{_stamp()}.json"
    path = os.path.join(directory, name)
    if os.path.exists(path):
        # Arabic: ضغطتان خلال نفس الثانية لا يجوز أن تمسح إحداهما الأخرى (الطابع الزمني بالثواني).
        # English: Two presses within the same second must not overwrite each other (the stamp is
        #          only second-accurate).
        name = f"alphacode_emergency_backup_{_stamp()}_{secrets.token_hex(2)}.json"
        path = os.path.join(directory, name)
    payload = {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "generated_at": _now(),
        "generated_by": str(actor or ""),
        "note": str(note or ""),
        "sync_token_included": False,
        "local": local,
        "server": server,
        "restore_instructions": {
            "ar": (
                "لإعادة الرفع: افتح تبويب «المزامنة والمجلد» في لوحة الإضافة ← منطقة خطر ← "
                "اختر هذا الملف ← أدخل رابط سيرفر المزامنة الجديد وكود المزامنة ← اكتب RESTORE واضغط استعادة. "
                "يجب أن يكون sync.php الجديد على الاستضافة (نفس العقد البرمجي) ويكون ALPHACODE_SYNC_TOKEN "
                "مضبوطاً عليه، ثم راجع معرّفات المنتجات وتقدّم id_sequence."
            ),
            "en": (
                "To re-upload: open the Sync & Folder tab in the popup -> danger zone -> pick this "
                "file -> enter the new sync server URL and token -> type RESTORE and press restore. "
                "The new host must serve sync.php (same wire contract) with ALPHACODE_SYNC_TOKEN set; "
                "then verify product IDs and the id_sequence counter."
            ),
        },
    }
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temp_path, path)
    logger.info(
        "Emergency backup written: %s (local=%s server=%s reachable=%s)",
        path, local["product_count"], server["product_count"], server["reachable"],
    )
    summary = describe_backup(name) or {"name": name, "path": path}
    summary["server_error"] = server.get("error") or ""
    summary["server_reachable"] = bool(server.get("reachable"))
    summary["members_backed_up"] = bool(server.get("members_backed_up"))
    summary["members_note"] = server.get("members_note", "")
    return summary


# ---------------------------------------------------------------------------
# Arabic: قفل المزامنة + حماية الدخول المحلي.
# English: Locking sync + protecting the local login.
# ---------------------------------------------------------------------------

def _hash_guard(password, salt):
    """Arabic: بصمة كلمة حماية الدخول المحلي (لا تُخزَّن الكلمة نفسها أبداً). English: The local-guard password hash (the password itself is never stored)."""
    return hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()


def set_local_guard(password):
    """
    Arabic: حفظ رمز حماية محلي اختياري مع القفل: لو حُفظ، فالدخول المحلي بعد الإيقاف لا يقبل
            admin/admin إلا مع هذا الرمز - وهو ما يمنع أي عضو من تشغيل نسخته الخاصة بعد المسح.
    English: Store an optional local guard password with the lock: once set, the local login after
             the shutdown rejects admin/admin without it - this is what stops a member from
             running their own copy after the erase.
    """
    password = str(password or "")
    if not password:
        return {"LocalGuardHash": "", "LocalGuardSalt": ""}
    salt = secrets.token_hex(8)
    return {"LocalGuardHash": _hash_guard(password, salt), "LocalGuardSalt": salt}


def verify_local_guard(password):
    """
    Arabic: هل كلمة المرور المدخلة تفتح الوضع المحلي المقفول؟ ترجع (صحيح، رسالة الخطأ).
    English: Does the entered password open the locked-down local mode? Returns (ok, error message).
    """
    lock = sync_lock_repository.load_sync_lock()
    stored_hash = str(lock.get("LocalGuardHash") or "")
    if not stored_hash:
        # Arabic: لا رمز محفوظ (اختياري) - السلوك القائم admin/admin يبقى كما هو.
        # English: No guard stored (optional) - the existing admin/admin behaviour stands.
        return True, ""
    salt = str(lock.get("LocalGuardSalt") or "")
    if _hash_guard(str(password or ""), salt) == stored_hash:
        return True, ""
    return False, "الوضع المحلي مقفول برمز حماية. أدخل رمز الحماية المحلي بدل كلمة المرور."


def lock_local_sync(server_erased_at="", backup_file="", server_url="", note="", guard=None):
    """Arabic: قفل المزامنة ومسح رابط السيرفر والمفتاح السري من الإعدادات. English: Lock sync and clear the server URL and secret token from the settings."""
    config = sync_service.load_sync_config()
    config["Enabled"] = False
    config["ServerUrl"] = ""
    config["Token"] = ""
    # Arabic: طابور الرفع المعلّق يُفرَّغ: لا معنى لإرساله بعد القفل، ولو بقي لأعاد المحاولة كل 5 دقائق.
    # English: The pending push queue is emptied: pushing is meaningless after the lock, and
    #          leaving it would make the retry flush keep trying every 5 minutes.
    sync_service.save_sync_config(config)
    sync_service.save_sync_queue([])
    state = sync_service.load_sync_state()
    state["last_error"] = ""
    state["last_pull_at"] = ""
    state["last_push_at"] = ""
    state["throttled_until"] = ""
    sync_service.save_sync_state(state)

    lock = sync_lock_repository.load_sync_lock()
    lock.update({
        "Locked": True,
        "LockedAt": _now(),
        "ServerErasedAt": server_erased_at or _now(),
        "BackupFile": backup_file,
        "ServerUrl": server_url,
        "Note": note,
    })
    lock.update(guard or {})
    return sync_lock_repository.save_sync_lock(lock)


def unlock_local_sync():
    """Arabic: فتح القفل (يُستدعى من مسار أدمن صريح بعد نجاح الاتصال بالسيرفر الجديد). English: Release the lock (called from an explicit admin path after the new server answers)."""
    return sync_lock_repository.clear_sync_lock()


# ---------------------------------------------------------------------------
# Arabic: التنفيذ الفعلي — نسخة، ثم مسح السيرفر، ثم قفل الجهاز.
# English: The actual run - backup, then erase the server, then lock this machine.
# ---------------------------------------------------------------------------

def run_emergency_shutdown(confirm, erase_server=True, actor="", local_guard_password="", note=""):
    """
    Arabic: تنفيذ طلب الأدمن كاملاً بترتيبه الإلزامي. لا يُمسح أي شيء قبل أن تُكتب النسخة
            الاحتياطية بنجاح، ولا يُقفل الجهاز إن رفض السيرفر أمر المسح.
    English: Run the admin request in its mandatory order. Nothing is erased before the backup is
             written successfully, and this machine is never locked when the server refuses the
             erase.
    """
    steps = []
    if str(confirm or "").strip() != EMERGENCY_CONFIRM_PHRASE:
        return {
            "success": False,
            "error": f"اكتب العبارة {EMERGENCY_CONFIRM_PHRASE} حرفياً للتأكيد.",
            "steps": steps,
        }

    # 1) النسخة الاحتياطية أولاً - إلزامية ولا تُتخطى.
    try:
        backup = create_emergency_backup(note=note or "قبل مسح بيانات السيرفر", actor=actor)
    except Exception as exc:
        logger.exception("Emergency backup failed, nothing was erased: %s", exc)
        return {
            "success": False,
            "error": f"تعذر إنشاء النسخة الاحتياطية، ولم يُمسح شيء: {exc}",
            "steps": steps,
        }
    steps.append({
        "step": "backup",
        "success": True,
        "backup_file": backup.get("name"),
        "local_products": backup.get("local_products"),
        "server_products": backup.get("server_products"),
        "server_brands": backup.get("server_brands"),
        "server_reachable": backup.get("server_reachable"),
    })

    # 2) مسح بيانات السيرفر - يشترط أن يكون السيرفر قابلاً للوصول فعلاً (نسخة حقيقية موجودة الآن).
    erase_result = None
    if erase_server:
        if not backup.get("server_reachable"):
            return {
                "success": False,
                "error": (
                    "السيرفر غير قابل للوصول فلم تُقرأ بياناته، والمسح أُلغي حتى لا تضيع البيانات بلا نسخة. "
                    f"سبب عدم الوصول: {backup.get('server_error') or 'غير معروف'}"
                ),
                "backup": backup,
                "steps": steps,
            }
        server_url, token = _configured_credentials()
        data, error = sync_service.sync_http_call(
            server_url, token, "erase", {"confirm": ERASE_PAYLOAD_CONFIRM}, method="POST"
        )
        if error or not (data or {}).get("success"):
            reason = _friendly_error(error or (data or {}).get("error") or "رفض السيرفر أمر المسح")
            logger.error("Server erase refused: %s", reason)
            return {
                "success": False,
                "error": (
                    "رفض سيرفر المزامنة أمر المسح، فأُلغي كل شيء ولم يُقفل الجهاز: " + str(reason) +
                    " — تأكد أن sync.php المرفوع على الاستضافة يحتوي action=erase (النسخة الجديدة في "
                    "hostinger/alphacode_storage/sync.php)، أو أزل تحديد «مسح بيانات السيرفر» إن أردت "
                    "إيقاف المزامنة على هذا الجهاز فقط."
                ),
                "backup": backup,
                "steps": steps,
            }
        erase_result = data
        steps.append({
            "step": "server_erase",
            "success": True,
            "deleted": data.get("deleted") or {},
            "total_deleted": data.get("total_deleted"),
            "shutdown_lock": data.get("shutdown_lock"),
        })

    # 3) قفل هذا الجهاز ومسح بيانات الاعتماد المحفوظة.
    guard = set_local_guard(local_guard_password)
    lock = lock_local_sync(
        server_erased_at=(erase_result or {}).get("erased_at") or _now(),
        backup_file=backup.get("name") or "",
        server_url=backup.get("server_url") or "",
        note=note or "",
        guard=guard,
    )
    steps.append({
        "step": "local_lock",
        "success": True,
        "locked": True,
        "guard_set": bool(guard.get("LocalGuardHash")),
    })
    logger.warning(
        "EMERGENCY SHUTDOWN executed. erased=%s backup=%s locked=%s guard=%s",
        bool(erase_result), backup.get("name"), True, bool(guard.get("LocalGuardHash")),
    )
    return {
        "success": True,
        "backup": backup,
        "server_erase": erase_result,
        "lock": lock,
        "steps": steps,
    }


# ---------------------------------------------------------------------------
# Arabic: إعادة الرفع إلى السيرفر (استعادة) - تجري بخيط خلفي لأنها آلاف الطلبات.
# English: The re-upload (restore) - runs on a background thread because it is thousands of calls.
# ---------------------------------------------------------------------------

def _restore_progress(**updates):
    """Arabic: تحديث حالة إعادة الرفع وتثبيتها على القرص. English: Update and persist the re-upload state."""
    state = sync_lock_repository.load_restore_state()
    state.update(updates)
    sync_lock_repository.save_restore_state(state)
    return state


def _restore_worker(backup_path, server_url, token):
    """Arabic: الخيط الفعلي: يعيد رفع البراندات ثم المنتجات ثم يضبط عدّاد المعرّفات. English: The real thread: re-upload brands, then products, then fix the ID counter."""
    state = None
    try:
        payload = _read_backup_file(backup_path)
        server = payload.get("server") or {}
        items = server.get("items") or {}
        brands = server.get("brands") or []
        if not isinstance(items, dict):
            items = {}
        if not isinstance(brands, list):
            brands = []

        # Arabic: البراندات أولاً - كل منتج يُرفض لو برانده غير موجود في خريطة السيرفر.
        # English: Brands first - every product is rejected when its brand is missing server-side.
        if brands:
            data, error = sync_service.sync_http_call(
                server_url, token, "brands/sync", {"confirm_replace": True, "brands": brands}, method="POST"
            )
            if error or not (data or {}).get("success"):
                state = _restore_progress(last_error=f"تعذر رفع البراندات: {error or (data or {}).get('error')}")
            else:
                state = _restore_progress(brands_restored=int(data.get("brand_count") or len(brands)))

        pushable = []
        skipped = 0
        for key, item in items.items():
            if not isinstance(item, dict) or not item.get("id"):
                # Arabic: حجز بلا منتج مكتمل (reserved) - لا معنى لرفعه.
                # English: A reservation without a finished product (reserved) - nothing to upload.
                skipped += 1
                continue
            pushable.append((key, item))

        state = _restore_progress(total=len(pushable), skipped=skipped)
        pushed = 0
        duplicates = 0
        failed = 0
        errors = []
        max_id = 0
        for key, item in pushable:
            data, error = sync_service.sync_http_call(
                server_url, token, "push", {"key": key, "product": item}, method="POST"
            )
            try:
                max_id = max(max_id, int(item.get("id") or 0))
            except (TypeError, ValueError):
                pass
            if error:
                failed += 1
                if len(errors) < 20:
                    errors.append({"key": str(key), "error": str(error)})
            elif (data or {}).get("duplicate"):
                duplicates += 1
            else:
                pushed += 1
            state = _restore_progress(pushed=pushed, duplicates=duplicates, failed=failed, errors=errors)
            if RESTORE_PACING_SECONDS:
                import time as _time
                _time.sleep(RESTORE_PACING_SECONDS)

        # Arabic: عدّاد المعرّفات على السيرفر يبدأ من جديد بعد المسح، فنرفعه فوق أعلى معرّف
        #         مُستعاد حتى لا تصطدم المنتجات الجديدة بمعرّفات قديمة.
        # English: The server's ID counter restarts after the wipe, so it is raised above the
        #          highest restored ID - otherwise new products would collide with old ones.
        sequence_bumped_to = 0
        sequence_error = ""
        if max_id:
            data, error = sync_service.sync_http_call(
                server_url, token, "bump_sequence", {"value": max_id}, method="POST"
            )
            if error or not (data or {}).get("success"):
                sequence_error = f"تعذر ضبط عدّاد المعرّفات: {error or (data or {}).get('error')}"
            else:
                sequence_bumped_to = max_id

        last_error = sequence_error
        if failed:
            last_error = (last_error + " | " if last_error else "") + f"فشل رفع {failed} منتج."
        state = _restore_progress(
            running=False,
            finished_at=_now(),
            last_error=last_error,
            sequence_bumped_to=sequence_bumped_to,
        )
        # Arabic: نتيجة إعادة الرفع تظهر في بطاقة المزامنة العادية أيضاً حتى يراها الأدمن مباشرة.
        # English: The outcome also lands in the normal sync card so the admin sees it at once.
        if last_error:
            sync_state = sync_service.load_sync_state()
            sync_state["last_error"] = f"إعادة الرفع: {last_error}"
            sync_service.save_sync_state(sync_state)
        logger.info(
            "Restore finished: pushed=%s duplicates=%s failed=%s skipped=%s brands=%s",
            pushed, duplicates, failed, skipped, (state or {}).get("brands_restored"),
        )
    except Exception as exc:
        logger.exception("Restore job failed: %s", exc)
        _restore_progress(running=False, finished_at=_now(), last_error=f"فشلت إعادة الرفع: {exc}")


def start_restore_job(backup_file, server_url, token, confirm, guard_password=""):
    """
    Arabic: بدء إعادة الرفع: تحقق من العبارة والملف والاتصال بالسيرفر الجديد أولاً، ثم احفظ
            بيانات الاعتماد، وافتح القفل، وشغّل الخيط الخلفي. ولا يبدأ أي شيء لو لم يجب السيرفر.
    English: Start the re-upload: verify the phrase, the file and the connection to the new server
             first, then save the credentials, release the lock and run the background thread.
             Nothing starts unless the server actually answers.
    """
    global _restore_thread
    confirm = str(confirm or "").strip()
    if confirm != RESTORE_CONFIRM_PHRASE:
        return {"success": False, "error": f"اكتب العبارة {RESTORE_CONFIRM_PHRASE} حرفياً للتأكيد."}

    path = resolve_backup_path(backup_file)
    if not path or not os.path.exists(path):
        return {"success": False, "error": "اختر ملف نسخة احتياطية موجوداً."}

    server_url = str(server_url or "").strip().rstrip("/")
    token = str(token or "").strip()
    if not server_url or not token:
        return {"success": False, "error": "أدخل رابط سيرفر المزامنة وكود المزامنة الجديدين."}

    lock = sync_lock_repository.load_sync_lock()
    if lock.get("Locked"):
        ok, guard_error = verify_local_guard(guard_password)
        if not ok:
            return {"success": False, "error": guard_error}

    with _restore_thread_lock:
        if (_restore_thread is not None and _restore_thread.is_alive()) or sync_lock_repository.load_restore_state().get("running"):
            return {"success": False, "error": "عملية إعادة رفع قائمة بالفعل — انتظر انتهاءها."}

    # Arabic: فحص فعلي قبل الحفظ: لو الرابط/الكود خطأ لا نمسّ الإعدادات ولا نفتح القفل.
    # English: A real check before saving: a wrong URL/token must not touch the settings or open
    #          the lock.
    data, error = sync_service.sync_http_call(server_url, token, "brands", {}, method="GET")
    if error or not (data or {}).get("success"):
        return {
            "success": False,
            "error": "لم يستجب سيرفر المزامنة الجديد: "
                     + _friendly_error(error or (data or {}).get("error") or "غير معروف"),
        }

    config = sync_service.load_sync_config()
    config["Enabled"] = True
    config["ServerUrl"] = server_url
    config["Token"] = token
    sync_service.save_sync_config(config)
    unlock_local_sync()

    _restore_progress(
        running=True, started_at=_now(), finished_at="", backup_file=os.path.basename(path),
        server_url=server_url, total=0, pushed=0, duplicates=0, skipped=0, failed=0,
        brands_restored=0, sequence_bumped_to=0, last_error="", errors=[],
    )
    _restore_thread = threading.Thread(
        target=_restore_worker,
        args=(path, server_url, token),
        name="alphacode-restore-worker",
        daemon=True,
    )
    _restore_thread.start()
    logger.warning("Restore started from %s to %s", os.path.basename(path), server_url)
    return {"success": True, "restore": sync_lock_repository.load_restore_state()}


def restore_status():
    """Arabic: حالة إعادة الرفع للوحة الإضافة. English: The re-upload state for the popup."""
    state = sync_lock_repository.load_restore_state()
    state["lock"] = sync_lock_repository.load_sync_lock()
    return state


def unlock_with_credentials(server_url, token, guard_password=""):
    """
    Arabic: فتح القفل ببيانات اعتماد جديدة بلا إعادة رفع كامل (لو كان الأدمن رفع البيانات بنفسه)،
            مع فحص اتصال فعلي قبل الفتح.
    English: Release the lock with fresh credentials and no full re-upload (when the admin
             restored the data by hand), after a real connectivity check.
    """
    ok, guard_error = verify_local_guard(guard_password)
    if not ok:
        return {"success": False, "error": guard_error}
    server_url = str(server_url or "").strip().rstrip("/")
    token = str(token or "").strip()
    if not server_url or not token:
        return {"success": False, "error": "أدخل رابط سيرفر المزامنة وكود المزامنة قبل فتح القفل."}
    data, error = sync_service.sync_http_call(server_url, token, "brands", {}, method="GET")
    if error or not (data or {}).get("success"):
        return {
            "success": False,
            "error": "لم يستجب سيرفر المزامنة: "
                     + _friendly_error(error or (data or {}).get("error") or "غير معروف"),
        }
    unlock_local_sync()
    logger.warning("Sync lock released by an explicit admin action (server=%s)", server_url)
    return {"success": True}


def emergency_status():
    """Arabic: ملخص حالة الإيقاف الطارئ للوحة. English: The emergency-shutdown status summary for the popup."""
    lock = sync_lock_repository.load_sync_lock()
    return {
        "locked": bool(lock.get("Locked")),
        "lock": lock,
        "guard_set": bool(lock.get("LocalGuardHash")),
        "backup_dir": emergency_backup_dir(),
        "backups": list_emergency_backups(),
        "restore": sync_lock_repository.load_restore_state(),
        "confirm_phrase": EMERGENCY_CONFIRM_PHRASE,
        "restore_phrase": RESTORE_CONFIRM_PHRASE,
    }
