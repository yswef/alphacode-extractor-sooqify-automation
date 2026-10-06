"""Arabic: منطق المزامنة مع الخادم المركزي، ويشمل الحلقة الدورية الحقيقية (كل 30 دقيقة افتراضياً).

هذا الملف هو المكان الوحيد الذي تُشغَّل فيه المزامنة التلقائية. قبل هذا التعديل كان
sync_background_worker معرَّفاً مرتين (backend/app.py كـ"كود ميت" وproduct_helpers.py بنسخة
تستدعي أسماء غير مستوردة أصلاً = NameError لو شُغّلت)، ولا تُستدعى أي نسخة منهما من نقطة
التشغيل الفعلية backend/app/main.py — فلم تكن هناك أي مزامنة تلقائية إطلاقاً، ولا تظهر
منتجات الطرف الآخر إلا بضغط زر "مزامنة الآن" يدوياً.

English: Central sync business logic, now including the real periodic worker (every 30
minutes by default). This module is the only place the automatic sync runs. Before this
change, sync_background_worker existed twice (backend/app.py as documented dead code, and a
copy in product_helpers.py that called names it never imported - a NameError if ever
invoked), and neither copy was started from the real entry point backend/app/main.py - so no
automatic sync ever ran, and the other operator's products only appeared after pressing
"sync now" by hand.
"""
import logging
import os
import threading
import time
from datetime import datetime, timedelta

import requests

from app.repositories.sync_config_repository import load_sync_config
# Arabic: save_sync_config مُعاد تصديره هنا لأن الكود القديم (backend/app.py) وتجربة القفل
#         في الاختبارات يستدعيانها من هذه الوحدة؛ حُذف استيرادها الآن فلا نعتمد عليه.
# English: save_sync_config used to be re-exported here for legacy callers and tests; nothing
#          depends on it any more, so the import is gone.
from app.repositories.sync_queue_repository import load_sync_queue, save_sync_queue
from app.repositories.sync_state_repository import load_sync_state, save_sync_state
# Arabic: قفل الإيقاف الطارئ (نسخة احتياطية ← مسح بيانات السيرفر ← إيقاف المزامنة نهائياً).
#         هذا القفل يسبق أي نداء شبكة في هذا الملف، فلا يخرج طلب واحد لسيرفر المزامنة بعده.
# English: The emergency-shutdown lock (backup -> erase the server data -> stop sync for good).
#          This lock precedes every network call in this file, so not one request leaves for the
#          sync server once it exists.
from app.repositories.sync_lock_repository import is_sync_locked

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


# =========================================================
# Arabic: المزامنة التلقائية الدورية - كل 30 دقيقة افتراضياً، وقابلة للتغيير من لوحة الإضافة
#         (حقل "تكرار المزامنة التلقائية" في sync_config.json) أو من متغير البيئة
#         ALPHACODE_SYNC_INTERVAL_SECONDS بالثواني لمن يريد ضبطاً دقيقاً/اختباراً سريعاً.
#
#         ليش هالدورة ضرورية أصلاً: المصالحة الكاملة كل 6 ساعات كانت تعمل فقط عند ضغط زر
#         "مزامنة الآن" أو بدء دفعة، وبقية الوقت لا يُسحب شيء من سجلات الطرف الآخر. فلو
#         أضاف زميلك منتجاً، ما راح يظهر عندك إطلاقاً حتى تضغط الزر يدوياً (أو تبدأ دفعة) —
#         وهذا سبب الشكوى "المزامنة مش شغالة".
# English: The periodic automatic sync - every 30 minutes by default, tunable from the popup
#          ("auto sync interval" field in sync_config.json) or via the
#          ALPHACODE_SYNC_INTERVAL_SECONDS environment variable, in seconds, for power users
#          and fast tests.
#
#          Why this cycle matters: the full reconcile (every FULL_RECONCILE_INTERVAL_HOURS)
#          only ever ran on a manual "sync now" press or at batch start; between those nothing
#          pulled the other side's records. A teammate could add a product and it would never
#          appear locally until the button was pressed by hand - the root cause of the
#          "sync isn't working" report.
# =========================================================
DEFAULT_AUTO_SYNC_MINUTES = 30
MIN_AUTO_SYNC_MINUTES = 5
MAX_AUTO_SYNC_MINUTES = 1440  # 24 hours

# Arabic: كم ينتظر الخيط بين كل فحص والذي يليه (يسمح بتغيير التكرار من الإعدادات بدون إعادة
#         تشغيل الخادم، ويرد على أمر الإيقاف بسرعة).
# English: How long the worker sleeps between checks (lets an interval change take effect
#          without restarting the backend, and reacts to stop quickly).
SYNC_WORKER_TICK_SECONDS = 15

# Arabic: أول دورة بعد الإقلاع بقليل (لا ننتظر نصف ساعة كاملة) حتى تظهر منتجات الطرف الآخر
#         فوراً عند فتح البرنامج.
# English: The first cycle runs shortly after startup (not a full half hour later) so the
#          other side's products show up right away when the backend is opened.
SYNC_WORKER_STARTUP_DELAY_SECONDS = 20

# Arabic: الطابور (رفع فشل مؤقتاً) يُعاد إرساله كل 5 دقائق بدل انتظار دورة الثلاثين دقيقة.
# English: The retry queue is flushed every 5 minutes instead of waiting for the 30-minute cycle.
SYNC_QUEUE_RETRY_INTERVAL_SECONDS = 300

# Arabic: معلومات الخيط الحيّ - تُقرأ فقط من مسار الحالة في لوحة الإضافة، ولا تُخزَّن على القرص.
# English: Live worker info - read by the popup's status route only, never stored on disk.
_SYNC_WORKER_INFO = {
    "running": False,
    "next_cycle_at": "",
    "started_at": "",
}
_sync_worker_started = False
_sync_worker_lock = threading.Lock()


def sync_auto_interval_seconds():
    """
    Arabic: تكرار المزامنة التلقائية بالثواني: متغيّر البيئة أولاً (للاختبارات والضبط الدقيق)،
            ثم قيمة الإعدادات المحفوظة من لوحة الإضافة، وإلا 30 دقيقة.
    English: The automatic sync interval in seconds: environment variable first (tests / fine
             control), then the popup's saved setting, otherwise 30 minutes.
    """
    override = _safe_int(os.getenv("ALPHACODE_SYNC_INTERVAL_SECONDS"), 0)
    if override > 0:
        return max(5, override)

    config = load_sync_config()
    minutes = _safe_int(config.get("AutoSyncMinutes"), DEFAULT_AUTO_SYNC_MINUTES)
    minutes = max(MIN_AUTO_SYNC_MINUTES, min(minutes, MAX_AUTO_SYNC_MINUTES))
    return minutes * 60


def sync_interval_label(interval_seconds=None):
    """
    Arabic: وصف مقروء للتكرار للسجلات - بالثواني لو أقل من دقيقة (متغير البيئة في الاختبارات
            مثلاً)، وإلا بالدقائق. بدونها كان السجل يطبع "every 0 minutes" لتكرار بالثواني.
    English: A readable interval label for the logs - seconds when under a minute (e.g. the env
             override in tests), otherwise minutes. Without it the log printed "every 0 minutes"
             for a seconds-based interval.
    """
    seconds = sync_auto_interval_seconds() if interval_seconds is None else int(interval_seconds)
    if seconds < 60:
        return f"{seconds} seconds"
    return f"{max(1, round(seconds / 60))} minutes"


def sync_worker_status():
    """Arabic: حالة خيط المزامنة الحيّ لعرضها في اللوحة (يعمل؟/التكرار/الدورة القادمة). English: Live worker status for the popup (running? interval? next run?)."""
    interval_seconds = sync_auto_interval_seconds()
    return {
        "running": bool(_SYNC_WORKER_INFO.get("running")),
        "interval_seconds": interval_seconds,
        "interval_minutes": max(1, round(interval_seconds / 60)),
        "next_cycle_at": _SYNC_WORKER_INFO.get("next_cycle_at") or "",
        "started_at": _SYNC_WORKER_INFO.get("started_at") or "",
    }


def sync_run_cycle(reason="manual"):
    """
    Arabic: دورة مزامنة كاملة واحدة: سحب تحديثات الطرف الآخر، إعادة إرسال الطابور، ثم مصالحة
            كاملة إن حان وقتها. تُستخدم من زر "مزامنة الآن" ومن الدورة التلقائية معاً حتى
            يتصرّف الزر والخيط بنفس الطريقة بالضبط.

            ترجع ملخصاً: success/error/new_items/new_from_others/pending_queue. وnew_from_others
            هو الرقم الذي تعتمد عليه الإضافة لإشعار "وصلت منتجات جديدة أضافها الطرف الآخر".
    English: One full sync cycle: pull the other side's updates, flush the retry queue, then run
             a full reconcile when due. Shared by the "sync now" button and the automatic
             worker so both behave identically.

             Returns a summary: success/error/new_items/new_from_others/pending_queue.
             new_from_others is what the extension uses to notify "new products from the other
             operator arrived".
    """
    config = load_sync_config()
    # Arabic: قفل الإيقاف الطارئ يُعامَل كتعطيل كامل: لا سحب، لا رفع، ولا إعادة إرسال طابور —
    #         فالدورة ترجع فوراً بخطأ واضح بدل أن تحاول الوصول لسيرفر ممسوح.
    # English: The emergency-shutdown lock counts as fully disabled: no pull, no push and no queue
    #          flush - the cycle returns a clear error at once instead of reaching for a wiped server.
    blocked = is_sync_locked()
    if not config["Enabled"] or blocked:
        result = {
            "success": False,
            "error": "sync_locked" if blocked else "sync_disabled",
            "reason": reason,
            "new_items": 0,
            "new_from_others": 0,
            "pending_queue": len(load_sync_queue()),
        }
    else:
        pull_error = sync_pull_updates()
        sync_flush_queue()
        # Arabic: المصالحة الكاملة تفشل بهدوء - خطؤها لا يُبطل نجاح دورة المزامنة نفسها.
        # English: The full reconcile fails quietly - its error must not invalidate the cycle.
        try:
            sync_auto_reconcile_if_due()
        except Exception as reconcile_error:
            logger.warning("Auto reconcile failed: %s", reconcile_error)

        state = load_sync_state()
        # Arabic: "من الطرف الآخر" تُقرأ فقط لو كانت من نفس السحب الذي يحمل العدد (نفس الطابع
        #         الزمني)، وإلا ترجع صفراً بدل نسبة أرقام سحب قديم لهذه الدورة.
        # English: "From the other operator" counts only when it belongs to the same pull as the
        #          count (same timestamp); otherwise zero, never attributing an older batch here.
        same_pull = bool(state.get("last_pull_new_from_others_at")) and (
            state.get("last_pull_new_from_others_at") == state.get("last_pull_new_at")
        )
        result = {
            "success": pull_error is None,
            "error": pull_error or "",
            "reason": reason,
            "new_items": _safe_int(state.get("last_pull_new_count"), 0),
            "new_from_others": _safe_int(state.get("last_pull_new_from_others"), 0) if same_pull else 0,
            "new_at": state.get("last_pull_new_at") or "",
            "pending_queue": len(load_sync_queue()),
        }

    with SYNC_LOCK:
        state = load_sync_state()
        state["last_cycle_at"] = datetime.now().isoformat(timespec="seconds")
        state["last_cycle_reason"] = reason
        save_sync_state(state)

    return result


def sync_background_worker(stop_event=None):
    """
    Arabic: الخيط الخلفي الحقيقي للمزامنة. يشتغل ما دام الباك اند شغالاً، ولا يحتاج فتح لوحة
            الإضافة إطلاقاً:
              - أول دورة بعد SYNC_WORKER_STARTUP_DELAY_SECONDS من الإقلاع (مزامنة سريعة عند التشغيل).
              - ثم دورة كل sync_auto_interval_seconds() (30 دقيقة افتراضياً).
              - وبين الدورات: إعادة إرسال طابور الرفع الفاشل كل 5 دقائق لو فيه عناصر.
            الدورة نفسها تُتخطى بسرعة لو المزامنة معطّلة، والخيط يستمر بالانتظار.

            English: The real background sync thread. Runs as long as the backend does and never
                     needs the popup open:
                       - first cycle SYNC_WORKER_STARTUP_DELAY_SECONDS after startup (a quick
                         sync at launch),
                       - then one cycle every sync_auto_interval_seconds() (30 minutes by default),
                       - between cycles: flush the failed-push retry queue every 5 minutes when
                         it holds anything.
                     A cycle short-circuits when sync is disabled; the thread keeps waiting.
    """
    global _sync_worker_started
    stop_event = stop_event or threading.Event()
    now_monotonic = time.monotonic
    next_cycle_at = now_monotonic() + max(0, SYNC_WORKER_STARTUP_DELAY_SECONDS)
    next_retry_at = now_monotonic() + SYNC_QUEUE_RETRY_INTERVAL_SECONDS

    _SYNC_WORKER_INFO.update({
        "running": True,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "next_cycle_at": datetime.fromtimestamp(
            time.time() + max(0, SYNC_WORKER_STARTUP_DELAY_SECONDS)
        ).isoformat(timespec="seconds"),
    })
    logger.info(
        "Background sync worker started (first cycle in %ss, then every %s).",
        SYNC_WORKER_STARTUP_DELAY_SECONDS, sync_interval_label(),
    )

    try:
        while not stop_event.is_set():
            current = now_monotonic()
            if current >= next_cycle_at:
                interval = sync_auto_interval_seconds()
                next_cycle_at = current + interval
                _SYNC_WORKER_INFO["next_cycle_at"] = (
                    datetime.fromtimestamp(time.time() + interval).isoformat(timespec="seconds")
                )
                try:
                    result = sync_run_cycle(reason="auto")
                    if result.get("success") and result.get("new_from_others"):
                        logger.info("Auto sync pulled %s new product(s) from the other operator.", result["new_from_others"])
                except Exception as exc:
                    logger.warning("Automatic sync cycle failed: %s", exc)
            elif current >= next_retry_at:
                next_retry_at = current + SYNC_QUEUE_RETRY_INTERVAL_SECONDS
                try:
                    if load_sync_config()["Enabled"] and not is_sync_locked() and load_sync_queue():
                        sync_flush_queue()
                except Exception as exc:
                    logger.warning("Automatic sync retry flush failed: %s", exc)

            stop_event.wait(SYNC_WORKER_TICK_SECONDS)
    finally:
        _SYNC_WORKER_INFO["running"] = False
        _SYNC_WORKER_INFO["next_cycle_at"] = ""
        _sync_worker_started = False
        logger.info("Background sync worker stopped.")


def start_sync_background_worker(stop_event=None):
    """
    Arabic: يُشغّل خيط المزامنة مرة واحدة فقط (استدعاء ثانٍ لا يفتح خيطاً ثانياً)، ويُرجع True
            لو فعلاً بدأ الخيط الآن.
    English: Starts the sync worker exactly once (a second call never opens a second thread);
             returns True only when it actually started the thread now.
    """
    global _sync_worker_started
    with _sync_worker_lock:
        if _sync_worker_started:
            return False
        _sync_worker_started = True
    thread = threading.Thread(
        target=sync_background_worker,
        kwargs={"stop_event": stop_event},
        name="alphacode-sync-worker",
        daemon=True,
    )
    thread.start()
    return True


def sync_call(action, payload=None, method="POST"):
    """
    Arabic: نداء موحّد لسكربت sync.php ببيانات الاعتماد المحفوظة على هذا الجهاز. يرفض الخروج
            إطلاقاً لو كانت المزامنة معطّلة أو كان قفل الإيقاف الطارئ موجوداً.
    English: The single call point into sync.php using this machine's saved credentials. It
             refuses to leave at all when sync is disabled or the emergency-shutdown lock exists.
    """
    config = load_sync_config()
    if not config["Enabled"] or not config["ServerUrl"] or not config["Token"]:
        return None, "sync_disabled"
    if is_sync_locked():
        return None, "sync_locked"
    return sync_http_call(config["ServerUrl"], config["Token"], action, payload, method)


def sync_http_call(server_url, token, action, payload=None, method="POST"):
    """
    Arabic: نداء HTTP خام لسكربت sync.php ببيانات اعتماد صريحة (تُستخدم في مسار الاستعادة الذي
            يعمل قبل حفظ الإعدادات، وفي الفحص الأولي للسيرفر الجديد). لا يقرأ الإعدادات المحلية
            ولا قفل الإيقاف — لأن من يستدعيه أدمن أعطى الرابط والكود بنفسه في نفس الطلب.
    English: A raw HTTP call into sync.php with explicit credentials (used by the restore path,
             which runs before the settings are saved, and by the first probe of a new server).
             It reads neither the local settings nor the shutdown lock - the caller is an admin
             who supplied the URL and token in that very request.
    """
    if not server_url or not token:
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

    url = f"{str(server_url).rstrip('/')}/sync.php"
    headers = {"X-Sync-Token": token, "Content-Type": "application/json"}
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
        # Arabic: الوضع المقفول/المعطّل سلوك متوقع لا خطأ يستحق تحذيراً في السجل.
        # English: The locked/disabled state is expected behaviour, not a warning-worthy error.
        if error and error not in ("sync_disabled", "sync_locked"):
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
    if error in ("sync_disabled", "sync_locked"):
        # Arabic: بدون سيرفر (معطّل أو موقوف نهائياً) يبقى الفحص المحلي للتكرار هو الحاكم.
        # English: With no server (disabled or permanently stopped) the local duplicate check rules.
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
    if error == "sync_locked":
        # Arabic: الوضع المقفول لا يُدخل شيئاً في طابور إعادة المحاولة - الطابور يُفرَّغ عند القفل
        #         أصلاً، وإضافته إليه تعني محاولة رفع أبدية كل 5 دقائق بلا فائدة.
        # English: The locked state never queues anything for retry - the queue is emptied when
        #          the lock is set, and adding to it would mean a pointless retry every 5 minutes.
        logger.info("Sync push skipped: sync is locked (server data was erased).")
        return
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
    if is_sync_locked():
        # Arabic: قفل الإيقاف الطارئ يمنع أي محاولة رفع، حتى للعناصر التي كانت بالطابور قبله.
        # English: The emergency lock blocks every push attempt, even items queued before it.
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
    if not config["Enabled"] or is_sync_locked():
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
    if is_sync_locked():
        # Arabic: القفل يعني "لا سيرفر بعد اليوم" - لا نُبلّغ الإضافة بخطأ كل 10 دقائق بلا داع.
        # English: The lock means "no server any more" - no need to report an error to the
        #          extension every 10 minutes.
        return None
    state = load_sync_state()
    data, error = sync_call("pull", {"since": state.get("last_pull_at", "")}, method="POST")
    if error:
        with SYNC_LOCK:
            state["last_error"] = error
            save_sync_state(state)
        return error
    items = (data or {}).get("items") or {}
    # Arabic: نحسب الجديد فعلينا (اللي مو موجود بأرشيفنا) ومن أضافه، حتى تعرض اللوحة "وصل
    #         N منتج جديد" وتعرف الإضافة أنها منتجات الطرف الآخر فتُشعر المستخدم.
    # English: Track what is genuinely new to us (not already in our archive) and who added it,
    #          so the popup can show "N new products arrived" and the extension can notify.
    my_name = str(config.get("AddedByName") or "").strip()
    added_count = 0
    added_from_others = 0
    if items:
        with _save_lock:
            archive = _load_archive()
            changed = False
            for key, item in items.items():
                if key not in archive:
                    archive[key] = item
                    changed = True
                    added_count += 1
                    added_by = str((item or {}).get("added_by") or "").strip()
                    if added_by and added_by != my_name:
                        added_from_others += 1
            if changed:
                _save_archive(archive)
    with SYNC_LOCK:
        now_iso = datetime.now().isoformat(timespec="seconds")
        state["last_pull_at"] = (data or {}).get("server_time") or now_iso
        state["last_error"] = ""
        state["last_pull_new_count"] = added_count
        state["last_pull_new_at"] = now_iso
        # Arabic: حقول "من الطرف الآخر" تُحدَّث فقط عند وجود منتجات فعلية منه، ولا تُصفَّر في
        #         سحب فارغ لاحق. السبب: الإضافة تقارن هذا الطابع الزمني بما أُشعرت به سابقاً،
        #         فلو صفّرناه بسحب فارغ بينهما يضيع الإشعار نهائياً بمنتجات وصلت فعلاً.
        # English: The "from the other operator" fields are updated only when such products
        #          actually arrived, and are never zeroed by a later empty pull - the extension
        #          compares this timestamp with the last one it notified about, so zeroing it in
        #          between would permanently swallow the notice for products that did arrive.
        if added_from_others:
            state["last_pull_new_from_others"] = added_from_others
            state["last_pull_new_from_others_at"] = now_iso
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
    if is_sync_locked():
        return {"success": False, "error": "sync_locked"}

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
