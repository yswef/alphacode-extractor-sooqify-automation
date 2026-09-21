import logging
from flask import Blueprint, jsonify, request

from app.services.sync_service import sync_pull_updates, sync_flush_queue, sync_reconcile_full
from app.repositories.sync_config_repository import load_sync_config, save_sync_config
from app.repositories.sync_queue_repository import load_sync_queue
from app.repositories.sync_state_repository import load_sync_state
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
    try:
        result = sync_reconcile_full()
        return jsonify(result), (200 if result.get('success') else 500)
    except Exception as exc:
        logger.exception('Manual sync reconcile failed: %s', exc)
        return jsonify({'success': False, 'error': str(exc)}), 500

@sync_bp.route("/api/sync/now", methods=["POST"])
def trigger_sync_now():
    """Arabic: تشغيل دورة مزامنة فورية عند الضغط على زر 'مزامنة الآن'. لو فشل الـpull فعلياً (خطأ شبكة من sync_call)، يرجع success:false + error بالمستوى الأعلى - نفس نمط /api/brands - بدل ادّعاء نجاح لمجرد عدم وجود Python exception. English: Run one immediate sync cycle for the 'sync now' button. If the pull actually fails (a network error from sync_call), returns success:false + a top-level error - matching the /api/brands pattern - instead of claiming success just because no Python exception was raised."""
    if not load_sync_config()["Enabled"]:
        return jsonify({"success": False, "error": "Sync is not enabled."}), 400
    try:
        pull_error = sync_pull_updates()
        sync_flush_queue()
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    if pull_error:
        return jsonify({
            "success": False,
            "error": pull_error,
            "status": load_sync_state(),
            "pending_queue": len(load_sync_queue()),
        }), 502
    return jsonify({"success": True, "status": load_sync_state(), "pending_queue": len(load_sync_queue())})

@sync_bp.route("/api/sync/login", methods=["POST"])
def login_sync():
    """Arabic: التحقق من حساب العضو عبر خادم المزامنة المركزي. English: Verify member account via central sync server."""
    data = request.get_json(silent=True) or {}
    name = normalize_text(data.get("name"))
    password = normalize_text(data.get("password"))
    if not name:
        return jsonify({"success": False, "error": "الاسم مطلوب."}), 400

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
    })

@sync_bp.route("/api/sync/config", methods=["POST"])
def set_sync_config():
    """Arabic: حفظ إعدادات المزامنة من لوحة الإضافة. English: Save sync settings from the extension popup."""
    data = request.get_json(silent=True) or {}
    existing = load_sync_config()
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
    save_sync_config({
        "Enabled": enabled,
        "ServerUrl": server_url,
        "Token": token,
        "AddedByName": added_by_name,
    })
    logger.info("Sync configuration updated. enabled=%s server=%s", safe_bool(enabled), server_url)
    return jsonify({"success": True})

@sync_bp.route("/api/sync/status", methods=["GET"])
def get_sync_status():
    """Arabic: حالة المزامنة للوحة التشخيص - آخر سحب/رفع وعدد العناصر المعلّقة. English: Sync status for the diagnostics tab - last pull/push and pending queue size."""
    config = load_sync_config()
    state = load_sync_state()
    queue = load_sync_queue()
    return jsonify({
        "success": True,
        "enabled": config["Enabled"],
        "server_url": config["ServerUrl"],
        "last_pull_at": state.get("last_pull_at") or "",
        "last_push_at": state.get("last_push_at") or "",
        "last_error": state.get("last_error") or "",
        "pending_queue": len(queue),
    })
