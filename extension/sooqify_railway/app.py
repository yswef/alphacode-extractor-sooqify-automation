"""Standalone Railway API for the Sooqify Audit companion."""

from __future__ import annotations

import atexit
import hmac
import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from flask import Flask, Response, jsonify, request, send_file, send_from_directory
from flask_cors import CORS

from archive_client import fetch_archive_snapshot
from remote_browser import RemoteBrowser, RemoteBrowserError
from reporting import build_daily_report, write_report_files
import whatsapp_store

logger = logging.getLogger("sooqify_audit")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())


class ArchiveSnapshotUnavailable(Exception):
    """Raised when the shared archive cannot be read safely for a report."""

APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Aden")
REPORT_TZ = ZoneInfo(APP_TIMEZONE)
DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent / "data"))).resolve()
SCANS_DIR = DATA_DIR / "scans"
PARTIAL_DIR = DATA_DIR / "partial_scans"
REPORTS_DIR = DATA_DIR / "reports"
SNAPSHOT_PATH = DATA_DIR / "latest_complete_scan.json"
BASELINES_PATH = DATA_DIR / "pricing_baselines.json"
AUDIT_API_TOKEN = os.getenv("AUDIT_API_TOKEN", "")
MAX_SCAN_PAGES = 5000
MAX_PRODUCTS_PER_PAGE = 200

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
CORS(app, resources={r"/api/*": {"origins": "*", "allow_headers": ["Authorization", "Content-Type"], "methods": ["GET", "POST", "OPTIONS"]}})
_write_lock = threading.RLock()
_scheduler = None


def _json_write_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _load_json(path):
    try:
        with Path(path).open("r", encoding="utf-8") as source:
            return json.load(source)
    except (OSError, json.JSONDecodeError):
        return None


def _load_price_baselines():
    stored = _load_json(BASELINES_PATH)
    return stored if isinstance(stored, dict) else {}


def _authorized():
    configured = os.getenv("AUDIT_API_TOKEN", "")
    supplied = request.headers.get("Authorization", "")
    prefix = "Bearer "
    if not configured:
        return False, (jsonify({"success": False, "error": "AUDIT_API_TOKEN is not configured."}), 503)
    if not supplied.startswith(prefix) or not hmac.compare_digest(supplied[len(prefix):], configured):
        return False, (jsonify({"success": False, "error": "Unauthorized."}), 401)
    return True, None


def _scan_path(scan_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", str(scan_id or "")):
        raise ValueError("Invalid scan_id.")
    return PARTIAL_DIR / scan_id


def _sanitize_product(record):
    if not isinstance(record, dict):
        raise ValueError("Each product must be a JSON object.")
    store_id = _positive_int(record.get("id") or record.get("store_product_id"))
    if not store_id:
        raise ValueError("Every store record requires its real positive Sooqify ID.")

    raw_fields_available = record.get("fields_available")
    fields_available = {}
    if isinstance(raw_fields_available, dict):
        for field in ("name", "price", "brand", "brand_id", "image_count", "style_code", "search_code", "local_id_tags"):
            value = raw_fields_available.get(field)
            if isinstance(value, bool):
                fields_available[field] = value

    price = None if fields_available.get("price") is False else _finite_number(record.get("price"))
    brand_id = None if fields_available.get("brand_id") is False else (_positive_int(record.get("brand_id")) or None)
    image_count = None if fields_available.get("image_count") is False else record.get("image_count")
    if image_count in (None, ""):
        image_count = None
    else:
        if isinstance(image_count, bool) or not str(image_count).isdigit():
            raise ValueError("image_count must be a non-negative integer or null when not visible in the list.")
        image_count = int(image_count)
        if image_count > 100:
            raise ValueError("image_count is outside the accepted range.")

    name_en = _clip(record.get("name_en"), 400)
    name_ar = _clip(record.get("name_ar"), 400)
    name = _clip(record.get("name"), 400)
    brand_name = _clip(record.get("brand_name"), 200)
    style_code = _clip(record.get("style_code"), 120)
    search_code = _clip(record.get("search_code"), 120)
    if fields_available.get("name") is False:
        name_en = name_ar = name = ""
    if fields_available.get("brand") is False:
        brand_name = ""
    if fields_available.get("style_code") is False:
        style_code = ""
    if fields_available.get("search_code") is False:
        search_code = ""

    tags = record.get("local_tags", record.get("tags", []))
    if not isinstance(tags, list):
        tags = [tags]
    local_tags = []
    if fields_available.get("local_id_tags") is not False:
        for tag in tags[:50]:
            for match in re.findall(r"\d+", str(tag)):
                local_id = _positive_int(match)
                if local_id and local_id not in local_tags:
                    local_tags.append(local_id)

    return {
        "id": store_id,
        "name_en": name_en,
        "name_ar": name_ar,
        "name": name,
        "brand_id": brand_id,
        "brand_name": brand_name,
        "price": price,
        "image_count": image_count,
        "style_code": style_code,
        "search_code": search_code,
        "fields_available": fields_available,
        "local_tags": local_tags,
    }


def _positive_int(value):
    try:
        number = int(str(value).strip())
        return number if number > 0 else 0
    except (ValueError, TypeError):
        return 0


def _finite_number(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
        return number if number >= 0 and number < float("inf") else None
    except (TypeError, ValueError):
        return None


def _clip(value, limit):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _run_report():
    snapshot = _load_json(SNAPSHOT_PATH)
    if not isinstance(snapshot, dict) or snapshot.get("complete") is not True:
        raise RuntimeError("No complete Sooqify scan is available yet.")
    try:
        archive = fetch_archive_snapshot()
    except Exception as exc:
        logger.warning("Read-only archive pull failed: %s", exc)
        raise ArchiveSnapshotUnavailable(
            "Shared AlphaCode archive is unavailable; no audit report was generated."
        ) from exc
    report = build_daily_report(snapshot, archive, price_baselines=_load_price_baselines())
    files = write_report_files(report, REPORTS_DIR)
    return report, files


def scheduled_report_job():
    try:
        report, files = _run_report()
        logger.info(
            "Daily audit report generated scan_id=%s stale=%s csv=%s xlsx=%s",
            report.get("scan_id"), report.get("scan_stale"),
            Path(files["csv"]).name, Path(files["xlsx"]).name,
        )
        if whatsapp_store.reports_enabled():
            attachments = [Path(files[key]).name for key in ("csv", "employees_csv", "xlsx") if files.get(key)]
            whatsapp_store.enqueue_outbox(
                "daily_audit_report",
                f"تقرير Sooqify اليومي — {report.get('generated_at')} ({report.get('timezone')}). "
                f"عدد المنتجات {report.get('snapshot_product_count', 0)}، الملاحظات {report.get('summary', {}).get('issues', 0)}، "
                f"عدد الموظفين {len(report.get('employees', []))}. المرفقات تشمل التفاصيل وملخص الموظفين.",
                attachments=attachments,
                recipient=whatsapp_store.primary_number(),
            )
    except Exception as exc:
        logger.exception("Scheduled daily audit report failed: %s", exc)


def start_scheduler():
    global _scheduler
    if os.getenv("ENABLE_SCHEDULER", "false").lower() not in {"1", "true", "yes", "on"}:
        return False
    if _scheduler and _scheduler.running:
        return False
    _scheduler = BackgroundScheduler(timezone=REPORT_TZ)
    _scheduler.add_job(
        scheduled_report_job,
        CronTrigger(hour=21, minute=0, timezone=REPORT_TZ),
        id="daily-sooqify-audit",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    logger.info("Daily report scheduler active at 21:00 %s.", APP_TIMEZONE)
    return True


def _remote_scan_start(scan_id, started_at):
    scan_dir = _scan_path(scan_id)
    with _write_lock:
        scan_dir.mkdir(parents=True, exist_ok=False)
        (scan_dir / "pages").mkdir(parents=True, exist_ok=False)
        _json_write_atomic(scan_dir / "metadata.json", {
            "scan_id": scan_id,
            "started_at": _clip(started_at, 64),
            "expected_pages": 0,
            "pages_received": [],
            "created_at": datetime.now(REPORT_TZ).isoformat(timespec="seconds"),
            "source": "railway_playwright",
        })


def _remote_scan_page(scan_id, page_number, products):
    scan_dir = _scan_path(scan_id)
    metadata = _load_json(scan_dir / "metadata.json")
    if not isinstance(metadata, dict):
        raise RuntimeError("تعذر حفظ صفحة الفحص المؤقتة.")
    try:
        clean_products = [_sanitize_product(record) for record in products]
        ids = [item["id"] for item in clean_products]
        if not clean_products or len(ids) != len(set(ids)):
            raise ValueError("صفحة القائمة فارغة أو تحتوي معرّفات متجر مكررة.")
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    received = set(metadata.get("pages_received") or [])
    if page_number != len(received) + 1:
        raise RuntimeError("تسلسل صفحات الفحص غير متصل؛ لم تُعتمد اللقطة.")
    with _write_lock:
        _json_write_atomic(scan_dir / "pages" / f"page_{page_number:05d}.json", clean_products)
        received.add(page_number)
        metadata["pages_received"] = sorted(received)
        metadata["expected_pages"] = page_number
        _json_write_atomic(scan_dir / "metadata.json", metadata)


def _remote_scan_complete(scan_id, expected_pages, captured_at):
    scan_dir = _scan_path(scan_id)
    metadata = _load_json(scan_dir / "metadata.json")
    if not isinstance(metadata, dict):
        raise RuntimeError("بيانات الفحص المؤقتة غير موجودة؛ لم تُستبدل اللقطة السابقة.")
    received = set(metadata.get("pages_received") or [])
    missing = [number for number in range(1, expected_pages + 1) if number not in received]
    if missing or expected_pages < 1:
        raise RuntimeError("الفحص غير مكتمل؛ لم تُستبدل اللقطة السابقة.")

    products = []
    for page_number in range(1, expected_pages + 1):
        page_data = _load_json(scan_dir / "pages" / f"page_{page_number:05d}.json")
        if not isinstance(page_data, list):
            raise RuntimeError("إحدى صفحات الفحص المؤقتة غير متاحة؛ لم تُستبدل اللقطة السابقة.")
        products.extend(page_data)
    ids = [item["id"] for item in products]
    if len(ids) != len(set(ids)):
        raise RuntimeError("توجد معرّفات متجر مكررة بين الصفحات؛ لم تُستبدل اللقطة السابقة.")

    snapshot = {
        "format_version": 1,
        "scan_id": scan_id,
        "started_at": metadata.get("started_at"),
        "captured_at": _clip(captured_at, 64) or datetime.now(REPORT_TZ).isoformat(timespec="seconds"),
        "complete": True,
        "expected_pages": expected_pages,
        "pages_scanned": expected_pages,
        "product_count": len(products),
        "products": products,
        "source": "railway_playwright",
    }
    with _write_lock:
        SCANS_DIR.mkdir(parents=True, exist_ok=True)
        _json_write_atomic(SCANS_DIR / f"{scan_id}.json", {key: value for key, value in snapshot.items() if key != "products"})
        # Promote the complete snapshot last so any sidecar write failure preserves the prior one.
        _json_write_atomic(SNAPSHOT_PATH, snapshot)
    return {"scan_id": scan_id, "pages_scanned": expected_pages, "product_count": len(products)}


def _notify_remote_scan(result):
    if not whatsapp_store.reports_enabled():
        return
    if result.get("success"):
        text = (
            "اكتمل فحص قائمة Sooqify على Railway. "
            f"المنتجات: {int(result.get('product_count', 0))}، "
            f"الصفحات: {int(result.get('pages_scanned', 0))}. "
            "حُفظت اللقطة المكتملة في أرشيف التدقيق."
        )
        kind = "sooqify_remote_scan_completed"
    else:
        outcome = "أُلغي الفحص" if result.get("cancelled") else "تعذر إكمال الفحص"
        text = f"{outcome} على Railway. لم تُستبدل آخر لقطة مكتملة. راجع لوحة التدقيق للتفاصيل الآمنة."
        kind = "sooqify_remote_scan_failed"
    whatsapp_store.enqueue_outbox(kind, text, recipient=whatsapp_store.primary_number())


REMOTE_BROWSER_ENABLED = os.getenv("REMOTE_BROWSER_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
REMOTE_BROWSER = RemoteBrowser(
    DATA_DIR,
    enabled=REMOTE_BROWSER_ENABLED,
    on_scan_start=_remote_scan_start,
    on_scan_page=_remote_scan_page,
    on_scan_complete=_remote_scan_complete,
    on_scan_end=_notify_remote_scan,
)
atexit.register(REMOTE_BROWSER.shutdown)


@app.before_request
def require_api_token():
    if request.path == "/healthz" or request.method == "OPTIONS":
        return None
    if request.path.startswith("/api/"):
        authorized, error = _authorized()
        if not authorized:
            return error
    return None


@app.after_request
def cors_headers(response):
    # Cross-origin extension/API calls use bearer auth; Railway's separate Playwright profile never leaves the service.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.get("/healthz")
def healthz():
    snapshot = _load_json(SNAPSHOT_PATH)
    return jsonify({
        "success": True,
        "service": "sooqify-audit",
        "timezone": APP_TIMEZONE,
        "snapshot_available": bool(isinstance(snapshot, dict) and snapshot.get("complete")),
        "archive_sync_configured": bool(os.getenv("ALPHACODE_SYNC_URL") and os.getenv("ALPHACODE_SYNC_TOKEN")),
        "api_token_configured": bool(os.getenv("AUDIT_API_TOKEN")),
        "whatsapp_enabled": whatsapp_store.reports_enabled(),
        "remote_browser_enabled": REMOTE_BROWSER_ENABLED,
    })


@app.get("/api/remote-browser/status")
def remote_browser_status():
    return jsonify({"success": True, "state": REMOTE_BROWSER.status()})


@app.post("/api/remote-browser/start")
def start_remote_browser():
    try:
        state = REMOTE_BROWSER.start()
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    return jsonify({"success": True, "state": state})


@app.post("/api/remote-browser/open-list")
def open_remote_list():
    try:
        state = REMOTE_BROWSER.open_list()
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify({"success": True, "state": state})


@app.get("/api/remote-browser/screenshot")
def remote_browser_screenshot():
    try:
        frame = REMOTE_BROWSER.screenshot()
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    response = Response(frame, mimetype="image/jpeg")
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.post("/api/remote-browser/input")
def remote_browser_input():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"success": False, "error": "Input payload must be an object."}), 400
    try:
        result = REMOTE_BROWSER.input(data)
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify(result)


@app.post("/api/remote-browser/close")
def close_remote_browser():
    try:
        state = REMOTE_BROWSER.close()
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify({"success": True, "state": state})


@app.post("/api/remote-browser/scan/start")
def start_remote_scan():
    try:
        state = REMOTE_BROWSER.begin_scan()
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify({"success": True, "state": state}), 202


@app.post("/api/remote-browser/scan/cancel")
def cancel_remote_scan():
    try:
        state = REMOTE_BROWSER.cancel_scan()
    except RemoteBrowserError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify({"success": True, "state": state})


@app.post("/api/pricing-baselines")
def save_pricing_baselines():
    """Save formula inputs received from a successful existing-backend extraction."""
    data = request.get_json(silent=True) or {}
    records = data.get("products")
    if not isinstance(records, list) or not records or len(records) > 200:
        return jsonify({"success": False, "error": "products must contain 1 to 200 records."}), 400

    current = _load_price_baselines()
    updated = dict(current)
    accepted_ids = []
    try:
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("Each baseline must be an object.")
            local_id = _positive_int(record.get("local_id"))
            original_yuan = _finite_number(record.get("original_price_yuan"))
            product_type = _clip(record.get("product_type"), 20).lower()
            if not local_id or original_yuan is None or original_yuan <= 0:
                raise ValueError("Each baseline requires a local_id and positive CNY price.")
            if product_type not in {"shoes", "watches"}:
                raise ValueError("product_type must be shoes or watches.")
            source_settings = record.get("settings") if isinstance(record.get("settings"), dict) else {}
            rate = _finite_number(source_settings.get("ExchangeRate"))
            fee_key = "WatchFlatFeeYuan" if product_type == "watches" else "AddedFeeYuan"
            fee = _finite_number(source_settings.get(fee_key))
            if rate is None or rate <= 0 or fee is None:
                raise ValueError(f"A valid ExchangeRate and {fee_key} snapshot are required.")
            baseline = {
                "local_id": local_id,
                "original_price_yuan": original_yuan,
                "product_type": product_type,
                "settings": {"ExchangeRate": rate, fee_key: fee},
                "name_en": _clip(record.get("name_en"), 400),
                "name_ar": _clip(record.get("name_ar"), 400),
                "price_sar_at_extraction": _finite_number(record.get("price_sar")),
                "captured_at": datetime.now(REPORT_TZ).isoformat(timespec="seconds"),
            }
            key = str(local_id)
            existing = updated.get(key)
            if isinstance(existing, dict):
                fields = ("original_price_yuan", "product_type", "settings")
                if any(existing.get(field) != baseline.get(field) for field in fields):
                    raise ValueError(f"Conflicting pricing baseline for local ID {local_id}; existing value was kept.")
            else:
                updated[key] = baseline
            accepted_ids.append(local_id)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400

    with _write_lock:
        _json_write_atomic(BASELINES_PATH, updated)
    return jsonify({"success": True, "saved": len(accepted_ids), "local_ids": accepted_ids})


@app.post("/api/audit/scans/start")
def start_scan():
    data = request.get_json(silent=True) or {}
    scan_id = _clip(data.get("scan_id") or uuid.uuid4().hex, 80)
    try:
        scan_dir = _scan_path(scan_id)
        expected_pages = int(data.get("expected_pages"))
        if not 1 <= expected_pages <= MAX_SCAN_PAGES:
            raise ValueError("expected_pages is outside the accepted range.")
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "error": str(exc)}), 400

    with _write_lock:
        if scan_dir.exists():
            return jsonify({"success": False, "error": "This scan_id already exists."}), 409
        (scan_dir / "pages").mkdir(parents=True, exist_ok=False)
        metadata = {
            "scan_id": scan_id,
            "started_at": _clip(data.get("started_at"), 64),
            "expected_pages": expected_pages,
            "pages_received": [],
            "created_at": datetime.now(REPORT_TZ).isoformat(timespec="seconds"),
        }
        _json_write_atomic(scan_dir / "metadata.json", metadata)
    return jsonify({"success": True, "scan_id": scan_id, "expected_pages": expected_pages})


@app.post("/api/audit/scans/<scan_id>/pages/<int:page_number>")
def upload_scan_page(scan_id, page_number):
    try:
        scan_dir = _scan_path(scan_id)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    data = request.get_json(silent=True) or {}
    products = data.get("products")
    if not isinstance(products, list) or len(products) > MAX_PRODUCTS_PER_PAGE:
        return jsonify({"success": False, "error": "products must be a list of at most 200 records."}), 400
    metadata = _load_json(scan_dir / "metadata.json")
    if not isinstance(metadata, dict):
        return jsonify({"success": False, "error": "Scan has not been started."}), 404
    if not 1 <= page_number <= int(metadata.get("expected_pages", 0)):
        return jsonify({"success": False, "error": "page_number is outside the declared scan."}), 400
    try:
        clean_products = [_sanitize_product(record) for record in products]
        ids = [item["id"] for item in clean_products]
        if len(ids) != len(set(ids)):
            raise ValueError("A page contains duplicate Sooqify IDs.")
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400

    with _write_lock:
        _json_write_atomic(scan_dir / "pages" / f"page_{page_number:05d}.json", clean_products)
        received = set(metadata.get("pages_received") or [])
        received.add(page_number)
        metadata["pages_received"] = sorted(received)
        _json_write_atomic(scan_dir / "metadata.json", metadata)
    return jsonify({"success": True, "page": page_number, "products": len(clean_products)})


@app.post("/api/audit/scans/<scan_id>/complete")
def complete_scan(scan_id):
    try:
        scan_dir = _scan_path(scan_id)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    metadata = _load_json(scan_dir / "metadata.json")
    if not isinstance(metadata, dict):
        return jsonify({"success": False, "error": "Scan has not been started."}), 404
    expected_pages = int(metadata.get("expected_pages", 0))
    pages_received = set(metadata.get("pages_received") or [])
    missing = [page for page in range(1, expected_pages + 1) if page not in pages_received]
    if missing:
        return jsonify({"success": False, "complete": False, "missing_pages": missing[:100], "missing_count": len(missing)}), 409

    products = []
    for page_number in range(1, expected_pages + 1):
        page_data = _load_json(scan_dir / "pages" / f"page_{page_number:05d}.json")
        if not isinstance(page_data, list):
            return jsonify({"success": False, "complete": False, "missing_pages": [page_number]}), 409
        products.extend(page_data)
    ids = [item["id"] for item in products]
    if len(ids) != len(set(ids)):
        return jsonify({"success": False, "complete": False, "error": "Sooqify IDs repeated across pages; scan was not promoted."}), 409

    data = request.get_json(silent=True) or {}
    captured_at = _clip(data.get("captured_at"), 64) or datetime.now(REPORT_TZ).isoformat(timespec="seconds")
    snapshot = {
        "format_version": 1,
        "scan_id": scan_id,
        "started_at": metadata.get("started_at"),
        "captured_at": captured_at,
        "complete": True,
        "expected_pages": expected_pages,
        "pages_scanned": expected_pages,
        "product_count": len(products),
        "products": products,
    }
    with _write_lock:
        SCANS_DIR.mkdir(parents=True, exist_ok=True)
        _json_write_atomic(SCANS_DIR / f"{scan_id}.json", {key: value for key, value in snapshot.items() if key != "products"})
        _json_write_atomic(SNAPSHOT_PATH, snapshot)
    return jsonify({"success": True, "complete": True, "scan_id": scan_id, "product_count": len(products)})


@app.get("/api/audit/latest")
def latest_scan():
    snapshot = _load_json(SNAPSHOT_PATH)
    if not isinstance(snapshot, dict):
        return jsonify({"success": True, "available": False, "complete": False})
    return jsonify({
        "success": True,
        "available": True,
        "complete": bool(snapshot.get("complete")),
        "scan_id": snapshot.get("scan_id"),
        "captured_at": snapshot.get("captured_at"),
        "pages_scanned": snapshot.get("pages_scanned"),
        "product_count": snapshot.get("product_count"),
    })


@app.post("/api/reports/generate")
def generate_report():
    try:
        report, files = _run_report()
        return jsonify({
            "success": True,
            "report": {key: value for key, value in report.items() if key != "details"},
            "download": {
                "csv": "/api/reports/latest.csv",
                "employees_csv": "/api/reports/latest.employees.csv",
                "xlsx": "/api/reports/latest.xlsx",
            },
            "files": {key: Path(value).name for key, value in files.items()},
        })
    except ArchiveSnapshotUnavailable as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    except RuntimeError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    except Exception as exc:
        logger.exception("Manual report generation failed: %s", exc)
        return jsonify({"success": False, "error": "Report generation failed."}), 500


def _latest_report(extension):
    pattern = "sooqify_audit_*_employees.csv" if extension == "employees.csv" else f"sooqify_audit_*.{extension}"
    candidates = sorted(REPORTS_DIR.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


@app.get("/api/reports/latest.csv")
def download_latest_csv():
    path = _latest_report("csv")
    if not path:
        return jsonify({"success": False, "error": "No report is available yet."}), 404
    return send_file(path, as_attachment=True, download_name=path.name, mimetype="text/csv; charset=utf-8")


@app.get("/api/reports/latest.employees.csv")
def download_latest_employees_csv():
    path = _latest_report("employees.csv")
    if not path:
        return jsonify({"success": False, "error": "No employee summary is available yet."}), 404
    return send_file(path, as_attachment=True, download_name=path.name, mimetype="text/csv; charset=utf-8")


@app.get("/api/reports/latest.xlsx")
def download_latest_xlsx():
    path = _latest_report("xlsx")
    if not path:
        return jsonify({"success": False, "error": "No report is available yet."}), 404
    return send_file(path, as_attachment=True, download_name=path.name, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/")
@app.get("/dashboard")
def dashboard():
    response = send_from_directory(Path(__file__).resolve().parent / "static", "dashboard.html")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' blob:; connect-src 'self'; "
        "script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


from whatsapp_api import whatsapp_bp
app.register_blueprint(whatsapp_bp)


if os.getenv("ENABLE_SCHEDULER", "false").lower() in {"1", "true", "yes", "on"}:
    start_scheduler()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")), debug=False)
