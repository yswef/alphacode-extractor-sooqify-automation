"""Arabic: منطق المزامنة مع الخادم المركزي (بدون حلقة دورية). English: Central sync business logic (no periodic worker)."""
import logging
import threading
import time
from datetime import datetime, timedelta

import requests

from app.repositories.sync_config_repository import load_sync_config
from app.repositories.sync_queue_repository import load_sync_queue, save_sync_queue
from app.repositories.sync_state_repository import load_sync_state, save_sync_state

logger = logging.getLogger("alphacode")

SYNC_LOCK = threading.RLock()
SYNC_HTTP_TIMEOUT = (5, 10)  # (connect, read) seconds - short so the UI never hangs on a bad connection.

# Arabic: مدة التهدئة بعد استقبال حظر 403 من الاستضافة (بالثواني) - قابلة للتعديل حسب سياسة استضافتك.
# English: Cooldown after receiving a 403 host block (seconds) - tune to match your host's policy.
SYNC_THROTTLE_COOLDOWN_SECONDS = 300

# Arabic: تأخير بسيط بين الطلبات المتتالية أثناء المزامنة الجماعية (دفعات كبيرة)، لتفادي
#         إغراق الاستضافة بعدد طلبات كبير خلال ثوانٍ قليلة والوصول لحد الحظر أصلاً.
# English: A small pacing delay between consecutive requests during bulk syncing, so a
#          large batch never floods the host fast enough to trigger a block in the first place.
SYNC_REQUEST_PACING_SECONDS = 0.3

# Arabic: الأرشيف مربوط عبر app.py عند الإقلاع (المسار يتغيّر حسب مجلد الحفظ المُعدّ من
#         المستخدم)، لكن القراءة/الكتابة الفعلية صارت من app.repositories.archive_repository.
# English: Archive is bound via app.py at startup (the path varies with the user's configured
#          save folder), but actual read/write now goes through app.repositories.archive_repository.
_load_archive = None
_save_archive = None
_save_lock = None


def bind_archive_runtime(load_archive, save_archive, save_lock):
    """Arabic: ربط قراءة/كتابة الأرشيف دون استيراد app.py. English: Bind archive I/O without importing app.py."""
    global _load_archive, _save_archive, _save_lock
    _load_archive = load_archive
    _save_archive = save_archive
    _save_lock = save_lock


def _safe_int(value, fallback):
    """Arabic: تحويل آمن إلى عدد صحيح. English: Safely coerce a value to integer."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return int(fallback)


def sync_call(action, payload=None, method="POST"):
    """Arabic: نداء موحّد لسكربت sync.php مع مهلة قصيرة وأخطاء واضحة، ودائرة أمان تمنع تكرار الطلبات لفترة بعد حظر 403 من الاستضافة. English: A single call point into sync.php with a short timeout and clear errors, plus a circuit breaker that stops retrying for a while after a host 403 block."""
    config = load_sync_config()
    if not config["Enabled"] or not config["ServerUrl"] or not config["Token"]:
        return None, "sync_disabled"

    # Arabic: لو الاستضافة حظرتنا مؤخراً (403)، لا نعيد المحاولة فوراً حتى لا نطيل مدة الحظر.
    # English: If the host recently blocked us (403), don't retry immediately or we extend the block.
    state = load_sync_state()
    throttled_until = state.get("throttled_until")
    if throttled_until:
        try:
            if datetime.fromisoformat(throttled_until) > datetime.now():
                return None, "sync_throttled"
        except ValueError:
            pass

    url = f"{config['ServerUrl']}/sync.php"
    headers = {"X-Sync-Token": config["Token"], "Content-Type": "application/json"}
    try:
        if method == "GET":
            response = requests.get(url, params={"action": action}, headers=headers, timeout=SYNC_HTTP_TIMEOUT)
        else:
            response = requests.post(url, params={"action": action}, headers=headers, json=payload or {}, timeout=SYNC_HTTP_TIMEOUT)

        if response.status_code == 403:
            block_state = load_sync_state()
            block_state["throttled_until"] = (datetime.now() + timedelta(seconds=SYNC_THROTTLE_COOLDOWN_SECONDS)).isoformat()
            block_state["last_error"] = (
                f"الاستضافة حظرت الطلبات مؤقتاً (403) بسبب كثرة/كبر الطلبات - "
                f"توقفت المزامنة تلقائياً لمدة {SYNC_THROTTLE_COOLDOWN_SECONDS // 60} دقيقة."
            )
            save_sync_state(block_state)
            logger.warning("Sync got HTTP 403 from host, backing off for %s seconds.", SYNC_THROTTLE_COOLDOWN_SECONDS)
            return None, "sync_blocked_403"

        data = response.json()
        if response.status_code >= 400 and not data.get("duplicate"):
            return data, data.get("error") or f"HTTP {response.status_code}"
        return data, None
    except requests.RequestException as exc:
        return None, str(exc)
    except ValueError as exc:
        return None, f"Invalid sync response: {exc}"


def sync_reserve_id():
    """Arabic: حجز ID فريد من الخادم المركزي؛ يرجع None عند التعطيل أو الفشل ليعمل الاحتياط المحلي. English: Reserve a unique ID centrally; returns None when disabled/unreachable so local numbering can take over."""
    data, error = sync_call("reserve_id", {}, method="POST")
    if error or not data or not data.get("success"):
        if error and error != "sync_disabled":
            logger.warning("Remote ID reservation failed, falling back to local numbering: %s", error)
        return None
    return _safe_int(data.get("id"), None) if data.get("id") is not None else None


def sync_reserve_key(dedup_key, added_by):
    """
    Arabic: قفل تفاؤلي - يحجز مفتاح المنتج مركزياً قبل تنزيل الصور لمنع تجهيز نفس المنتج مرتين من الطرفين.
    English: Optimistic lock - reserves the product key centrally before image download, preventing both sides from preparing the same product.
    Returns: (ok, conflict_item, error)
    """
    if not dedup_key:
        return True, None, None
    data, error = sync_call("reserve_key", {"key": dedup_key, "added_by": added_by}, method="POST")
    if error == "sync_disabled":
        return True, None, None
    if data and data.get("duplicate"):
        return False, data.get("existing"), None
    if error:
        logger.warning("Remote key reservation unavailable, continuing with local-only duplicate check: %s", error)
        return True, None, error
    return bool(data and data.get("success")), None, None


def sync_push_product(dedup_key, archive_item):
    """Arabic: رفع منتج مكتمل إلى الأرشيف المركزي؛ يوضع في طابور إعادة المحاولة عند فشل الاتصال. English: Push a finished product to the central archive; queued for retry on connection failure."""
    if not dedup_key or not load_sync_config()["Enabled"]:
        return
    data, error = sync_call("push", {"key": dedup_key, "product": archive_item}, method="POST")
    is_duplicate = bool(data and data.get("duplicate"))
    if not error or is_duplicate:
        with SYNC_LOCK:
            state = load_sync_state()
            state["last_push_at"] = datetime.now().isoformat(timespec="seconds")
            state["last_error"] = ""
            save_sync_state(state)
        return
    logger.warning("Immediate sync push failed, queueing for retry: %s", error)
    with SYNC_LOCK:
        queue = load_sync_queue()
        queue.append({
            "key": dedup_key, "product": archive_item, "attempts": 0,
            "queued_at": datetime.now().isoformat(timespec="seconds"),
        })
        save_sync_queue(queue)


def sync_flush_queue():
    """Arabic: إعادة محاولة إرسال العناصر المتراكمة بعد انقطاع الاتصال (Backoff بسيط عبر دورة الخيط الخلفي). English: Retry queued pushes after a connectivity gap (simple backoff via the background cycle)."""
    with SYNC_LOCK:
        queue = load_sync_queue()
    if not queue:
        return
    remaining = []
    for entry in queue:
        data, error = sync_call("push", {"key": entry["key"], "product": entry["product"]}, method="POST")
        is_duplicate = bool(data and data.get("duplicate"))
        if error and not is_duplicate:
            entry["attempts"] = entry.get("attempts", 0) + 1
            if entry["attempts"] < 20:
                remaining.append(entry)
            else:
                logger.error("Dropping sync queue item %s after 20 failed attempts.", entry.get("key"))
    with SYNC_LOCK:
        save_sync_queue(remaining)
        if len(remaining) != len(queue):
            state = load_sync_state()
            state["last_push_at"] = datetime.now().isoformat(timespec="seconds")
            save_sync_state(state)


# Arabic: كل كم ساعة تُجرى مصالحة كاملة تلقائياً. السحب التزايدي (since=آخر سحب) يمكن أن
#         يتخطى سجلات نهائياً لو تقدّمت العلامة المائية فوقها - وهذا ما حصل فعلياً: كان
#         بالسيرفر 3800 سجل مقابل 2476 محلياً، أي 1324 سجلاً مفقوداً، ومنتجات مستخدم كامل
#         غائبة عن التقارير لشهر بينما المزامنة تقول "نجحت". المصالحة الكاملة (since="")
#         تسحب كل شيء وتدمج الناقص، فتجعل المزامنة تشفي نفسها بدل أن تفقد بصمت.
# English: How often a full reconcile runs automatically. The incremental pull
#          (since=last_pull) can skip records permanently once the watermark moves past them -
#          which is exactly what happened: 3800 records on the server against 2476 locally,
#          1324 missing, with an entire user's products absent from reports for a month while
#          sync reported success. A full reconcile (since="") pulls everything and merges what
#          is missing, making sync self-healing instead of silently lossy.
FULL_RECONCILE_INTERVAL_HOURS = 6


def sync_auto_reconcile_if_due(force=False):
    """
    Arabic: يُجري مصالحة كاملة إن مضى وقت كافٍ منذ آخر واحدة (أو عند force). يُستدعى من
            دورة المزامنة العادية، فلا يحتاج المستخدم أن يتذكر زراً.
    English: Runs a full reconcile when enough time has passed since the last one (or on
             force). Called from the normal sync cycle, so the operator never has to remember
             a button.
    """
    config = load_sync_config()
    if not config["Enabled"]:
        return None

    state = load_sync_state()
    last_raw = str(state.get("last_full_reconcile_at") or "")
    if not force and last_raw:
        try:
            elapsed = datetime.now() - datetime.fromisoformat(last_raw)
            if elapsed < timedelta(hours=FULL_RECONCILE_INTERVAL_HOURS):
                return None
        except ValueError:
            # Arabic: طابع زمني تالف - نعامله كأنها لم تُجرَ قط ونصالح.
            # English: A corrupt timestamp - treat it as never run and reconcile.
            pass

    result = sync_reconcile_full()
    with SYNC_LOCK:
        state = load_sync_state()
        state["last_full_reconcile_at"] = datetime.now().isoformat(timespec="seconds")
        if isinstance(result, dict) and result.get("pulled_in"):
            state["last_reconcile_pulled"] = result.get("pulled_in")
        save_sync_state(state)
    return result


def sync_pull_updates():
    """Arabic: سحب منتجات الطرف الآخر ودمجها محلياً - يُستخدم في فحص التكرار حتى لا يعيد أحد الطرفين إضافة منتج أضافه الآخر. يرجع نص الخطأ لو فشل النداء، أو None لو نجح/كانت المزامنة معطّلة. English: Pull the other side's products and merge locally - used by duplicate checks so neither side re-adds what the other already added. Returns the error string on failure, or None on success/when sync is disabled."""
    config = load_sync_config()
    if not config["Enabled"]:
        return None
    state = load_sync_state()
    data, error = sync_call("pull", {"since": state.get("last_pull_at", "")}, method="POST")
    if error:
        with SYNC_LOCK:
            state["last_error"] = error
            save_sync_state(state)
        return error
    items = (data or {}).get("items") or {}
    if items:
        with _save_lock:
            archive = _load_archive()
            changed = False
            for key, item in items.items():
                if key not in archive:
                    archive[key] = item
                    changed = True
            if changed:
                _save_archive(archive)
    with SYNC_LOCK:
        state["last_pull_at"] = (data or {}).get("server_time") or datetime.now().isoformat(timespec="seconds")
        state["last_error"] = ""
        save_sync_state(state)


def sync_reconcile_full():
    """Arabic: سحب كامل أرشيف السيرفر ودمج أي منتج غير موجود محلياً فيه (بدون حذف أو استبدال
    أي شيء موجود عندك أصلاً)، ثم رفع أي منتج محلي غير موجود على السيرفر - بحيث تصير
    نسختك المحلية ونسخة السيرفر متطابقتين بالكامل بالاتجاهين.
    English: Pull the full server archive and merge in any product missing locally
    (never deletes or overwrites anything already there), then push any local-only
    product up to the server - so the local copy and the server end up fully mirrored
    in both directions.

    Returns a summary dict suitable for JSONifying.
    """
    config = load_sync_config()
    if not config["Enabled"]:
        return {"success": False, "error": "sync_disabled"}

    # Pull the full remote archive (since="" asks for everything)
    data, error = sync_call("pull", {"since": ""}, method="POST")
    if error:
        return {"success": False, "error": error}

    items = (data or {}).get("items") or {}
    server_keys = set(items.keys())

    # Arabic: نحسب "المحلي فقط" بناءً على الحالة قبل الدمج، وندمج منتجات السيرفر الناقصة
    # محلياً في نفس القفل حتى لا يتعارض مع حفظ آخر يجري بالتوازي.
    # English: Compute "local-only" from the state before merging, and merge in the
    # server's missing products under the same lock to avoid racing a concurrent save.
    with _save_lock:
        archive = _load_archive()
        local_keys = {k for k in archive.keys() if not str(k).startswith("_")}
        to_push = [k for k in sorted(local_keys) if k not in server_keys]

        pulled_in = 0
        for key, item in items.items():
            if key not in archive:
                archive[key] = item
                pulled_in += 1
        if pulled_in:
            _save_archive(archive)

    pushed = 0
    errors = []
    for key in to_push:
        try:
            archive_item = archive.get(key)
            if archive_item:
                # Use the existing push helper which queues on failure
                sync_push_product(key, archive_item)
                pushed += 1
        except Exception as exc:
            logger.warning("Reconcile push failed for %s: %s", key, exc)
            errors.append({"key": key, "error": str(exc)})
        # Arabic: تأخير بسيط بين كل طلب أثناء دفعة كبيرة، لتفادي إغراق الاستضافة والوصول لحد الحظر.
        # English: A small pacing delay between requests during a large batch, to avoid flooding the host into a block.
        time.sleep(SYNC_REQUEST_PACING_SECONDS)

    # Update sync state with pull time
    with SYNC_LOCK:
        state = load_sync_state()
        state["last_pull_at"] = (data or {}).get("server_time") or datetime.now().isoformat(timespec="seconds")
        state["last_error"] = ""
        save_sync_state(state)

    return {
        "success": True,
        "server_count": len(server_keys),
        "local_count": len(local_keys),
        "pulled_in_count": pulled_in,
        "will_push_count": len(to_push),
        "pushed_immediate": pushed,
        "errors": errors,
    }
