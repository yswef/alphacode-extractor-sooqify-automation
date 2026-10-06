import pytest

import app as server
import whatsapp_commands
import whatsapp_store as store


PRIMARY = "15551234567"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AUDIT_API_TOKEN", "test-audit-secret")
    return server.app.test_client()


@pytest.fixture
def whatsapp_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "WHATSAPP_DIR", tmp_path / "whatsapp")
    monkeypatch.setattr(store, "BACKUPS_DIR", tmp_path / "backups" / "whatsapp_deletions")
    monkeypatch.setattr(store, "OUTBOX_PATH", tmp_path / "whatsapp" / "outbox.json")
    monkeypatch.setattr(store, "ARCHIVE_JOBS_PATH", tmp_path / "whatsapp" / "archive_jobs.json")
    monkeypatch.setattr(store, "DELETE_REQUESTS_PATH", tmp_path / "whatsapp" / "delete_requests.json")
    monkeypatch.setattr(store, "TOMBSTONES_PATH", tmp_path / "whatsapp" / "archive_tombstones.json")
    monkeypatch.setattr(store, "AUDIT_LOG_PATH", tmp_path / "whatsapp" / "archive_delete_audit.jsonl")
    monkeypatch.setenv("WHATSAPP_ENABLED", "true")
    monkeypatch.setenv("WHATSAPP_PRIMARY_NUMBER", PRIMARY)
    return tmp_path


def test_delete_requires_matching_sender_code_backup_and_writes_tombstone(whatsapp_paths):
    record = {"id": 7010, "name_en": "Watch", "images": ["one.jpg"], "store_product_id": 6638}
    pending = store.create_delete_confirmation(7010, "archive-key", record, PRIMARY)

    assert store.confirm_delete_request(pending["confirm_code"], "15550001111") is None
    confirmed = store.confirm_delete_request(pending["confirm_code"], PRIMARY)
    assert confirmed and confirmed["status"] == "queued"
    assert store.active_archive_tombstones() == []

    job = store.claim_archive_job("extension-device-1")
    assert job["action"] == "delete_local_archive_record"
    assert store.finish_archive_job(job["job_id"], job["lease_id"], True) is None
    assert store.active_archive_tombstones() == []
    assert store.save_local_backup(job["job_id"], job["lease_id"], record) == pending["backup_id"]
    finished = store.finish_archive_job(job["job_id"], job["lease_id"], True)
    assert finished["status"] == "completed"
    assert store.load_backup(pending["backup_id"])["local_record"] == record
    assert store.active_archive_tombstones()[0]["local_id"] == 7010
    assert store.archive_queue_stats()["outbox_queued"] == 1
    assert "Sooqify" in store._load_list(store.OUTBOX_PATH)[0]["text"]


def test_restore_requires_active_delete_and_clears_tombstone_only_after_sync_success(whatsapp_paths):
    record = {"id": 6017, "name_en": "Clock", "images": []}
    pending = store.create_delete_confirmation(6017, "product-key", record, PRIMARY)
    store.confirm_delete_request(pending["confirm_code"], PRIMARY)
    delete_job = store.claim_archive_job("extension-device-1")
    store.save_local_backup(delete_job["job_id"], delete_job["lease_id"], record)
    store.finish_archive_job(delete_job["job_id"], delete_job["lease_id"], True)

    restore = store.enqueue_restore(pending["backup_id"].upper(), PRIMARY)
    assert restore and restore["action"] == "restore_local_archive_record"
    restore_job = store.claim_archive_job("extension-device-1")
    assert restore_job["job_id"] == restore["job_id"]
    assert store.active_archive_tombstones()

    completed = store.finish_archive_job(restore_job["job_id"], restore_job["lease_id"], True)
    assert completed["status"] == "completed"
    assert store.active_archive_tombstones() == []
    events = store.audit_log_tail()
    assert any(item["event"] == "restore_local_archive_record_completed" for item in events)


def test_confirmation_expires_and_cancel_is_user_scoped(whatsapp_paths):
    pending = store.create_delete_confirmation(12, "key", {"id": 12}, PRIMARY, ttl_minutes=2)
    assert store.cancel_delete_request(pending["confirm_code"], "15550001111") is False
    assert store.cancel_delete_request(pending["confirm_code"], PRIMARY) is True
    assert store.confirm_delete_request(pending["confirm_code"], PRIMARY) is None


def test_whatsapp_commands_authorize_one_number_and_require_preview_then_confirmation(whatsapp_paths, monkeypatch):
    archive = {"key-1": {"id": 6017, "name_en": "Example watch", "brand_name": "Example", "store_product_id": 6638}}
    monkeypatch.setattr(server, "fetch_archive_snapshot", lambda: archive)
    monkeypatch.setattr(server, "_run_report", lambda: (_ for _ in ()).throw(AssertionError("report must not run")))

    denied = whatsapp_commands.process_incoming_command(
        {"sender_number": "15550001111", "text": "DELETE 6017"},
        archive_loader=lambda: archive,
        report_runner=server._run_report,
        snapshot_loader=lambda: None,
    )
    assert denied == {"authorized": False}
    assert not store._load_list(store.ARCHIVE_JOBS_PATH)

    preview = whatsapp_commands.process_incoming_command(
        {"sender_number": PRIMARY, "text": "DELETE 6017"},
        archive_loader=lambda: archive,
        report_runner=server._run_report,
        snapshot_loader=lambda: None,
    )
    assert "لا تغيير حدث بعد" in preview["reply"]
    assert "DELETE 6017" not in preview["reply"]
    code = preview["reply"].split("CONFIRM DELETE ", 1)[1].splitlines()[0]
    assert len(code) == 8

    confirmed = whatsapp_commands.process_incoming_command(
        {"sender_number": PRIMARY, "text": f"CONFIRM DELETE {code}"},
        archive_loader=lambda: archive,
        report_runner=server._run_report,
        snapshot_loader=lambda: None,
    )
    assert "لا يوجد أي حذف" in confirmed["reply"]
    assert store._load_list(store.ARCHIVE_JOBS_PATH)[0]["local_id"] == 6017


def test_delete_command_refuses_ambiguous_or_missing_shared_local_id(whatsapp_paths):
    command = lambda archive: whatsapp_commands.process_incoming_command(
        {"sender_number": PRIMARY, "text": "DELETE 9"},
        archive_loader=lambda: archive,
        report_runner=lambda: None,
        snapshot_loader=lambda: None,
    )
    assert "لم أجد سجلاً واحداً مؤكداً" in command({"a": {"id": 9}, "b": {"id": 9}})["reply"]
    assert "لم أجد سجلاً واحداً مؤكداً" in command({"a": {"id": 10}})["reply"]
    assert store._load_list(store.ARCHIVE_JOBS_PATH) == []


def test_manual_report_command_queues_employee_csv_and_xlsx(whatsapp_paths):
    files = {
        "csv": "/reports/sooqify_audit_20261003_210000.csv",
        "employees_csv": "/reports/sooqify_audit_20261003_210000_employees.csv",
        "xlsx": "/reports/sooqify_audit_20261003_210000.xlsx",
    }
    report = {"generated_at": "2026-10-03T21:00:00+03:00", "timezone": "Asia/Aden", "snapshot_product_count": 2, "summary": {"issues": 1}, "employees": [{"employee": "A"}]}
    response = whatsapp_commands.process_incoming_command(
        {"sender_number": PRIMARY, "text": "REPORT"},
        archive_loader=lambda: {},
        report_runner=lambda: (report, files),
        snapshot_loader=lambda: None,
    )
    assert "طابور الإرسال" in response["reply"]
    queued = store._load_list(store.OUTBOX_PATH)[0]
    assert queued["attachments"] == [
        "sooqify_audit_20261003_210000.csv",
        "sooqify_audit_20261003_210000_employees.csv",
        "sooqify_audit_20261003_210000.xlsx",
    ]


def test_api_whatsapp_routes_are_token_protected(client, whatsapp_paths):
    assert client.get("/api/whatsapp/state").status_code == 401
    status = client.get("/api/whatsapp/state", headers={"Authorization": "Bearer test-audit-secret"})
    assert status.status_code == 200
    assert status.get_json()["enabled"] is True
    assert "primary_number" in status.get_json()


def test_dashboard_and_pairing_qr_are_ephemeral_and_authenticated(client, whatsapp_paths):
    page = client.get("/dashboard")
    assert page.status_code == 200
    assert b"Sooqify Audit" in page.data
    assert page.headers["Content-Security-Policy"].find("frame-ancestors 'none'") >= 0

    assert client.get("/api/whatsapp/qr.svg").status_code == 401
    store.set_pairing_qr("temporary-pairing-payload", expires_seconds=55)
    response = client.get("/api/whatsapp/qr.svg", headers={"Authorization": "Bearer test-audit-secret"})
    assert response.status_code == 200
    assert response.mimetype == "image/svg+xml"
    assert b"<svg" in response.data
    status = client.get("/api/whatsapp/state", headers={"Authorization": "Bearer test-audit-secret"}).get_json()
    assert status["state"]["qr_available"] is True
    assert "qr" not in status["state"]


def test_scheduled_report_queues_detail_employee_and_xlsx_files(whatsapp_paths, monkeypatch):
    report = {
        "scan_id": "scan-1", "scan_stale": False, "generated_at": "2026-10-03T21:00:00+03:00",
        "timezone": "Asia/Aden", "snapshot_product_count": 4,
        "summary": {"issues": 1}, "employees": [{"employee": "A"}],
    }
    files = {
        "csv": "/reports/sooqify_audit_20261003_210000.csv",
        "employees_csv": "/reports/sooqify_audit_20261003_210000_employees.csv",
        "xlsx": "/reports/sooqify_audit_20261003_210000.xlsx",
    }
    monkeypatch.setattr(server, "_run_report", lambda: (report, files))
    server.scheduled_report_job()
    outbox = store._load_list(store.OUTBOX_PATH)
    assert len(outbox) == 1
    assert len(outbox[0]["attachments"]) == 3
    assert outbox[0]["recipient"] == PRIMARY
