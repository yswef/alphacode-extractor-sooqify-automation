"""
Arabic: اختبارات المزامنة التلقائية - أهمها أن الدورة التلقائية تعمل فعالً وتُسجَّل، وأن
        تكرار المزامنة يُقرأ من الإعدادات، وأن تشغيل الخيط مرتين لا يفتح خيطين.
        سبب وجود هذه الاختبارات: حادثة حقيقية - خيط المزامنة كان معرَّفاً وغير مُشغَّل من أي
        نقطة تشغيل، فما كان يصير أي سحب تلقائي لمنتجات الطرف الآخر إطلاقاً ("المزامنة مش شغالة").
English: Automatic sync tests - above all that the periodic cycle really runs and is recorded,
         that the interval comes from settings, and that starting the worker twice never opens
         two threads. These exist because of a real incident: the sync thread was defined but
         started from nowhere, so nothing pulled the other operator's products automatically
         ("sync isn't working").
"""
import tempfile
import os
import threading
import time
import pytest

from app.services import sync_service


@pytest.fixture(autouse=True)
def setup_temp_root_dir(monkeypatch):
    """
    Arabic: جذر المنتجات لكل اختبار (conftest.py في هذا المجلد يتولى تحويل ملفات المزامنة
            الثلاثة لمجلد مؤقت، فلا تكتب الاختبارات في إعدادات الجهاز الحقيقية).
    English: A per-test product root (this folder's conftest.py redirects the three sync files
             to a temporary directory, so tests never write the machine's real settings).
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch.setenv("ALPHACODE_ROOT_DIR", temp_dir)
        monkeypatch.delenv("ALPHACODE_SYNC_INTERVAL_SECONDS", raising=False)
        yield temp_dir


def test_default_interval_is_thirty_minutes():
    assert sync_service.sync_auto_interval_seconds() == 30 * 60


def test_interval_follows_saved_setting_and_is_clamped():
    from app.repositories.sync_config_repository import save_sync_config

    save_sync_config({"Enabled": False, "ServerUrl": "", "Token": "", "AddedByName": "", "AutoSyncMinutes": 15})
    assert sync_service.sync_auto_interval_seconds() == 15 * 60

    # Arabic: قيمة مستحيلة (2 دقيقة) تُقصّ للحد الأدنى 5 دقائق بدل تعطيل المزامنة أو إغراق السيرفر.
    # English: An impossible value (2 minutes) is clamped to the 5-minute floor instead of
    #          either disabling sync or hammering the server.
    save_sync_config({"Enabled": False, "ServerUrl": "", "Token": "", "AddedByName": "", "AutoSyncMinutes": 2})
    assert sync_service.sync_auto_interval_seconds() == 5 * 60


def test_cycle_is_recorded_even_when_sync_is_disabled():
    result = sync_service.sync_run_cycle(reason="test")
    assert result["success"] is False
    assert result["error"] == "sync_disabled"

    state = sync_service.load_sync_state()
    assert state.get("last_cycle_at")
    assert state.get("last_cycle_reason") == "test"


def test_worker_runs_a_cycle_and_stops_cleanly(monkeypatch):
    # Arabic: نُسرّع الإيقاع للاختبار فقط، مع إبقاء القيم الافتراضية للإنتاج كما هي.
    # English: Speed up the pacing for the test only; production defaults stay untouched.
    monkeypatch.setattr(sync_service, "SYNC_WORKER_STARTUP_DELAY_SECONDS", 0)
    monkeypatch.setattr(sync_service, "SYNC_WORKER_TICK_SECONDS", 0.05)

    stop_event = threading.Event()
    assert sync_service.start_sync_background_worker(stop_event=stop_event) is True
    assert sync_service.start_sync_background_worker(stop_event=stop_event) is False

    deadline = time.time() + 5
    state = {}
    while time.time() < deadline:
        state = sync_service.load_sync_state()
        if state.get("last_cycle_reason") == "auto":
            break
        time.sleep(0.05)

    assert state.get("last_cycle_reason") == "auto", "the automatic worker never ran a cycle"
    assert sync_service.sync_worker_status()["running"] is True

    stop_event.set()
    deadline = time.time() + 5
    while time.time() < deadline and sync_service.sync_worker_status()["running"]:
        time.sleep(0.05)
    assert sync_service.sync_worker_status()["running"] is False


def test_pull_counts_new_products_from_the_other_operator(monkeypatch):
    """
    Arabic: أهم رقم في الشاشة/الإشعار: كم منتج جديد وصل فعلاً وكم منها أضافه الطرف الآخر.
    English: The number the status panel and the notification rely on: how many products really
             arrived and how many were added by the other operator.
    """
    from app.repositories.sync_config_repository import save_sync_config
    from app.services import sync_service as service

    save_sync_config({"Enabled": True, "ServerUrl": "https://example.test", "Token": "t", "AddedByName": "يوسف"})

    remote_items = {
        "k1": {"id": 1, "name_en": "From teammate", "added_by": "معتز"},
        "k2": {"id": 2, "name_en": "Mine", "added_by": "يوسف"},
    }
    monkeypatch.setattr(service, "sync_call", lambda *a, **k: ({"items": remote_items, "server_time": "2026-10-02T10:00:00"}, None))
    monkeypatch.setattr(service, "_load_archive", lambda: {})
    monkeypatch.setattr(service, "_save_archive", lambda payload: None)
    monkeypatch.setattr(service, "_save_lock", threading.RLock())

    assert service.sync_pull_updates() is None
    state = service.load_sync_state()
    assert state.get("last_pull_new_count") == 2
    assert state.get("last_pull_new_from_others") == 1
    assert state.get("last_pull_new_at")


def test_repository_round_trips_auto_sync_minutes():
    from app.repositories.sync_config_repository import load_sync_config, save_sync_config

    save_sync_config({"Enabled": True, "ServerUrl": "https://example.test/", "Token": "secret", "AddedByName": "A", "AutoSyncMinutes": "45"})
    config = load_sync_config()
    assert config["AutoSyncMinutes"] == 45
    assert config["ServerUrl"] == "https://example.test"


def test_status_and_config_routes_expose_the_new_fields():
    """
    Arabic: اللوحة والإشعار يعتمدان على حقول محدَّدة بالاسم في هذين المسارين - هذا الاختبار
            يفشل فوراً لو أُعيد تسميتها أو حُذفت بدل أن تبقى الشاشة صامتة.
    English: The popup and the notification depend on specifically named fields in these two
             routes - this test fails immediately if one is renamed or dropped, instead of the
             screen silently losing it.
    """
    from app.main import create_app

    client = create_app().test_client()

    status = client.get("/api/sync/status").get_json()
    for field in (
        "enabled", "auto_worker_running", "auto_interval_minutes", "next_auto_cycle_at",
        "last_cycle_at", "last_pull_new_count", "last_pull_new_from_others",
        "last_pull_new_at", "last_pull_new_from_others_at",
    ):
        assert field in status, f"/api/sync/status lost the '{field}' field"

    config = client.get("/api/sync/config").get_json()
    assert config["AutoSyncMinutes"] == 30
    assert (config["AutoSyncMinMinutes"], config["AutoSyncMaxMinutes"]) == (5, 1440)

    saved = client.post("/api/sync/config", json={"AutoSyncMinutes": 1})
    assert saved.status_code == 200 and saved.get_json()["success"] is True
    assert client.get("/api/sync/config").get_json()["AutoSyncMinutes"] == 5  # clamped to the floor
