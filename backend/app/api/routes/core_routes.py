"""
Arabic: Blueprint للمسارات الأساسية: health, paths, brands.
English: Blueprint for core routes: health check, path management, and brand management.
Route = HTTP facade only. All logic stays in services / repositories.
"""
import logging
import os
from flask import Blueprint, jsonify, request

from app.core.runtime import paths_state
from app.repositories.paths_repository import save_paths_config
from app.repositories.sync_config_repository import load_sync_config
from app.services.product_helpers import (
    open_native_folder_dialog,
)
from app.services.sync_service import sync_call

logger = logging.getLogger(__name__)

core_bp = Blueprint("core", __name__)


# ---------------------------------------------------------------------------
# Routes — Health & Status
# ---------------------------------------------------------------------------

@core_bp.route("/api/health", methods=["GET"])
def health_check():
    """
    Arabic: فحص صحة الخادم. حقول "success" و"version" و"needs_folder_setup" إلزامية -
            popup.js يعتمد عليها فعلياً بدالة checkServer() لتحديد لون مؤشر "متصل".
    English: Server health check. The "success", "version" and "needs_folder_setup" fields are
             mandatory - popup.js's checkServer() depends on them to colour the "connected"
             indicator; an earlier rebuild of this route returned only status/sync_enabled/
             root_dir with no success field, so the check always silently failed
             (!data.success is always true) even while the server was genuinely up.
    """
    return jsonify({
        "success": True,
        "status": "ok",
        "service": "AlphaCode Extractor",
        "version": "5.8.1",
        "needs_folder_setup": not paths_state.ROOT_DIR_CONFIGURED,
        "sync_enabled": load_sync_config().get("Enabled", False),
        "root_dir_configured": paths_state.ROOT_DIR_CONFIGURED,
        "root_dir": paths_state.ROOT_DIR,
    })


# ---------------------------------------------------------------------------
# Routes — Path Management
# ---------------------------------------------------------------------------

@core_bp.route("/api/paths/status", methods=["GET"])
def get_paths_status():
    """Arabic: حالة مجلد الحفظ الحالي. English: Current save-folder status."""
    return jsonify({
        "success": True,
        "configured": paths_state.ROOT_DIR_CONFIGURED,
        "root_dir": paths_state.ROOT_DIR,
        "images_root": paths_state.BASE_DIR,
        "is_valid": paths_state.is_root_dir_valid(paths_state.ROOT_DIR),
    })


@core_bp.route("/api/paths/choose-folder", methods=["POST"])
def choose_root_folder():
    """
    Arabic: فتح نافذة اختيار مجلد من نظام التشغيل، حفظ الاختيار وإعادة حساب المسارات.
    English: Open a native OS folder picker, persist the choice and recompute all paths.
    """
    try:
        chosen = open_native_folder_dialog()
    except Exception as exc:
        logger.error("Native folder dialog failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500

    if not chosen:
        return jsonify({"success": False, "cancelled": True, "error": "No folder was selected."}), 400

    if not paths_state.is_root_dir_valid(chosen):
        return jsonify({"success": False, "error": "The selected folder is not writable."}), 400

    try:
        save_paths_config({"RootDir": chosen})
        paths_state.recompute()
    except Exception as exc:
        logger.error("Failed to save path config: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({
        "success": True,
        "configured": paths_state.ROOT_DIR_CONFIGURED,
        "root_dir": paths_state.ROOT_DIR,
        "images_root": paths_state.BASE_DIR,
    })


# ---------------------------------------------------------------------------
# Routes — Brand Management
# ---------------------------------------------------------------------------

@core_bp.route("/api/brands", methods=["GET"])
def api_get_brands():
    """
    Arabic: جلب قائمة البراندات — محلياً أو من السيرفر إن كانت المزامنة مفعّلة.
    English: Fetch the brand list — locally or from the server when sync is enabled.
    """
    sync_config = load_sync_config()
    if not sync_config.get("Enabled"):
        # Arabic: بدون مزامنة: إرجاع البراندات المحفوظة في الإعدادات المحلية.
        # English: Without sync: return brands from local settings.
        try:
            from app.services.upload_service import extract_settings
            # extract_settings reads from the request; here we build an empty payload
            # and fall through to the actual settings file via sync_config.
            # Brands without sync come from the sync_config allowedBrands or empty list.
            allowed = sync_config.get("AllowedBrands") or []
            return jsonify({"success": True, "brands": allowed})
        except Exception as exc:
            logger.warning("Could not read local brands: %s", exc)
            return jsonify({"success": True, "brands": []})

    data, error = sync_call("brands", method="GET")
    if error:
        return jsonify({"success": False, "error": error}), 502
    return jsonify({"success": True, "brands": (data or {}).get("brands", [])})


@core_bp.route("/api/brands/add", methods=["POST"])
def api_add_brand():
    """
    Arabic: إضافة براند جديد — يتطلب تفعيل المزامنة. English: Add a new brand — requires sync to be enabled.
    """
    sync_config = load_sync_config()
    if not sync_config.get("Enabled"):
        return jsonify({"success": False, "error": "Sync is disabled. Enable sync to add brands."}), 400

    req_data = request.get_json(silent=True) or {}
    data, error = sync_call("brands/add", method="POST", data=req_data)
    if error:
        return jsonify({"success": False, "error": error}), 502
    return jsonify(data or {"success": True})
