"""
Arabic: Blueprint لروابط التقارير وإصلاح البيانات والسجلات.
English: Blueprint for reports, data-repair, and logging routes.
Route = HTTP facade only. All logic stays in services / app-level helpers.
"""
import json
import logging
import os
import shutil
from datetime import datetime
from urllib.parse import unquote

import pandas as pd
from flask import Blueprint, jsonify, request, send_file, send_from_directory

from app.core.runtime import paths_state
from app.core.utils import normalize_text, safe_bool, safe_int
from app.repositories.sync_config_repository import load_sync_config
from app.services.sync_service import sync_call, sync_push_product, SYNC_REQUEST_PACING_SECONDS
from app.repositories.archive_repository import load_archive, save_archive

logger = logging.getLogger(__name__)

reports_bp = Blueprint("reports_bp", __name__)

# ---------------------------------------------------------------------------
# Arabic: الشكل المرجعي الكامل لعنصر منتج — يُستخدم فقط في تبويب إصلاح البيانات.
# English: Canonical product shape — used only by the data-repair tab.
# ---------------------------------------------------------------------------
REFERENCE_PRODUCT_FIELDS = [
    "id", "product_type", "name", "description", "name_en", "description_en",
    "name_ar", "description_ar", "brand_name", "brand_id", "style_code", "search_code",
    "price", "variants", "sizes", "date", "created_at", "workflow_status",
    "store_submission_status", "folder", "brand_folder", "date_folder", "added_by",
    "id_source", "upload_main_image_only", "images", "store_images", "store_main_image",
    "selected_image_indexes", "download_selected_images_only", "source_image_count",
    "downloaded_image_count", "source_url", "supplier_store_name", "supplier_store_id",
    "settings",
]

DATA_REPAIR_CONFLICT_IGNORED_FIELDS = {
    "synced_at", "reserved_at", "workflow_status", "store_submission_status",
    "workflow_updated_at", "workflow_details",
}

# ---------------------------------------------------------------------------
# Arabic: وحدات مساعدة محلية لطبقة API (لا تحتوي منطق وظيفي — فقط إجراءات ملف/تقرير).
# English: Local API-layer helpers (no domain logic — file/report operations only).
# ---------------------------------------------------------------------------

def _archive_entries(archive):
    """Return only real product records, excluding metadata keys."""
    return {
        key: value for key, value in archive.items()
        if not str(key).startswith("_") and isinstance(value, dict)
    }


def _load_current_archive():
    """Load archive from the runtime-resolved path."""
    return load_archive(paths_state.ARCHIVE_PATH)


def _read_recent_log_lines(limit=200):
    """Arabic: قراءة آخر أسطر السجل دون تحميل الملف كاملاً. English: Tail the external log file."""
    safe_limit = max(1, min(safe_int(limit, 200), 1000))
    log_path = paths_state.LOG_PATH
    if not os.path.exists(log_path):
        return []
    with open(log_path, "r", encoding="utf-8", errors="replace") as log_file:
        lines = log_file.readlines()
    return [line.rstrip("\n") for line in lines[-safe_limit:]]


def _log_price_pattern(source_text, raw_price_token, parsed_price, product_type,
                        style_code, search_code, extra=None):
    """Arabic: تسجيل نمط سعر جديد في ملف JSONL منفصل للمطور. English: Log a new price pattern to the developer JSONL file."""
    try:
        log_dir = paths_state.LOG_DIR
        log_path = paths_state.PRICE_PATTERNS_LOG_PATH
        os.makedirs(log_dir, exist_ok=True)
        entry = {
            "ts": datetime.now().isoformat(),
            "product_type": product_type,
            "style_code": style_code or "",
            "search_code": search_code or "",
            "raw_token": str(raw_price_token or "")[:200],
            "parsed_price": parsed_price,
            "source_sample": str(source_text or "")[:300],
            **(extra or {}),
        }
        with open(log_path, "a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as exc:
        logger.debug("price_pattern log write failed: %s", exc)


def _scan_data_repair_issues():
    """
    Arabic: يفحص الأرشيف المحلي ويرجّع الحقول الناقصة/الزائدة والأخطاء.
    English: Scan local archive and return missing/extra fields plus errors.
    """
    raw_archive = _load_current_archive()
    missing_fields: dict = {}
    extra_fields: dict = {}
    errors = []
    seen_ids: dict = {}

    for key, item in raw_archive.items():
        if str(key).startswith("_"):
            continue
        if not isinstance(item, dict):
            errors.append({
                "type": "corrupted_entry", "key": key, "id": None,
                "message": "هذا السجل ليس بصيغة منتج صالحة (Corrupted / not a JSON object).",
            })
            continue

        product_id = item.get("id")
        if product_id is None:
            errors.append({
                "type": "missing_id", "key": key, "id": None,
                "message": "منتج بدون id (قد يكون سجل حجز معلّق).",
            })
        elif product_id in seen_ids:
            errors.append({
                "type": "duplicate_id", "key": key, "id": product_id,
                "message": f"id مكرر مع المفتاح {seen_ids[product_id]}.",
            })
        else:
            seen_ids[product_id] = key

        for field in REFERENCE_PRODUCT_FIELDS:
            if field not in item:
                missing_fields.setdefault(field, []).append({"key": key, "id": product_id})
        for field in item.keys():
            if field not in REFERENCE_PRODUCT_FIELDS:
                extra_fields.setdefault(field, []).append({"key": key, "id": product_id})

    # Arabic: مقارنة مع نسخة السيرفر إن كانت المزامنة مفعّلة — قراءة فقط.
    # English: Compare against server copy when sync is enabled — read-only.
    sync_config = load_sync_config()
    if sync_config.get("Enabled"):
        data, error = sync_call("pull", {"since": ""}, method="POST")
        if error:
            errors.append({
                "type": "server_unreachable", "key": None, "id": None,
                "message": f"تعذر الوصول للسيرفر لمقارنة البيانات: {error}",
            })
        else:
            remote_items = (data or {}).get("items") or {}
            for key, local_item in raw_archive.items():
                if str(key).startswith("_") or not isinstance(local_item, dict):
                    continue
                remote_item = remote_items.get(key)
                if not remote_item:
                    continue
                local_compare = {k: v for k, v in local_item.items()
                                  if k not in DATA_REPAIR_CONFLICT_IGNORED_FIELDS}
                remote_compare = {k: v for k, v in remote_item.items()
                                   if k not in DATA_REPAIR_CONFLICT_IGNORED_FIELDS}
                if local_compare != remote_compare:
                    errors.append({
                        "type": "server_conflict", "key": key, "id": local_item.get("id"),
                        "message": "بيانات المنتج على الجهاز تختلف عن نسخة السيرفر.",
                    })

    return {"missing_fields": missing_fields, "extra_fields": extra_fields, "errors": errors}


import time as _time  # local alias so it doesn't clash with datetime

def _apply_data_repair_fix(field_values):
    """
    Arabic: يعبّئ الحقول الناقصة بالقيم الافتراضية بعد موافقة صريحة، مع نسخة احتياطية كاملة.
    English: Fill missing fields with operator-entered defaults, backing up the archive first.
    """
    import threading
    SAVE_LOCK = threading.RLock()

    if not isinstance(field_values, dict) or not field_values:
        return {"success": False, "error": "No field values were provided."}

    archive_path = paths_state.ARCHIVE_PATH

    with SAVE_LOCK:
        archive = _load_current_archive()
        backup_path = None
        if os.path.exists(archive_path):
            backup_name = f"archive_db.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            backup_path = os.path.join(os.path.dirname(archive_path), backup_name)
            shutil.copy2(archive_path, backup_path)

        updated_keys = []
        per_field_counts: dict = {}
        for field, default_value in field_values.items():
            count = 0
            for key, item in archive.items():
                if str(key).startswith("_") or not isinstance(item, dict):
                    continue
                if field not in item:
                    item[field] = default_value
                    if key not in updated_keys:
                        updated_keys.append(key)
                    count += 1
            per_field_counts[field] = count

        save_archive(archive_path, archive)

    push_errors = []
    pushed = 0
    for key in updated_keys:
        try:
            sync_push_product(key, archive.get(key))
            pushed += 1
        except Exception as exc:
            logger.warning("Data-repair sync push failed for %s: %s", key, exc)
            push_errors.append({"key": key, "error": str(exc)})
        _time.sleep(SYNC_REQUEST_PACING_SECONDS)

    logger.info(
        "Data repair applied. fields=%s updated_products=%s pushed=%s backup=%s",
        per_field_counts, len(updated_keys), pushed, backup_path,
    )
    return {
        "success": True, "backup_path": backup_path, "updated_products": len(updated_keys),
        "per_field_counts": per_field_counts, "pushed": pushed, "push_errors": push_errors,
    }


def _generate_data_repair_reports():
    """Arabic: يولّد ملفي Excel للأخطاء والحقول الزائدة داخل مجلد reports. English: Generate two Excel reports inside the reports folder."""
    scan = _scan_data_repair_issues()
    reports_dir = os.path.join(paths_state.ROOT_DIR, "reports")
    os.makedirs(reports_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    errors_filename = f"data_repair_errors_{timestamp}.xlsx"
    errors_rows = [
        {"النوع / Type": e["type"], "المفتاح / Key": e["key"], "ID": e["id"], "التفاصيل / Details": e["message"]}
        for e in scan["errors"]
    ]
    pd.DataFrame(errors_rows, columns=["النوع / Type", "المفتاح / Key", "ID", "التفاصيل / Details"]).to_excel(
        os.path.join(reports_dir, errors_filename), index=False
    )

    extra_filename = f"data_repair_extra_fields_{timestamp}.xlsx"
    extra_rows = [
        {"الحقل الزائد / Extra field": field, "المفتاح / Key": entry["key"], "ID": entry["id"]}
        for field, entries in scan["extra_fields"].items() for entry in entries
    ]
    pd.DataFrame(extra_rows, columns=["الحقل الزائد / Extra field", "المفتاح / Key", "ID"]).to_excel(
        os.path.join(reports_dir, extra_filename), index=False
    )
    return errors_filename, extra_filename


# ---------------------------------------------------------------------------
# Routes — Reports
# ---------------------------------------------------------------------------

@reports_bp.route("/api/reports/generate", methods=["POST"])
def generate_pdf_report():
    """Arabic: توليد تقرير PDF يومي أو شهري من الأرشيف. English: Generate a daily or monthly PDF report from the archive."""
    # Arabic: اختيارية — إن لم يكن reportlab مثبتاً يرجع 501 واضح.
    # English: Optional — returns a clear 501 when reportlab is not installed.
    try:
        from app.services import report_service as reports_module
        reports_available = True
    except ImportError:
        reports_module = None
        reports_available = False

    if not reports_available:
        return jsonify({
            "success": False,
            "error": "Reports module unavailable. Run: pip install reportlab --break-system-packages",
        }), 501
    if not paths_state.ROOT_DIR_CONFIGURED:
        return jsonify({"success": False, "needs_folder_setup": True, "error": "No save folder is configured yet."}), 409

    data = request.get_json(silent=True) or {}
    scope = normalize_text(data.get("scope")).lower()
    # Arabic: "daily"/"monthly" محفوظان للتوافق الخلفي؛ و"days"/"range" هما النطاقان المرنان
    #         الجديدان (أيام متفرقة، أو مدى من-إلى يجوز أن يعبر الشهور).
    # English: "daily"/"monthly" are kept for backwards compatibility; "days"/"range" are the
    #          new flexible scopes (scattered days, or a from-to range that may cross months).
    if scope not in ("daily", "monthly", "days", "range"):
        scope = "daily"

    date_str = normalize_text(data.get("date"))
    try:
        target_date = datetime.strptime(date_str, "%Y-%m-%d") if date_str else datetime.now()
    except ValueError:
        return jsonify({"success": False, "error": "date must be in YYYY-MM-DD format."}), 400

    raw_days = data.get("days") if isinstance(data.get("days"), list) else []
    date_from = normalize_text(data.get("from"))
    date_to = normalize_text(data.get("to"))

    if scope == "days" and not raw_days:
        return jsonify({"success": False, "error": "اختر يوماً واحداً على الأقل."}), 400
    if scope == "range" and not (date_from and date_to):
        return jsonify({"success": False, "error": "حدد تاريخ البداية وتاريخ النهاية."}), 400

    try:
        days = reports_module.resolve_report_days(scope, target_date, raw_days, date_from, date_to)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400

    if scope == "days" and not days:
        return jsonify({"success": False, "error": "كل التواريخ المرسلة غير صالحة (المطلوب YYYY-MM-DD)."}), 400

    reports_dir = os.path.join(paths_state.ROOT_DIR, "reports")
    period_label = reports_module.describe_period(scope, days, target_date)
    filename = f"alphacode_{scope}_report_{period_label}.pdf"
    output_path = os.path.join(reports_dir, filename)

    try:
        archive = _load_current_archive()
        reports_module.generate_report(
            _archive_entries(archive), scope, output_path, target_date, days=days,
        )
    except Exception as exc:
        logger.error("Report generation failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500

    logger.info("Generated %s report for %s -> %s", scope, period_label, filename)
    return jsonify({
        "success": True,
        "filename": filename,
        "days_covered": len(days) if days else None,
        "download_url": f"http://127.0.0.1:5000/api/reports/download/{filename}",
    })


@reports_bp.route("/api/reports/download/<path:filename>", methods=["GET"])
def download_pdf_report(filename):
    """Arabic: تنزيل تقرير PDF مولّد مسبقاً. English: Download a previously generated PDF report."""
    safe_filename = os.path.basename(unquote(filename))
    reports_dir = os.path.join(paths_state.ROOT_DIR, "reports")
    file_path = os.path.join(reports_dir, safe_filename)
    if not os.path.isfile(file_path):
        return jsonify({"success": False, "error": "Report not found. Generate it first."}), 404
    return send_from_directory(reports_dir, safe_filename, as_attachment=True)


# ---------------------------------------------------------------------------
# Routes — Data Repair
# ---------------------------------------------------------------------------

@reports_bp.route("/api/data-repair/scan", methods=["GET"])
def api_data_repair_scan():
    """Arabic: فحص الأرشيف وإرجاع الحقول الناقصة/الزائدة والأخطاء. English: Scan the archive and return missing/extra fields plus errors."""
    try:
        result = _scan_data_repair_issues()
        return jsonify({"success": True, **result})
    except Exception as exc:
        logger.exception("Data-repair scan failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@reports_bp.route("/api/data-repair/apply", methods=["POST"])
def api_data_repair_apply():
    """Arabic: تطبيق القيم الافتراضية على الحقول الناقصة بعد موافقة صريحة. English: Apply default values to missing fields after explicit operator confirmation."""
    data = request.get_json(silent=True) or {}
    field_values = data.get("values") or {}
    try:
        result = _apply_data_repair_fix(field_values)
        return jsonify(result), (200 if result.get("success") else 400)
    except Exception as exc:
        logger.exception("Data-repair apply failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@reports_bp.route("/api/data-repair/report", methods=["POST"])
def api_data_repair_report():
    """Arabic: توليد تقريري الأخطاء والحقول الزائدة كملفي Excel. English: Generate the errors and extra-fields Excel reports."""
    if not paths_state.ROOT_DIR_CONFIGURED:
        return jsonify({"success": False, "needs_folder_setup": True, "error": "No save folder is configured yet."}), 409
    try:
        errors_filename, extra_filename = _generate_data_repair_reports()
        return jsonify({
            "success": True,
            "errors_report": {
                "filename": errors_filename,
                "download_url": f"http://127.0.0.1:5000/api/data-repair/download/{errors_filename}",
            },
            "extra_fields_report": {
                "filename": extra_filename,
                "download_url": f"http://127.0.0.1:5000/api/data-repair/download/{extra_filename}",
            },
        })
    except Exception as exc:
        logger.exception("Data-repair report generation failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@reports_bp.route("/api/data-repair/download/<path:filename>", methods=["GET"])
def api_data_repair_download(filename):
    """Arabic: تنزيل ملف تقرير إصلاح بيانات مولّد مسبقاً. English: Download a previously generated data-repair report file."""
    safe_filename = os.path.basename(unquote(filename))
    reports_dir = os.path.join(paths_state.ROOT_DIR, "reports")
    file_path = os.path.join(reports_dir, safe_filename)
    if not os.path.isfile(file_path):
        return jsonify({"success": False, "error": "Report not found. Generate it first."}), 404
    return send_from_directory(reports_dir, safe_filename, as_attachment=True)


# ---------------------------------------------------------------------------
# Routes — Logs
# ---------------------------------------------------------------------------

@reports_bp.route("/api/logs/price-patterns", methods=["GET"])
def get_price_patterns_log():
    """Arabic: تنزيل ملف أنماط الأسعار (للمطور فقط). English: Download the price-patterns log (developer-only)."""
    log_path = paths_state.PRICE_PATTERNS_LOG_PATH
    if not os.path.exists(log_path):
        return jsonify({"success": False, "error": "No price patterns recorded yet."}), 404
    return send_file(log_path, as_attachment=True, download_name="price_patterns.jsonl")


@reports_bp.route("/api/log/client", methods=["POST"])
def record_client_log():
    """Arabic: تسجيل أخطاء وأحداث الإضافة في ملف Python الخارجي. English: Record extension errors and events in the external Python log."""
    data = request.get_json(silent=True) or {}
    level_name = normalize_text(data.get("level")).upper() or "INFO"
    event_name = normalize_text(data.get("event")) or "client_event"
    message = normalize_text(data.get("message")) or "No message"

    # Arabic: تنظيف البيانات الحساسة قبل التسجيل.
    # English: Sanitize sensitive values before logging.
    sensitive_keys = {"_token", "token", "cookie", "authorization", "x-csrf-token", "x-xsrf-token"}
    raw_details = data.get("details") or {}

    def _sanitize(value, max_len=4000):
        if isinstance(value, dict):
            return {
                str(k): "[REDACTED]" if str(k).lower() in sensitive_keys else _sanitize(v, max_len)
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [_sanitize(v, max_len) for v in value[:100]]
        return normalize_text(value)[:max_len]

    details = _sanitize(raw_details)
    level = getattr(logging, level_name, logging.INFO)
    logger.log(level, "CLIENT | event=%s | message=%s | details=%s",
               event_name, message, json.dumps(details, ensure_ascii=False))

    # Arabic: لو الحدث يتعلق باكتشاف نمط سعر جديد نسجّله في ملف منفصل.
    # English: If the event is a new price pattern discovery, log it separately.
    if event_name in ("price_pattern_new", "price_pattern_unknown"):
        _log_price_pattern(
            source_text=details.get("source_sample"),
            raw_price_token=details.get("raw_token"),
            parsed_price=details.get("parsed_price"),
            product_type=details.get("product_type"),
            style_code=details.get("style_code"),
            search_code=details.get("search_code"),
            extra={"event": event_name, "message": message},
        )
    return jsonify({"success": True})


@reports_bp.route("/api/logs/recent", methods=["GET"])
def get_recent_logs():
    """Arabic: إعادة آخر أسطر السجل للوحة التشخيص. English: Return recent log lines to the diagnostics tab."""
    return jsonify({
        "success": True,
        "log_path": paths_state.LOG_PATH,
        "lines": _read_recent_log_lines(request.args.get("lines", 200)),
    })


@reports_bp.route("/api/logs/download", methods=["GET"])
def download_application_log():
    """Arabic: تنزيل ملف السجل الخارجي من لوحة الإضافة. English: Download the external application log from the popup."""
    log_path = paths_state.LOG_PATH
    if not os.path.exists(log_path):
        return jsonify({"success": False, "error": "The log file does not exist yet."}), 404
    return send_file(log_path, as_attachment=True, download_name="alphacode.log")
