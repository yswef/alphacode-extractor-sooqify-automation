import logging
import os
from datetime import datetime

from flask import Blueprint, jsonify, request, send_file

from app.services.sync_service import (
    sync_pull_updates,
    sync_reconcile_full,
    sync_run_cycle,
    sync_worker_status,
    DEFAULT_AUTO_SYNC_MINUTES,
    MIN_AUTO_SYNC_MINUTES,
    MAX_AUTO_SYNC_MINUTES,
)
from app.repositories.sync_config_repository import load_sync_config, save_sync_config
from app.repositories.sync_queue_repository import load_sync_queue
from app.repositories.sync_state_repository import load_sync_state
from app.repositories import sync_lock_repository
# Arabic: ميزة الأدمن: نسخة احتياطية كاملة ← مسح بيانات السيرفر ← قفل المزامنة نهائياً (مع إعادة رفع لاحقاً).
# English: The admin feature: full backup -> erase the server data -> lock sync for good (with a
#          later re-upload).
from app.services import emergency_service
from app.core.utils import normalize_text, safe_bool

logger = logging.getLogger(__name__)

sync_bp = Blueprint('sync_bp', __name__)

@sync_bp.route('/api/sync/pull', methods=['POST'])
def api_sync_pull():
    """Arabic: pull خفيف فقط (بدون reconcile كامل) — يُستدعى تلقائياً عند بدء كل دفعة جديدة. English: Light pull-only (no full reconcile) — called automatically when a new batch starts."""
    try:
        sync_pull_updates()
        return jsonify({"success": True})
    except Exception as exc:
        logger.warning("sync/pull endpoint failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 502

@sync_bp.route('/api/sync/reconcile', methods=['POST'])
def api_sync_reconcile():
    """Manual endpoint to trigger a full reconcile: pull all remote items and push any local-only items."""
    if sync_lock_repository.is_sync_locked():
        # Arabic: بعد الإيقاف الطارئ لا معنى لأي دمج - الرسالة توضح السبب بدل خطأ شبكة غامض.
        # English: After the emergency shutdown a reconcile is meaningless - say why instead of
        #          surfacing an obscure network error.
        return jsonify({
            "success": False,
            "locked": True,
            "error": "المزامنة موقوفة نهائياً على هذا الجهاز (تم مسح بيانات السيرفر).",
        }), 409
    try:
        result = sync_reconcile_full()
        return jsonify(result), (200 if result.get('success') else 500)
    except Exception as exc:
        logger.exception('Manual sync reconcile failed: %s', exc)
        return jsonify({'success': False, 'error': str(exc)}), 500

@sync_bp.route("/api/sync/now", methods=["POST"])
def trigger_sync_now():
    """
    Arabic: تشغيل دورة مزامنة فورية - يستدعيها زر 'مزامنة الآن' والمنبّه الدوري في الإضافة
            (كخطة بديلة لو الخيط الخلفي متوقف لأي سبب) بنفس الدالة sync_run_cycle التي
            يستخدمها الخيط التلقائي، فيتصرّف الاثنان بنفس الطريقة تماماً.

            ترجع أيضاً new_items/new_from_others حتى تعرف الإضافة مباشرة أن منتجات جديدة
            وصلت من الطرف الآخر وتُشعر المستخدم بدل ما يكتشف الأمر بنفسه.

            لو فشل السحب فعلياً (خطأ شبكة من sync_call)، يرجع success:false + error بالمستوى
            الأعلى - نفس نمط /api/brands - بدل ادّعاء نجاح لمجرد عدم وجود Python exception.

    English: Run one immediate sync cycle - called by the 'sync now' button and by the
             extension's periodic alarm (a fallback if the background thread ever stops),
             sharing sync_run_cycle() with the automatic worker so both behave identically.

             Also returns new_items/new_from_others so the extension knows at once that new
             products arrived from the other operator and can notify, instead of making the
             operator discover it by chance.

             If the pull genuinely fails (a network error from sync_call), returns
             success:false + a top-level error - matching the /api/brands pattern - instead of
             claiming success just because no Python exception was raised.
    """
    if sync_lock_repository.is_sync_locked():
        return jsonify({
            "success": False,
            "locked": True,
            "error": "المزامنة موقوفة نهائياً على هذا الجهاز (تم مسح بيانات السيرفر).",
        }), 409
    if not load_sync_config()["Enabled"]:
        return jsonify({"success": False, "error": "Sync is not enabled."}), 400
    try:
        result = sync_run_cycle(reason="manual")
    except Exception as exc:
        logger.exception("Manual sync cycle failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500
    if not result.get("success"):
        return jsonify({
            "success": False,
            "error": result.get("error") or "sync_failed",
            "status": load_sync_state(),
            "pending_queue": result.get("pending_queue", len(load_sync_queue())),
        }), 502
    return jsonify({
        "success": True,
        "status": load_sync_state(),
        "new_items": result.get("new_items", 0),
        "new_from_others": result.get("new_from_others", 0),
        "pending_queue": result.get("pending_queue", len(load_sync_queue())),
    })

@sync_bp.route("/api/sync/login", methods=["POST"])
def login_sync():
    """
    Arabic: التحقق من حساب العضو عبر خادم المزامنة المركزي.

            حالة خاصة مهمة: بعد تنفيذ «إيقاف المزامنة ومسح بيانات السيرفر» تصبح المزامنة مقفولة
            على هذا الجهاز، فلا يُسأل السيرفر إطلاقاً (هو ممسوح أصلاً)، ويُسمح فقط بالدخول المحلي
            لحساب الأدمن - ومحمياً برمز الحماية المحلي إن ضبطه الأدمن. هذا هو ما يمنع أي عضو من
            تشغيل نسخته الخاصة بعد المسح.

    English: Verify a member account via the central sync server.

             One important special case: after "stop sync and erase the server data" runs, sync is
             locked on this machine, so the server is never asked (it is empty anyway) and only the
             local admin login is allowed - protected by the local guard password when the admin
             set one. This is what stops a member from running their own copy after the erase.
    """
    data = request.get_json(silent=True) or {}
    name = normalize_text(data.get("name"))
    password = normalize_text(data.get("password"))
    if not name:
        return jsonify({"success": False, "error": "الاسم مطلوب."}), 400

    lock = sync_lock_repository.load_sync_lock()
    if lock.get("Locked"):
        if name.lower() != "admin":
            return jsonify({
                "success": False,
                "locked": True,
                "error": "المزامنة موقوفة نهائياً على هذا الجهاز. الدخول المحلي متاح لحساب الأدمن فقط.",
            }), 403
        guard_ok, guard_error = emergency_service.verify_local_guard(password)
        if not guard_ok:
            return jsonify({"success": False, "locked": True, "error": guard_error}), 401
        return jsonify({"success": True, "member": {"role": "admin", "display_name": "Admin (Local)"}})

    config = load_sync_config()
    server_url = normalize_text(config.get("ServerUrl"))
    token = normalize_text(config.get("Token"))
    
    if not config.get("Enabled") or not server_url:
        if name.lower() == "admin" and password == "admin":
            return jsonify({"success": True, "member": {"role": "admin", "display_name": "Admin (Local)"}})
        return jsonify({"success": False, "error": "المزامنة غير مفعلة أو الرابط غير متوفر."}), 400

    if not token:
        return jsonify({
            "success": False,
            "error": "المزامنة مفعّلة لكن كود المزامنة فاضي. أدخل كود المزامنة من تبويب الإعدادات أولاً ثم حاول تسجيل الدخول مرة أخرى.",
        }), 400

    import urllib.request
    import urllib.error
    import json
    
    server_url_clean = server_url.rstrip('/')
    if not server_url_clean.endswith('.php'):
        server_url_clean = f"{server_url_clean}/sync.php"
        
    url = f"{server_url_clean}?action=whoami"
    payload = json.dumps({"key": name, "password": password}).encode("utf-8")
    
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Sync-Token", token)
        
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))
            return jsonify(result)
    except urllib.error.HTTPError as he:
        try:
            result = json.loads(he.read().decode("utf-8"))
            return jsonify(result), he.code
        except Exception:
            return jsonify({"success": False, "error": f"تسجيل الدخول مرفوض: HTTP {he.code}"}), 400
    except Exception as e:
        return jsonify({"success": False, "error": f"خطأ في الاتصال: {str(e)}"}), 500

@sync_bp.route("/api/sync/logout", methods=["POST"])
def logout_sync():
    """Arabic: تسجيل خروج وهمي (لا يحذف المفتاح). English: Logout endpoint for the popup to call; stateless on server."""
    # Currently stateless: the extension stores session locally. Return success for compatibility.
    return jsonify({"success": True, "message": "Logged out."})

@sync_bp.route("/api/sync/config", methods=["GET"])
def get_sync_config():
    """Arabic: إرجاع إعدادات المزامنة الحالية (المفتاح مُقنّع جزئياً لأمان أفضل). English: Return current sync settings (token partially masked for safety)."""
    config = load_sync_config()
    masked_token = (config["Token"][:4] + "…") if len(config["Token"]) > 4 else ("•" * len(config["Token"]))
    return jsonify({
        "success": True,
        "Enabled": config["Enabled"],
        "ServerUrl": config["ServerUrl"],
        "AddedByName": config["AddedByName"],
        "TokenSet": bool(config["Token"]),
        "TokenPreview": masked_token,
        "AutoSyncMinutes": config.get("AutoSyncMinutes", DEFAULT_AUTO_SYNC_MINUTES),
        "AutoSyncMinMinutes": MIN_AUTO_SYNC_MINUTES,
        "AutoSyncMaxMinutes": MAX_AUTO_SYNC_MINUTES,
    })

@sync_bp.route("/api/sync/config", methods=["POST"])
def set_sync_config():
    """
    Arabic: حفظ إعدادات المزامنة من لوحة الإضافة.

            بعد الإيقاف الطارئ لا تُقبل أي إعادة تفعيل صامتة: القفل ملف مستقل عن الإعدادات،
            والفتح يتطلب طلباً صريحاً فيه ConfirmUnlock مع رابط سيرفر وكود مزامنة جديدين ينجح
            عليهما فحص اتصال فعلي (‎/api/brands على السيرفر). هذا يمنع أي عضو من إحياء المزامنة
            بنفسه على جهازه.

    English: Save sync settings from the extension popup.

             After the emergency shutdown no silent re-enable is accepted: the lock is a file of
             its own, and releasing it requires an explicit request carrying ConfirmUnlock plus a
             new server URL and token that pass a real connectivity check (action=brands). This
             stops a member from reviving sync on their own machine.
    """
    data = request.get_json(silent=True) or {}
    existing = load_sync_config()
    if sync_lock_repository.is_sync_locked():
        if data.get("ConfirmUnlock") is not True:
            return jsonify({
                "success": False,
                "locked": True,
                "error": (
                    "المزامنة موقوفة نهائياً على هذا الجهاز، وإعادة تفعيلها تحتاج تأكيداً صريحاً من "
                    "الأدمن (ConfirmUnlock) مع رابط سيرفر وكود مزامنة جديدين."
                ),
            }), 409
        unlock_result = emergency_service.unlock_with_credentials(
            data.get("ServerUrl"), data.get("Token"), data.get("LocalGuardPassword") or ""
        )
        if not unlock_result.get("success"):
            return jsonify({"success": False, "locked": True, "error": unlock_result.get("error")}), 400
        logger.warning("Sync lock released from the popup with confirmed credentials.")
    # Arabic: إن أُرسل أي من الحقول التالية فاضياً/غائباً، نحافظ على القيمة المحفوظة سابقاً
    # بدل مسحها بالخطأ (نفس نمط Token) - حادثة حقيقية: POST بجسم فاضٍ {} مسح ServerUrl/
    # Enabled/AddedByName بالكامل لأنها كانت تُكتب كما وردت بدون أي حماية. Enabled حقل
    # منطقي: القيمة False الصريحة تُحترم (تعطيل مقصود)؛ فقط غياب الحقل (None) يحافظ على القديم.
    # English: If any of the following fields is sent empty/missing, keep the previously
    # saved value instead of wiping it by mistake (same pattern as Token) - real incident:
    # an empty-body POST {} wiped ServerUrl/Enabled/AddedByName entirely because they were
    # written as-is with no protection. Enabled is boolean: an explicit False is honored
    # (intentional disable); only a missing field (None) falls back to the old value.
    token = normalize_text(data.get("Token")) or existing["Token"]
    server_url = normalize_text(data.get("ServerUrl")) or existing["ServerUrl"]
    added_by_name = normalize_text(data.get("AddedByName")) or existing["AddedByName"]
    enabled = data.get("Enabled") if data.get("Enabled") is not None else existing["Enabled"]
    # Arabic: تكرار المزامنة التلقائية بالدقائق - غياب الحقل أو قيمة غير رقمية يُبقيان القيمة
    #         السابقة (نفس حماية بقية الحقول)، والقيمة الصريحة تُقصّ للحدود المسموحة.
    # English: Automatic sync interval in minutes - an absent or non-numeric value keeps the
    #          previous one (same protection as the other fields); an explicit value is
    #          clamped to the allowed range.
    auto_sync_minutes = existing.get("AutoSyncMinutes", DEFAULT_AUTO_SYNC_MINUTES)
    if data.get("AutoSyncMinutes") is not None:
        try:
            auto_sync_minutes = int(float(data.get("AutoSyncMinutes")))
        except (TypeError, ValueError):
            pass
        auto_sync_minutes = max(MIN_AUTO_SYNC_MINUTES, min(auto_sync_minutes, MAX_AUTO_SYNC_MINUTES))
    save_sync_config({
        "Enabled": enabled,
        "ServerUrl": server_url,
        "Token": token,
        "AddedByName": added_by_name,
        "AutoSyncMinutes": auto_sync_minutes,
    })
    logger.info("Sync configuration updated. enabled=%s server=%s", safe_bool(enabled), server_url)
    return jsonify({"success": True})

@sync_bp.route("/api/sync/status", methods=["GET"])
def get_sync_status():
    """
    Arabic: حالة المزامنة للوحة - آخر سحب/رفع، العناصر المعلّقة، وحالة الخيط التلقائي
            (يعمل؟ كل كم دقيقة؟ الدورة القادمة متى؟) مع نتيجة آخر سحب (كم منتج جديد وصل
            وكم منها من الطرف الآخر). هذه الحقول هي مصدر الإشعار في الإضافة وشاشة الحالة.

    English: Sync status for the popup - last pull/push, pending queue, the automatic worker
             state (running? interval? next cycle?) and the last pull outcome (how many new
             products arrived and how many came from the other operator). These fields feed
             the extension's notification and the status panel.
    """
    config = load_sync_config()
    state = load_sync_state()
    queue = load_sync_queue()
    worker = sync_worker_status()
    return jsonify({
        "success": True,
        "enabled": config["Enabled"],
        "server_url": config["ServerUrl"],
        "added_by_name": config.get("AddedByName") or "",
        "last_pull_at": state.get("last_pull_at") or "",
        "last_push_at": state.get("last_push_at") or "",
        "last_error": state.get("last_error") or "",
        "pending_queue": len(queue),
        "auto_worker_running": worker["running"],
        "auto_interval_minutes": worker["interval_minutes"],
        "auto_interval_seconds": worker["interval_seconds"],
        "next_auto_cycle_at": worker["next_cycle_at"],
        "last_cycle_at": state.get("last_cycle_at") or "",
        "last_cycle_reason": state.get("last_cycle_reason") or "",
        "last_pull_new_count": state.get("last_pull_new_count") or 0,
        "last_pull_new_from_others": state.get("last_pull_new_from_others") or 0,
        "last_pull_new_at": state.get("last_pull_new_at") or "",
        # Arabic: طابع زمني منفصل لآخر سحب فيه منتجات من الطرف الآخر - تعتمد عليه الإضافة
        #         للإشعار مرة واحدة فقط، ولا يتأثر بسحب فارغ لاحق.
        # English: A separate timestamp for the last pull that actually carried products from
        #          the other operator - the extension notifies once off it, and a later empty
        #          pull cannot clear it.
        "last_pull_new_from_others_at": state.get("last_pull_new_from_others_at") or "",
        "last_full_reconcile_at": state.get("last_full_reconcile_at") or "",
        # Arabic: حقول الإيقاف الطارئ - اللوحة تعتمد عليها لعرض شريط "المزامنة موقوفة نهائياً"
        #         وإظهار منطقة الخطر بالحالة الصحيحة.
        # English: The emergency-shutdown fields - the popup uses them for the "sync permanently
        #          stopped" banner and the danger zone's state.
        "locked": sync_lock_repository.is_sync_locked(),
        "lock": sync_lock_repository.load_sync_lock(),
        "server_time": datetime.now().isoformat(timespec="seconds"),
    })


# ===========================================================================
# Arabic: مسارات الإيقاف الطارئ - للأدمن فقط (الواجهة تخفيها عن الأعضاء، والقفل نفسه يمنع
#         أي تفعيل صامت). ثلاثة أجزاء: نسخة احتياطية كاملة، مسح بيانات السيرفر + قفل المزامنة،
#         ثم إعادة الرفع لاحقاً.
# English: The emergency-shutdown routes - admin only (the UI hides them from members, and the
#          lock itself blocks any silent re-enable). Three parts: a full backup, erasing the
#          server data + locking sync, then the later re-upload.
# ===========================================================================

@sync_bp.route("/api/sync/emergency/status", methods=["GET"])
def emergency_status():
    """Arabic: حالة الإيقاف الطارئ: مقفول؟ متى؟ أي نسخة احتياطية؟ وهل توجد عملية إعادة رفع جارية؟ English: Emergency state: locked? when? which backup? and is a re-upload running?"""
    status = emergency_service.emergency_status()
    status["success"] = True
    return jsonify(status)


@sync_bp.route("/api/sync/emergency/backup", methods=["POST"])
def emergency_backup():
    """
    Arabic: إنشاء نسخة احتياطية كاملة الآن (أرشيف هذا الجهاز + كل منتجات السيرفر + البراندات)
            وحفظها في مجلد النسخ الاحتياطية. لا تمسح ولا تغيّر أي شيء.
    English: Create a full backup right now (this machine's archive + every server product +
             brands) and store it in the backup folder. It erases and changes nothing.
    """
    data = request.get_json(silent=True) or {}
    try:
        backup = emergency_service.create_emergency_backup(
            note=normalize_text(data.get("Note")), actor=normalize_text(data.get("Actor")),
        )
    except Exception as exc:
        logger.exception("Emergency backup failed: %s", exc)
        return jsonify({"success": False, "error": f"تعذر إنشاء النسخة الاحتياطية: {exc}"}), 500
    backup["download_url"] = f"/api/sync/emergency/backup/{backup['name']}"
    return jsonify({"success": True, "backup": backup})


@sync_bp.route("/api/sync/emergency/backups", methods=["GET"])
def emergency_backups():
    """Arabic: قائمة النسخ الاحتياطية الموجودة على القرص. English: List the backups present on disk."""
    return jsonify({"success": True, "backups": emergency_service.list_emergency_backups()})


@sync_bp.route("/api/sync/emergency/backup/<path:name>", methods=["GET"])
def emergency_backup_download(name):
    """Arabic: تنزيل ملف نسخة احتياطية محفوظ (الاسم فقط، وبدون أي خروج من مجلد النسخ). English: Download a stored backup file (name only, never escaping the backup folder)."""
    path = emergency_service.resolve_backup_path(name)
    if not path or not os.path.exists(path):
        return jsonify({"success": False, "error": "ملف النسخة الاحتياطية غير موجود."}), 404
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


@sync_bp.route("/api/sync/emergency/shutdown", methods=["POST"])
def emergency_shutdown():
    """
    Arabic: التنفيذ النهائي: نسخة احتياطية كاملة، ثم مسح بيانات السيرفر، ثم قفل المزامنة على
            هذا الجهاز ومسح رابط السيرفر والمفتاح السري. يتطلب كتابة العبارة DELETE-SERVER.
    English: The final move: a full backup, then erase the server data, then lock sync on this
             machine and clear the server URL and secret token. Requires typing DELETE-SERVER.
    """
    data = request.get_json(silent=True) or {}
    result = emergency_service.run_emergency_shutdown(
        confirm=data.get("Confirm"),
        erase_server=safe_bool(data.get("EraseServer"), True),
        actor=normalize_text(data.get("Actor")),
        local_guard_password=str(data.get("LocalGuardPassword") or ""),
        note=normalize_text(data.get("Note")),
    )
    return jsonify(result), (200 if result.get("success") else 400)


@sync_bp.route("/api/sync/emergency/restore", methods=["POST"])
def emergency_restore():
    """Arabic: بدء إعادة رفع نسخة احتياطية إلى سيرفر مزامنة (يتطلب العبارة RESTORE + رابط وكود). English: Start re-uploading a backup to a sync server (requires the RESTORE phrase + URL and token)."""
    data = request.get_json(silent=True) or {}
    result = emergency_service.start_restore_job(
        backup_file=data.get("BackupFile"),
        server_url=normalize_text(data.get("ServerUrl")),
        token=normalize_text(data.get("Token")),
        confirm=data.get("Confirm"),
        guard_password=str(data.get("LocalGuardPassword") or ""),
    )
    return jsonify(result), (200 if result.get("success") else 400)


@sync_bp.route("/api/sync/emergency/restore/status", methods=["GET"])
def emergency_restore_status():
    """Arabic: تقدّم إعادة الرفع (كم منتجاً رُفع/فشل/تُخطي). English: Re-upload progress (how many products were pushed/failed/skipped)."""
    status = emergency_service.restore_status()
    status["success"] = True
    return jsonify(status)
