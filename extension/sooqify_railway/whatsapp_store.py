"""Persistent outbox/archive-command ledger and ephemeral linked-device status."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from zoneinfo import ZoneInfo


DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent / "data"))).resolve()
WHATSAPP_DIR = DATA_DIR / "whatsapp"
BACKUPS_DIR = DATA_DIR / "backups" / "whatsapp_deletions"
OUTBOX_PATH = WHATSAPP_DIR / "outbox.json"
ARCHIVE_JOBS_PATH = WHATSAPP_DIR / "archive_jobs.json"
DELETE_REQUESTS_PATH = WHATSAPP_DIR / "delete_requests.json"
TOMBSTONES_PATH = WHATSAPP_DIR / "archive_tombstones.json"
AUDIT_LOG_PATH = WHATSAPP_DIR / "archive_delete_audit.jsonl"
APP_TZ = ZoneInfo(os.getenv("APP_TIMEZONE", "Asia/Aden"))
_STATE_LOCK = threading.RLock()
_RUNTIME = {
    "state": "not_configured",
    "connected": False,
    "phone_number": "",
    "updated_at": "",
    "qr": "",
    "qr_expires_at": "",
    "last_error": "",
}


def now_utc():
    return datetime.now(timezone.utc)


def _iso(value=None):
    return (value or now_utc()).astimezone(timezone.utc).isoformat(timespec="seconds")


def _parse_time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _read_json(path, fallback):
    try:
        with Path(path).open("r", encoding="utf-8") as source:
            value = json.load(source)
        return value
    except (OSError, json.JSONDecodeError):
        return fallback


def _write_json_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _append_audit(event):
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG_PATH.open("a", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())


def update_runtime_status(state, phone_number="", message=""):
    allowed = {"disabled", "connecting", "qr", "connected", "disconnected", "logged_out", "number_mismatch", "error"}
    state = str(state or "error").strip().lower()
    if state not in allowed:
        state = "error"
    with _STATE_LOCK:
        _RUNTIME.update({
            "state": state,
            "connected": state == "connected",
            "phone_number": re.sub(r"\D", "", str(phone_number or ""))[:20],
            "updated_at": _iso(),
            "last_error": str(message or "")[:240] if state in {"error", "disconnected", "number_mismatch"} else "",
        })
        if state != "qr":
            _RUNTIME["qr"] = ""
            _RUNTIME["qr_expires_at"] = ""
        return {key: value for key, value in _RUNTIME.items() if key not in {"qr"}}


def set_pairing_qr(qr_text, expires_seconds=60):
    qr_text = str(qr_text or "")
    if not qr_text or len(qr_text) > 5000:
        raise ValueError("A valid temporary pairing QR payload is required.")
    expires_seconds = max(10, min(int(expires_seconds or 60), 120))
    expiry = now_utc() + timedelta(seconds=expires_seconds)
    with _STATE_LOCK:
        _RUNTIME.update({
            "state": "qr",
            "connected": False,
            "updated_at": _iso(),
            "qr": qr_text,
            "qr_expires_at": _iso(expiry),
            "last_error": "",
        })
    return {"success": True, "expires_at": _iso(expiry)}


def runtime_status():
    with _STATE_LOCK:
        result = {key: value for key, value in _RUNTIME.items() if key != "qr"}
        expiry = _parse_time(_RUNTIME.get("qr_expires_at"))
        result["qr_available"] = bool(_RUNTIME.get("qr") and expiry and expiry > now_utc())
        return result


def current_qr():
    with _STATE_LOCK:
        expiry = _parse_time(_RUNTIME.get("qr_expires_at"))
        if not _RUNTIME.get("qr") or not expiry or expiry <= now_utc():
            _RUNTIME["qr"] = ""
            return ""
        return _RUNTIME["qr"]


def _load_list(path):
    value = _read_json(path, [])
    return value if isinstance(value, list) else []


def enqueue_outbox(kind, text, attachments=None, recipient=""):
    text = str(text or "").strip()[:4000]
    if not text:
        raise ValueError("WhatsApp outbox text cannot be empty.")
    attachments = attachments if isinstance(attachments, list) else []
    safe_attachments = []
    for attachment in attachments[:5]:
        name = str(attachment or "")
        if not re.fullmatch(r"sooqify_audit_\d{8}_\d{6}(?:_employees)?\.(?:csv|xlsx)", name):
            raise ValueError("Only generated Sooqify audit report files can be queued.")
        if name not in safe_attachments:
            safe_attachments.append(name)

    item = {
        "job_id": uuid.uuid4().hex,
        "kind": str(kind or "message")[:40],
        "text": text,
        "attachments": safe_attachments,
        "recipient": re.sub(r"\D", "", str(recipient or ""))[:20],
        "status": "queued",
        "attempts": 0,
        "created_at": _iso(),
        "next_attempt_at": _iso(),
        "lease_id": "",
        "lease_expires_at": "",
        "sent_at": "",
        "last_error": "",
    }
    with _STATE_LOCK:
        items = _load_list(OUTBOX_PATH)
        items.append(item)
        _write_json_atomic(OUTBOX_PATH, items[-2000:])
    return item["job_id"]


def claim_outbox(worker_id, lease_seconds=90):
    worker_id = re.sub(r"[^A-Za-z0-9_.-]", "", str(worker_id or ""))[:80]
    if not worker_id:
        raise ValueError("worker_id is required.")
    now = now_utc()
    with _STATE_LOCK:
        items = _load_list(OUTBOX_PATH)
        for item in items:
            if item.get("status") == "sent" or item.get("status") == "failed":
                continue
            next_attempt = _parse_time(item.get("next_attempt_at"))
            lease_expiry = _parse_time(item.get("lease_expires_at"))
            available = item.get("status") == "queued" and (not next_attempt or next_attempt <= now)
            expired_lease = item.get("status") == "sending" and (not lease_expiry or lease_expiry <= now)
            if available or expired_lease:
                item["status"] = "sending"
                item["attempts"] = int(item.get("attempts") or 0) + 1
                item["worker_id"] = worker_id
                item["lease_id"] = uuid.uuid4().hex
                item["lease_expires_at"] = _iso(now + timedelta(seconds=max(30, min(int(lease_seconds), 600))))
                _write_json_atomic(OUTBOX_PATH, items)
                return {key: value for key, value in item.items() if key not in {"recipient"}}
        return None


def acknowledge_outbox(job_id, lease_id, success, error=""):
    with _STATE_LOCK:
        items = _load_list(OUTBOX_PATH)
        for item in items:
            if item.get("job_id") != job_id or item.get("lease_id") != lease_id or item.get("status") != "sending":
                continue
            if success:
                item.update({"status": "sent", "sent_at": _iso(), "last_error": ""})
            else:
                item["last_error"] = str(error or "send failed")[:240]
                if int(item.get("attempts") or 0) >= 8:
                    item["status"] = "failed"
                else:
                    delay = min(3600, 30 * (2 ** max(0, int(item.get("attempts") or 1) - 1)))
                    item["status"] = "queued"
                    item["next_attempt_at"] = _iso(now_utc() + timedelta(seconds=delay))
            item["lease_id"] = ""
            item["lease_expires_at"] = ""
            _write_json_atomic(OUTBOX_PATH, items)
            return True
    return False


def create_delete_confirmation(local_id, archive_key, record, sender, ttl_minutes=15):
    local_id = int(local_id)
    if local_id <= 0 or not isinstance(record, dict):
        raise ValueError("A valid archive record is required.")
    if len(json.dumps(record, ensure_ascii=False)) > 2_000_000:
        raise ValueError("The archive record exceeds the safe backup size limit.")
    backup_id = f"bkp_{local_id}_{uuid.uuid4().hex[:12]}"
    request_id = uuid.uuid4().hex
    code = "".join(__import__("secrets").choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    now = now_utc()
    backup_path = BACKUPS_DIR / f"{backup_id}.json"
    _write_json_atomic(backup_path, {
        "format_version": 1,
        "backup_id": backup_id,
        "local_id": local_id,
        "archive_key": str(archive_key or "")[:200],
        "source": "read_only_shared_archive_pre_delete",
        "created_at": _iso(now),
        "requested_by": re.sub(r"\D", "", str(sender or ""))[:20],
        "record": record,
        "local_backup_received": False,
    })
    item = {
        "request_id": request_id,
        "local_id": local_id,
        "archive_key": str(archive_key or "")[:200],
        "backup_id": backup_id,
        "confirm_code_hash": hashlib.sha256(code.encode("ascii")).hexdigest(),
        "requested_by": re.sub(r"\D", "", str(sender or ""))[:20],
        "requested_at": _iso(now),
        "expires_at": _iso(now + timedelta(minutes=max(2, min(int(ttl_minutes), 30)))),
        "status": "awaiting_confirmation",
    }
    with _STATE_LOCK:
        requests = _load_list(DELETE_REQUESTS_PATH)
        requests = [r for r in requests if not (r.get("status") == "awaiting_confirmation" and r.get("requested_by") == item["requested_by"])]
        requests.append(item)
        _write_json_atomic(DELETE_REQUESTS_PATH, requests[-500:])
    _append_audit({
        "event": "delete_confirmation_created",
        "request_id": request_id,
        "local_id": local_id,
        "backup_id": backup_id,
        "requested_by": item["requested_by"],
        "at": _iso(now),
    })
    return {"request_id": request_id, "backup_id": backup_id, "confirm_code": code, "expires_at": item["expires_at"]}


def confirm_delete_request(code, sender):
    code = str(code or "").strip().upper()
    sender = re.sub(r"\D", "", str(sender or ""))[:20]
    supplied_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    now = now_utc()
    with _STATE_LOCK:
        requests = _load_list(DELETE_REQUESTS_PATH)
        for item in requests:
            if item.get("status") != "awaiting_confirmation" or item.get("requested_by") != sender:
                continue
            expiry = _parse_time(item.get("expires_at"))
            if not expiry or expiry <= now:
                item["status"] = "expired"
                continue
            if not hmac.compare_digest(item.get("confirm_code_hash", ""), supplied_hash):
                continue
            item["status"] = "confirmed"
            item["confirmed_at"] = _iso(now)
            job = {
                "job_id": uuid.uuid4().hex,
                "action": "delete_local_archive_record",
                "local_id": item["local_id"],
                "archive_key": item.get("archive_key", ""),
                "backup_id": item["backup_id"],
                "requested_by": sender,
                "status": "queued",
                "attempts": 0,
                "created_at": _iso(now),
                "next_attempt_at": _iso(now),
                "lease_id": "",
                "lease_expires_at": "",
                "last_error": "",
            }
            jobs = _load_list(ARCHIVE_JOBS_PATH)
            jobs.append(job)
            _write_json_atomic(ARCHIVE_JOBS_PATH, jobs[-1000:])
            _write_json_atomic(DELETE_REQUESTS_PATH, requests[-500:])
            _append_audit({
                "event": "delete_confirmed_and_queued",
                "request_id": item["request_id"],
                "job_id": job["job_id"],
                "local_id": item["local_id"],
                "backup_id": item["backup_id"],
                "requested_by": sender,
                "at": _iso(now),
            })
            return {"confirmed": True, **job}
        _write_json_atomic(DELETE_REQUESTS_PATH, requests[-500:])
    return None


def cancel_delete_request(code, sender):
    code = str(code or "").strip().upper()
    sender = re.sub(r"\D", "", str(sender or ""))[:20]
    supplied_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
    with _STATE_LOCK:
        requests = _load_list(DELETE_REQUESTS_PATH)
        for item in requests:
            if item.get("status") == "awaiting_confirmation" and item.get("requested_by") == sender and hmac.compare_digest(item.get("confirm_code_hash", ""), supplied_hash):
                item["status"] = "cancelled"
                item["cancelled_at"] = _iso()
                _write_json_atomic(DELETE_REQUESTS_PATH, requests[-500:])
                _append_audit({"event": "delete_cancelled", "local_id": item["local_id"], "backup_id": item["backup_id"], "requested_by": sender, "at": _iso()})
                return True
        return False


def claim_archive_job(worker_id, lease_seconds=120):
    worker_id = re.sub(r"[^A-Za-z0-9_.-]", "", str(worker_id or ""))[:80]
    if not worker_id:
        raise ValueError("worker_id is required.")
    now = now_utc()
    with _STATE_LOCK:
        jobs = _load_list(ARCHIVE_JOBS_PATH)
        for item in jobs:
            if item.get("status") in {"completed", "failed", "cancelled"}:
                continue
            next_attempt = _parse_time(item.get("next_attempt_at"))
            lease_expiry = _parse_time(item.get("lease_expires_at"))
            available = item.get("status") == "queued" and (not next_attempt or next_attempt <= now)
            expired_lease = item.get("status") == "processing" and (not lease_expiry or lease_expiry <= now)
            if available or expired_lease:
                item.update({
                    "status": "processing",
                    "worker_id": worker_id,
                    "lease_id": uuid.uuid4().hex,
                    "lease_expires_at": _iso(now + timedelta(seconds=max(30, min(int(lease_seconds), 900)))),
                    "attempts": int(item.get("attempts") or 0) + 1,
                })
                _write_json_atomic(ARCHIVE_JOBS_PATH, jobs)
                return dict(item)
    return None


def get_archive_job(job_id, lease_id=""):
    with _STATE_LOCK:
        for item in _load_list(ARCHIVE_JOBS_PATH):
            if item.get("job_id") == job_id and (not lease_id or item.get("lease_id") == lease_id):
                return dict(item)
    return None


def save_local_backup(job_id, lease_id, record):
    if not isinstance(record, dict) or len(json.dumps(record, ensure_ascii=False)) > 2_000_000:
        raise ValueError("Local archive record is invalid or too large.")
    with _STATE_LOCK:
        jobs = _load_list(ARCHIVE_JOBS_PATH)
        job = next((item for item in jobs if item.get("job_id") == job_id), None)
        if not job or job.get("status") != "processing" or job.get("lease_id") != lease_id:
            raise ValueError("Archive job lease is not valid.")
        local_id = int(job.get("local_id") or 0)
        if int(record.get("id") or 0) != local_id:
            raise ValueError("Backup record Local ID does not match the approved request.")
        backup_id = str(job.get("backup_id") or "")
        backup_path = BACKUPS_DIR / f"{backup_id}.json"
        backup = _read_json(backup_path, None)
        if not isinstance(backup, dict) or int(backup.get("local_id") or 0) != local_id:
            raise ValueError("The pre-delete backup is unavailable.")
        backup["local_record"] = record
        backup["local_backup_received"] = True
        backup["local_backup_at"] = _iso()
        _write_json_atomic(backup_path, backup)
        job["local_backup_received"] = True
        _write_json_atomic(ARCHIVE_JOBS_PATH, jobs)
        _append_audit({"event": "local_record_backup_saved", "job_id": job_id, "local_id": local_id, "backup_id": backup_id, "at": _iso()})
        return backup_id


def finish_archive_job(job_id, lease_id, success, error="", already_absent=False):
    with _STATE_LOCK:
        jobs = _load_list(ARCHIVE_JOBS_PATH)
        job = next((item for item in jobs if item.get("job_id") == job_id), None)
        if not job or job.get("status") != "processing" or job.get("lease_id") != lease_id:
            return None
        action = job.get("action")
        if success and action == "delete_local_archive_record" and not already_absent and not job.get("local_backup_received"):
            return None
        if success and action == "restore_local_archive_record":
            tombstones = _read_json(TOMBSTONES_PATH, {})
            tombstones = tombstones if isinstance(tombstones, dict) else {}
            existing = tombstones.get(str(job.get("local_id")))
            if not isinstance(existing, dict) or existing.get("backup_id") != job.get("backup_id"):
                return None

        now = now_utc()
        if success:
            job["status"] = "completed"
            job["completed_at"] = _iso(now)
            job["last_error"] = ""
            job["already_absent"] = bool(already_absent)
            event = f"{action}_completed"
            if action == "delete_local_archive_record" and not already_absent:
                tombstones = _read_json(TOMBSTONES_PATH, {})
                tombstones = tombstones if isinstance(tombstones, dict) else {}
                tombstones[str(job["local_id"])] = {
                    "local_id": int(job["local_id"]),
                    "backup_id": str(job["backup_id"]),
                    "archive_key": str(job.get("archive_key") or "")[:200],
                    "requested_by": str(job.get("requested_by") or ""),
                    "created_at": _iso(now),
                    "status": "active",
                }
                _write_json_atomic(TOMBSTONES_PATH, tombstones)
            elif action == "restore_local_archive_record":
                tombstones = _read_json(TOMBSTONES_PATH, {})
                tombstones = tombstones if isinstance(tombstones, dict) else {}
                tombstones.pop(str(job["local_id"]), None)
                _write_json_atomic(TOMBSTONES_PATH, tombstones)
        elif int(job.get("attempts") or 0) >= 10:
            job["status"] = "failed"
            job["completed_at"] = _iso(now)
            job["last_error"] = str(error or "archive operation failed")[:240]
            event = f"{action}_failed"
        else:
            job["status"] = "queued"
            delay = min(3600, 30 * (2 ** max(0, int(job.get("attempts") or 1) - 1)))
            job["next_attempt_at"] = _iso(now + timedelta(seconds=delay))
            job["last_error"] = str(error or "archive operation failed")[:240]
            event = f"{action}_retry"
        job["lease_id"] = ""
        job["lease_expires_at"] = ""
        _write_json_atomic(ARCHIVE_JOBS_PATH, jobs)
        _append_audit({"event": event, "job_id": job_id, "action": action, "local_id": job.get("local_id"), "backup_id": job.get("backup_id"), "at": _iso(now), "error": job.get("last_error", "")})
        if success and action == "delete_local_archive_record":
            if already_absent:
                text = f"السجل المحلي رقم {job['local_id']} كان غير موجود على جهاز الإضافة؛ لم يُحذف أي سجل الآن. لا يزال بإمكانك استخدام RESTORE فقط إذا كانت هناك عملية حذف سابقة مكتملة."
            else:
                text = f"تم حذف السجل المحلي رقم {job['local_id']} بأمر مؤكد مع حفظ نسخة احتياطية. لم يُحذف أي منتج من Sooqify. النسخة: {job['backup_id']}. سيُطبّق المنع على الأجهزة التي تشغّل الإضافة وتتصل بالخدمة؛ RESTORE {job['backup_id']} يزيله ويطلب مزامنة الأرشيف المشترك."
            enqueue_outbox("archive_delete_result", text, recipient=job.get("requested_by", ""))
        elif success and action == "restore_local_archive_record":
            enqueue_outbox(
                "archive_restore_result",
                f"اكتملت محاولة الاسترجاع للسجل المحلي رقم {job['local_id']} عبر مزامنة الأرشيف المشترك، وأُلغي منع الحذف. النسخة المرجعية: {job['backup_id']}. إذا بقي غير ظاهر، أعد المحاولة بعد التأكد من اتصال الأرشيف المشترك.",
                recipient=job.get("requested_by", ""),
            )
        elif not success and job.get("status") == "failed":
            if action == "delete_local_archive_record":
                failure_text = (
                    f"تعذر تأكيد حذف Local ID {job['local_id']} بعد محاولات الاتصال. لم يُحذف منتج من Sooqify، "
                    "ولا يُفعّل منع حذف جديد. افحص حالة الأرشيف المحلي والنسخة الاحتياطية قبل إعادة الطلب."
                )
            else:
                failure_text = (
                    f"تعذرت مزامنة استرجاع Local ID {job['local_id']} بعد محاولات الاتصال. بقي منع الحذف نشطاً؛ "
                    "تحقق من اتصال الأرشيف المشترك ثم أرسل أمر RESTORE مجدداً."
                )
            enqueue_outbox("archive_operation_failed", failure_text, recipient=job.get("requested_by", ""))
        return dict(job)


def enqueue_restore(backup_id, sender):
    backup_id = str(backup_id or "").strip().lower()
    sender = re.sub(r"\D", "", str(sender or ""))[:20]
    if not re.fullmatch(r"bkp_\d+_[a-f0-9]{12}", backup_id):
        return None
    backup_path = BACKUPS_DIR / f"{backup_id}.json"
    backup = _read_json(backup_path, None)
    if not isinstance(backup, dict) or not backup.get("local_backup_received"):
        return None
    local_id = int(backup.get("local_id") or 0)
    with _STATE_LOCK:
        tombstones = _read_json(TOMBSTONES_PATH, {})
        tombstones = tombstones if isinstance(tombstones, dict) else {}
        tombstone = tombstones.get(str(local_id))
        if not isinstance(tombstone, dict) or tombstone.get("backup_id") != backup_id:
            return None
        if any(item.get("action") == "restore_local_archive_record" and item.get("backup_id") == backup_id and item.get("status") in {"queued", "processing"} for item in _load_list(ARCHIVE_JOBS_PATH)):
            return None
        job = {
            "job_id": uuid.uuid4().hex,
            "action": "restore_local_archive_record",
            "local_id": local_id,
            "backup_id": backup_id,
            "requested_by": sender,
            "status": "queued",
            "attempts": 0,
            "created_at": _iso(),
            "next_attempt_at": _iso(),
            "lease_id": "",
            "lease_expires_at": "",
            "last_error": "",
        }
        jobs = _load_list(ARCHIVE_JOBS_PATH)
        jobs.append(job)
        _write_json_atomic(ARCHIVE_JOBS_PATH, jobs[-1000:])
        _append_audit({"event": "restore_requested", "job_id": job["job_id"], "local_id": local_id, "backup_id": backup_id, "requested_by": sender, "at": job["created_at"]})
        return dict(job)


def load_backup(backup_id):
    backup_id = str(backup_id or "").strip().lower()
    if not re.fullmatch(r"bkp_\d+_[a-f0-9]{12}", backup_id):
        return None
    value = _read_json(BACKUPS_DIR / f"{backup_id}.json", None)
    return value if isinstance(value, dict) else None


def active_archive_tombstones():
    with _STATE_LOCK:
        value = _read_json(TOMBSTONES_PATH, {})
        if not isinstance(value, dict):
            return []
        return [dict(item) for item in value.values() if isinstance(item, dict) and item.get("status") == "active"]


def archive_queue_stats():
    with _STATE_LOCK:
        outbox = _load_list(OUTBOX_PATH)
        jobs = _load_list(ARCHIVE_JOBS_PATH)
        requests = _load_list(DELETE_REQUESTS_PATH)
        tombstones = active_archive_tombstones()
        return {
            "outbox_queued": sum(item.get("status") in {"queued", "sending"} for item in outbox),
            "archive_jobs_queued": sum(item.get("status") in {"queued", "processing"} for item in jobs),
            "delete_confirmations_pending": sum(item.get("status") == "awaiting_confirmation" for item in requests),
            "active_archive_tombstones": len(tombstones),
            "tombstones": [{"local_id": item.get("local_id"), "backup_id": item.get("backup_id"), "created_at": item.get("created_at")} for item in tombstones[:200]],
        }


def audit_log_tail(limit=100):
    limit = max(1, min(int(limit or 100), 500))
    try:
        lines = AUDIT_LOG_PATH.read_text(encoding="utf-8").splitlines()[-limit:]
    except OSError:
        return []
    result = []
    for line in lines:
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result


def primary_number():
    return re.sub(r"\D", "", os.getenv("WHATSAPP_PRIMARY_NUMBER", ""))[:20]


def reports_enabled():
    return os.getenv("WHATSAPP_ENABLED", "false").lower() in {"1", "true", "yes", "on"} and bool(primary_number())
