"""
Arabic: Blueprint للمسارات الأساسية: health, paths, brands.
English: Blueprint for core routes: health check, path management, and brand management.
Route = HTTP facade only. All logic stays in services / repositories.
"""
import logging
import os
from flask import Blueprint, jsonify, request

from app.core.runtime import paths_state
from app.core.utils import safe_int
from app.repositories.paths_repository import save_paths_config
from app.repositories.sync_config_repository import load_sync_config
from app.services.product_helpers import (
    canonicalize_brand_name,
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
        "version": "5.9.0",
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
    raw_brands = (data or {}).get("brands", [])
    brands = []
    for item in raw_brands if isinstance(raw_brands, list) else []:
        if not isinstance(item, dict):
            continue
        name = canonicalize_brand_name(item.get("name", item.get("brand_name", "")))
        brand_id = safe_int(item.get("id", item.get("brand_id")), 0)
        if name and brand_id > 0:
            brands.append({"id": brand_id, "name": name})
    return jsonify({"success": True, "brands": brands, "source": "shared_store_map"})


@core_bp.route("/api/brands/add", methods=["POST"])
def api_add_brand():
    """Arabic: إضافة ربط براند موجود فعلياً في المتجر. English: Add a mapping for a brand that already exists in the store."""
    if not load_sync_config().get("Enabled"):
        return jsonify({"success": False, "error": "Sync is disabled. Enable sync to add brands."}), 400

    req_data = request.get_json(silent=True) or {}
    name = canonicalize_brand_name(req_data.get("name"))
    brand_id = safe_int(req_data.get("id"), 0)
    if not name or brand_id <= 0:
        return jsonify({"success": False, "error": "Enter the exact store brand name and its current numeric ID."}), 400

    # PHP sync.php currently calls this action `add_brand`; keep the public Flask route
    # stable while matching that server contract. `payload` is the actual sync_call kwarg.
    data, error = sync_call("add_brand", payload={"name": name, "id": brand_id}, method="POST")
    if error:
        return jsonify({"success": False, "error": error}), 502
    if not data or not data.get("success"):
        return jsonify(data or {"success": False, "error": "The sync server rejected the brand."}), 502
    return jsonify(data)


@core_bp.route("/api/brands/sync", methods=["POST"])
def api_sync_brands():
    """Arabic: استيراد قائمة IDs الحالية من صفحة متجر Sooqify إلى الخريطة المشتركة.
    English: Import the current Sooqify brand IDs into the shared mapping.
    """
    if not load_sync_config().get("Enabled"):
        return jsonify({"success": False, "error": "Sync is disabled. Enable sync before importing store brands."}), 400

    req_data = request.get_json(silent=True) or {}
    if req_data.get("confirm_replace") is not True:
        return jsonify({"success": False, "error": "Set confirm_replace=true after reviewing the mapping."}), 400

    raw_brands = req_data.get("brands")
    if not isinstance(raw_brands, list) or not raw_brands or len(raw_brands) > 500:
        return jsonify({"success": False, "error": "Provide a non-empty brands array (maximum 500 records)."}), 400

    brands = []
    seen_ids = set()
    seen_names = set()
    for index, item in enumerate(raw_brands):
        if not isinstance(item, dict):
            return jsonify({"success": False, "error": f"Brand row {index + 1} must be an object."}), 400
        name = canonicalize_brand_name(item.get("name", item.get("brand_name", "")))
        brand_id = safe_int(item.get("id", item.get("brand_id")), 0)
        name_key = name.casefold()
        if not name or brand_id <= 0:
            return jsonify({"success": False, "error": f"Brand row {index + 1} needs a name and positive ID."}), 400
        if brand_id in seen_ids:
            return jsonify({"success": False, "error": f"Duplicate brand ID: {brand_id}."}), 400
        if name_key in seen_names:
            return jsonify({"success": False, "error": f"Duplicate brand name after normalization: {name}."}), 400
        seen_ids.add(brand_id)
        seen_names.add(name_key)
        brands.append({"id": brand_id, "name": name})

    payload = {"brands": brands, "confirm_replace": True}
    data, error = sync_call("brands/sync", payload=payload, method="POST")
    if error:
        return jsonify({"success": False, "error": error}), 502
    if not data or not data.get("success"):
        return jsonify(data or {"success": False, "error": "The sync server rejected the brand mapping."}), 502
    return jsonify(data)
