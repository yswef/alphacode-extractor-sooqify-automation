"""Authenticated Flask routes for the Railway WhatsApp worker and dashboard."""

from __future__ import annotations

import io
import os
import re
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_file

import whatsapp_commands
import whatsapp_store as store

whatsapp_bp = Blueprint("whatsapp_bp", __name__)


def _server():
    # Delayed import avoids an app <-> blueprint import cycle.
    import app
    return app


def _worker_enabled():
    return os.getenv("WHATSAPP_ENABLED", "false").lower() in {"1", "true", "yes", "on"}


@whatsapp_bp.get("/api/whatsapp/state")
def whatsapp_state():
    state = store.runtime_status()
    server = _server()
    snapshot = server._load_json(server.SNAPSHOT_PATH)
    latest_scan = None
    if isinstance(snapshot, dict) and snapshot.get("complete") is True:
        latest_scan = {
            "scan_id": snapshot.get("scan_id"),
            "captured_at": snapshot.get("captured_at"),
            "product_count": snapshot.get("product_count"),
            "pages_scanned": snapshot.get("pages_scanned"),
        }
    return jsonify({
        "success": True,
        "enabled": store.reports_enabled(),
        "state": state,
        "primary_number": store.primary_number(),
        "timezone": store.APP_TZ.key,
        "latest_scan": latest_scan,
        "queues": store.archive_queue_stats(),
        "last_archive_events": store.audit_log_tail(30),
    })


@whatsapp_bp.get("/api/whatsapp/qr.svg")
def whatsapp_qr_svg():
    if not _worker_enabled():
        return jsonify({"success": False, "error": "WhatsApp worker is disabled."}), 409
    qr_text = store.current_qr()
    if not qr_text:
        return jsonify({"success": False, "error": "No unexpired pairing QR is available."}), 404
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
        image = qrcode.make(qr_text, image_factory=SvgPathImage, box_size=8, border=4)
        output = io.BytesIO()
        image.save(output)
        response = Response(output.getvalue(), mimetype="image/svg+xml")
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        return response
    except ImportError:
        return jsonify({"success": False, "error": "QR rendering dependency is unavailable."}), 503


@whatsapp_bp.post("/api/whatsapp/worker/status")
def worker_status():
    if not _worker_enabled():
        return jsonify({"success": False, "error": "WhatsApp worker is disabled."}), 409
    data = request.get_json(silent=True) or {}
    state = str(data.get("state") or "error").lower()
    number = re.sub(r"\D", "", str(data.get("phone_number") or ""))[:20]
    if state == "connected" and (not number or number != store.primary_number()):
        result = store.update_runtime_status("number_mismatch", number, "Connected account does not match the authorized number.")
        return jsonify({"success": False, "error": "The linked number does not match WHATSAPP_PRIMARY_NUMBER.", "state": result}), 409
    result = store.update_runtime_status(state, number, data.get("message", ""))
    return jsonify({"success": True, "state": result})


@whatsapp_bp.post("/api/whatsapp/worker/pairing-qr")
def worker_pairing_qr():
    if not _worker_enabled():
        return jsonify({"success": False, "error": "WhatsApp worker is disabled."}), 409
    data = request.get_json(silent=True) or {}
    try:
        result = store.set_pairing_qr(data.get("qr"), data.get("expires_seconds", 60))
        return jsonify(result)
    except (TypeError, ValueError) as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@whatsapp_bp.post("/api/whatsapp/worker/incoming")
def worker_incoming():
    data = request.get_json(silent=True) or {}
    server = _server()
    result = whatsapp_commands.process_incoming_command(
        data,
        archive_loader=server.fetch_archive_snapshot,
        report_runner=server._run_report,
        snapshot_loader=lambda: server._load_json(server.SNAPSHOT_PATH),
    )
    return jsonify(result)


@whatsapp_bp.get("/api/whatsapp/worker/outbox/claim")
def worker_claim_outbox():
    try:
        job = store.claim_outbox(request.args.get("worker_id", ""))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True, "job": job})


@whatsapp_bp.post("/api/whatsapp/worker/outbox/<job_id>/complete")
def worker_complete_outbox(job_id):
    data = request.get_json(silent=True) or {}
    completed = store.acknowledge_outbox(
        job_id,
        str(data.get("lease_id") or ""),
        bool(data.get("success")),
        data.get("error", ""),
    )
    if not completed:
        return jsonify({"success": False, "error": "Outbox lease was not found or has expired."}), 409
    return jsonify({"success": True})


@whatsapp_bp.get("/api/whatsapp/worker/files/<filename>")
def worker_report_attachment(filename):
    if not re.fullmatch(r"sooqify_audit_\d{8}_\d{6}(?:_employees)?\.(?:csv|xlsx)", filename):
        return jsonify({"success": False, "error": "Invalid report filename."}), 400
    server = _server()
    path = (server.REPORTS_DIR / filename).resolve()
    if path.parent != Path(server.REPORTS_DIR).resolve() or not path.is_file():
        return jsonify({"success": False, "error": "Report file is unavailable."}), 404
    if path.stat().st_size > 25 * 1024 * 1024:
        return jsonify({"success": False, "error": "Report is larger than the WhatsApp attachment limit."}), 413
    mimetype = "text/csv; charset=utf-8" if path.suffix == ".csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return send_file(path, as_attachment=True, download_name=path.name, mimetype=mimetype, max_age=0)


@whatsapp_bp.post("/api/whatsapp/worker/archive-jobs/claim")
def worker_claim_archive_job():
    data = request.get_json(silent=True) or {}
    try:
        job = store.claim_archive_job(data.get("worker_id", ""))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True, "job": job})


@whatsapp_bp.get("/api/whatsapp/worker/archive-tombstones")
def worker_archive_tombstones():
    return jsonify({"success": True, "tombstones": store.active_archive_tombstones()})


@whatsapp_bp.post("/api/whatsapp/worker/archive-jobs/<job_id>/backup")
def worker_save_archive_backup(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        return jsonify({"success": False, "error": "Invalid archive job ID."}), 400
    data = request.get_json(silent=True) or {}
    try:
        backup_id = store.save_local_backup(job_id, str(data.get("lease_id") or ""), data.get("record"))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify({"success": True, "backup_id": backup_id})


@whatsapp_bp.post("/api/whatsapp/worker/archive-jobs/<job_id>/complete")
def worker_complete_archive_job(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        return jsonify({"success": False, "error": "Invalid archive job ID."}), 400
    data = request.get_json(silent=True) or {}
    result = store.finish_archive_job(
        job_id,
        str(data.get("lease_id") or ""),
        bool(data.get("success")),
        data.get("error", ""),
        bool(data.get("already_absent")),
    )
    if result is None:
        return jsonify({"success": False, "error": "Archive job lease is invalid, backup is missing, or restore has no active tombstone."}), 409
    return jsonify({"success": True, "job": result})
