"""
Arabic: اختبارات ميزة الأدمن «نسخة احتياطية كاملة ← مسح بيانات السيرفر ← إيقاف المزامنة نهائياً».

        أهم ما تحميه هذه الاختبارات، وكلها أخطاء حقيقية محتملة بلا تغطية:
          - لا يُمسح شيء ولا يُقفل الجهاز إن لم تُكتب النسخة الاحتياطية بنجاح.
          - لا يُمسح شيء إن كان السيرفر غير قابل للوصول أو رفض أمر المسح (حتى لا يضيع الوصول
            بلا مسح فعلي، وهو أسوأ من عدم المسح).
          - بعد القفل لا يخرج أي نداء شبكة إطلاقاً، حتى لو بقيت قيمة Token قديمة على الجهاز.
          - فتح القفل يحتاج تأكيداً صريحاً (ConfirmUnlock) مع رابط وكود ينجح عليهما فحص فعلي.
          - الدخول المحلي بعد القفل للأدمن فقط، ومحمي برمز الحماية المحلي إن ضُبط.

English: Tests for the admin feature "full backup -> erase the server data -> stop sync for good".

         What they protect (each is a real failure mode with no other coverage):
           - Nothing is erased and nothing is locked unless the backup was written successfully.
           - Nothing is erased when the server is unreachable or refuses the erase (losing access
             without a real erase is worse than not erasing).
           - After the lock no network call leaves at all, even if an old token still sits on the
             machine.
           - Releasing the lock requires an explicit confirmation (ConfirmUnlock) with a URL and
             token that pass a real check.
           - After the lock the local login is admin-only, behind the local guard when one was set.
"""
import json
import os
import time

import pytest

from app.core.runtime import paths_state
from app.repositories import sync_lock_repository
from app.services import emergency_service, sync_service


@pytest.fixture(autouse=True)
def isolate_emergency_files(tmp_path, monkeypatch):
    """
    Arabic: كل ملفات الميزة (القفل، حالة إعادة الرفع، مجلد النسخ) في مجلد مؤقت لكل اختبار —
            فلا تُكتب نسخة احتياطية حقيقية ولا قفل حقيقي على جهاز المطوّر أبداً.
    English: Every file of this feature (the lock, the re-upload state, the backup folder) goes to
             a per-test temporary folder - a real backup or a real lock is never written to the
             developer's machine.
    """
    monkeypatch.setattr(sync_lock_repository, "SYNC_LOCK_PATH", str(tmp_path / "sync_lock.json"))
    monkeypatch.setattr(sync_lock_repository, "RESTORE_STATE_PATH", str(tmp_path / "restore_state.json"))
    monkeypatch.setattr(emergency_service, "emergency_backup_dir", lambda: str(tmp_path / "backups"))
    yield tmp_path


def _enable_sync(url="https://sync.example/alphacode_storage", token="secret-token"):
    """Arabic: تجهيز إعدادات مزامنة مفعّلة كما على جهاز مستخدم حقيقي. English: Prepare enabled sync settings as on a real user machine."""
    sync_service.save_sync_config({
        "Enabled": True, "ServerUrl": url, "Token": token, "AddedByName": "يوسف",
    })
    return sync_service.load_sync_config()


def _write_local_archive(tmp_path, products):
    """Arabic: كتابة أرشيف جهاز حقيقي في مسار مؤقت وربطه بالحالة وقت التشغيل. English: Write a real machine archive to a temp path and bind it in the runtime state."""
    archive_path = tmp_path / "archive_db.json"
    archive_path.write_text(json.dumps(products, ensure_ascii=False), encoding="utf-8")
    paths_state.ARCHIVE_PATH = str(archive_path)
    return str(archive_path)


def _read_backup(path):
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


# ---------------------------------------------------------------------------
# Arabic: النسخة الاحتياطية.
# English: The backup.
# ---------------------------------------------------------------------------

def test_backup_holds_the_local_archive_and_the_whole_server_snapshot(tmp_path, monkeypatch):
    _enable_sync()
    _write_local_archive(tmp_path, {"k-local": {"id": 7, "name_en": "Local product"}})
    server_items = {"k1": {"id": 1, "name_en": "From teammate"}, "k2": {"id": 2, "name_en": "Mine"}}

    def fake_sync_http(server_url, token, action, payload=None, method="POST"):
        assert server_url == "https://sync.example/alphacode_storage"
        assert token == "secret-token"
        if action == "pull":
            assert payload == {"since": ""}, "the backup must pull everything, not an incremental slice"
            return {"items": server_items, "server_time": "2026-10-06T10:00:00"}, None
        if action == "brands":
            return {"brands": [{"id": 1, "name": "Nike"}]}, None
        raise AssertionError(f"unexpected action during backup: {action}")

    monkeypatch.setattr(sync_service, "sync_http_call", fake_sync_http)
    backup = emergency_service.create_emergency_backup(note="test", actor="يوسف")

    assert backup["local_products"] == 1
    assert backup["server_products"] == 2
    assert backup["server_brands"] == 1
    assert backup["server_reachable"] is True
    assert os.path.exists(backup["path"])

    payload = _read_backup(backup["path"])
    assert payload["format"] == emergency_service.BACKUP_FORMAT
    assert payload["local"]["archive"]["k-local"]["id"] == 7
    assert set(payload["server"]["items"].keys()) == {"k1", "k2"}
    assert payload["server"]["brands"] == [{"id": 1, "name": "Nike"}]
    # Arabic: المفتاح السري لا يُكتب في ملف يتنقل بين الأجهزة أبداً.
    # English: The secret token never lands in a file that travels between machines.
    assert "secret-token" not in json.dumps(payload, ensure_ascii=False)
    assert payload["sync_token_included"] is False
    # Arabic: الأعضاء لا يمكن قراءتهم من sync.php، والملف يقول ذلك صراحةً بلا ادّعاء كاذب.
    # English: Members cannot be read from sync.php, and the file says so rather than pretending.
    assert payload["server"]["members_backed_up"] is False
    assert payload["server"]["members_note"]


def test_backup_still_succeeds_with_local_data_when_no_server_is_configured(tmp_path):
    _write_local_archive(tmp_path, {"k": {"id": 1}})
    backup = emergency_service.create_emergency_backup()
    assert backup["server_reachable"] is False
    assert "لا يوجد رابط سيرفر" in backup["server_error"]
    assert os.path.exists(backup["path"])


def test_backup_reads_the_server_even_when_the_local_toggle_is_off(tmp_path, monkeypatch):
    """
    Arabic: من عطّل المزامنة محلياً ما زال يقدر يأخذ نسخة كاملة من السيرفر - التفعيل خيار في
            اللوحة لا قدرة على السيرفر (حالة المشغّل الحقيقي: فقدان الوصول للاستضافة).
    English: Someone who turned sync off locally can still take a full backup from the server -
             the toggle is a UI preference, not a server capability (the operator's real case:
             losing hosting access).
    """
    _write_local_archive(tmp_path, {})
    sync_service.save_sync_config({
        "Enabled": False, "ServerUrl": "https://sync.example/alphacode_storage",
        "Token": "secret-token", "AddedByName": "يوسف",
    })
    monkeypatch.setattr(
        sync_service, "sync_http_call",
        lambda url, token, action, payload=None, method="POST": (
            {"items": {"k1": {"id": 1}}}, None) if action == "pull" else ({"brands": []}, None),
    )
    backup = emergency_service.create_emergency_backup()
    assert backup["server_reachable"] is True
    assert backup["server_products"] == 1


# ---------------------------------------------------------------------------
# Arabic: التنفيذ - الترتيب والتأكيدات.
# English: The run - order and confirmations.
# ---------------------------------------------------------------------------

def test_shutdown_requires_the_exact_phrase(tmp_path):
    _enable_sync()
    _write_local_archive(tmp_path, {})
    result = emergency_service.run_emergency_shutdown(confirm="delete-server")
    assert result["success"] is False
    assert emergency_service.EMERGENCY_CONFIRM_PHRASE in result["error"]
    assert sync_lock_repository.is_sync_locked() is False
    assert sync_service.load_sync_config()["ServerUrl"] == "https://sync.example/alphacode_storage"


def test_shutdown_aborts_when_the_server_is_unreachable(tmp_path, monkeypatch):
    _enable_sync()
    _write_local_archive(tmp_path, {})
    monkeypatch.setattr(sync_service, "sync_http_call", lambda *a, **k: (None, "connection refused"))

    result = emergency_service.run_emergency_shutdown(confirm=emergency_service.EMERGENCY_CONFIRM_PHRASE)

    assert result["success"] is False
    assert "غير قابل للوصول" in result["error"]
    # Arabic: لا قفل ولا تفريغ لإعدادات: الجهاز يبقى كما هو حتى تُحل مشكلة الوصول.
    # English: No lock and no cleared settings: the machine stays as it was until access is fixed.
    assert sync_lock_repository.is_sync_locked() is False
    assert sync_service.load_sync_config()["Token"] == "secret-token"


def test_shutdown_aborts_when_the_server_refuses_the_erase(tmp_path, monkeypatch):
    _enable_sync()
    _write_local_archive(tmp_path, {})

    def fake_sync_http(server_url, token, action, payload=None, method="POST"):
        if action == "pull":
            return {"items": {"k1": {"id": 1}}}, None
        if action == "brands":
            return {"brands": [{"id": 1, "name": "Nike"}]}, None
        if action == "erase":
            return None, "Unknown action"
        raise AssertionError(f"unexpected action: {action}")

    monkeypatch.setattr(sync_service, "sync_http_call", fake_sync_http)
    result = emergency_service.run_emergency_shutdown(
        confirm=emergency_service.EMERGENCY_CONFIRM_PHRASE, erase_server=True,
    )

    assert result["success"] is False
    assert "action=erase" in result["error"]
    assert sync_lock_repository.is_sync_locked() is False
    assert sync_service.load_sync_config()["ServerUrl"] == "https://sync.example/alphacode_storage"
    # Arabic: النسخة الاحتياطية تبقى على القرص كدليل ومصدر استعادة.
    # English: The backup stays on disk as evidence and as the restore source.
    assert os.path.exists(result["backup"]["path"])


def test_shutdown_erases_then_locks_and_clears_credentials(tmp_path, monkeypatch):
    _enable_sync()
    _write_local_archive(tmp_path, {"k-local": {"id": 9}})
    calls = {}

    def fake_sync_http(server_url, token, action, payload=None, method="POST"):
        calls[action] = payload
        if action == "pull":
            return {"items": {"k1": {"id": 1}}}, None
        if action == "brands":
            return {"brands": []}, None
        if action == "erase":
            return {
                "success": True,
                "deleted": {"products": 3, "members": 4, "brands": 2},
                "total_deleted": 9,
                "shutdown_lock": True,
            }, None
        raise AssertionError(f"unexpected action: {action}")

    monkeypatch.setattr(sync_service, "sync_http_call", fake_sync_http)
    result = emergency_service.run_emergency_shutdown(
        confirm=emergency_service.EMERGENCY_CONFIRM_PHRASE,
        erase_server=True,
        actor="يوسف",
        local_guard_password="guard-123",
    )

    assert result["success"] is True
    assert calls["erase"] == {"confirm": "ERASE"}
    assert [step["step"] for step in result["steps"]] == ["backup", "server_erase", "local_lock"]

    config = sync_service.load_sync_config()
    assert config["Enabled"] is False
    assert config["ServerUrl"] == ""
    assert config["Token"] == ""

    lock = sync_lock_repository.load_sync_lock()
    assert lock["Locked"] is True
    assert lock["BackupFile"] == os.path.basename(result["backup"]["path"])
    assert lock["LocalGuardHash"], "the optional local guard was requested but never stored"

    # Arabic: الطابور المعلّق يُفرَّغ عند القفل حتى لا يعيد الخيط الخلفي المحاولة كل 5 دقائق.
    # English: The pending queue is emptied by the lock so the worker cannot retry every 5 minutes.
    assert sync_service.load_sync_queue() == []


def test_shutdown_without_erasing_the_server_still_locks_this_machine(tmp_path, monkeypatch):
    _enable_sync()
    _write_local_archive(tmp_path, {})
    seen = []

    def fake_sync_http(server_url, token, action, payload=None, method="POST"):
        seen.append(action)
        if action == "pull":
            return {"items": {}}, None
        if action == "brands":
            return {"brands": []}, None
        raise AssertionError("erase must not be called when the box is unchecked")

    monkeypatch.setattr(sync_service, "sync_http_call", fake_sync_http)
    result = emergency_service.run_emergency_shutdown(
        confirm=emergency_service.EMERGENCY_CONFIRM_PHRASE, erase_server=False,
    )
    assert result["success"] is True
    assert "erase" not in seen
    assert sync_lock_repository.is_sync_locked() is True


# ---------------------------------------------------------------------------
# Arabic: القفل يمنع أي نداء شبكة فعلاً.
# English: The lock really blocks every network call.
# ---------------------------------------------------------------------------

def test_locked_machine_never_reaches_the_network_even_with_stale_credentials(monkeypatch):
    _enable_sync()
    emergency_service.lock_local_sync(backup_file="b.json", server_url="https://old.example")
    # Arabic: نحاكي جهازاً قديماً ما زال يحمل الرابط والكود: القفل نفسه يجب أن يمنع الخروج.
    # English: Simulate an old machine still holding the URL and token: the lock itself must stop it.
    sync_service.save_sync_config({
        "Enabled": True, "ServerUrl": "https://old.example", "Token": "stale-token", "AddedByName": "A",
    })

    def explode(*args, **kwargs):
        raise AssertionError("a network call left the machine while sync was locked")

    monkeypatch.setattr(sync_service, "sync_http_call", explode)

    assert sync_service.sync_call("pull", {"since": ""}) == (None, "sync_locked")
    assert sync_service.sync_pull_updates() is None
    assert sync_service.sync_reconcile_full() == {"success": False, "error": "sync_locked"}
    assert sync_service.sync_run_cycle(reason="test")["error"] == "sync_locked"
    # Arabic: لا شيء يدخل طابور إعادة المحاولة في الوضع المقفول.
    # English: Nothing enters the retry queue in the locked state.
    sync_service.sync_push_product("k1", {"id": 1})
    assert sync_service.load_sync_queue() == []
    # Arabic: الحجز المركزي يرجع "لا سيرفر" بلا تحذير، فيعمل الترقيم المحلي كما في وضع التعطيل.
    # English: Central reservation reports "no server" silently, so local numbering takes over.
    assert sync_service.sync_reserve_id() is None
    assert sync_service.sync_reserve_key("k1", "A") == (True, None, None)


# ---------------------------------------------------------------------------
# Arabic: مسارات الـAPI.
# English: The API routes.
# ---------------------------------------------------------------------------

def test_routes_refuse_sync_work_and_silent_reenable_while_locked(tmp_path):
    from app.main import create_app

    _enable_sync()
    emergency_service.lock_local_sync(backup_file="b.json")
    client = create_app().test_client()

    status = client.get("/api/sync/status").get_json()
    assert status["locked"] is True
    assert status["lock"]["Locked"] is True

    now_response = client.post("/api/sync/now")
    assert now_response.status_code == 409
    assert now_response.get_json()["locked"] is True

    reconcile = client.post("/api/sync/reconcile")
    assert reconcile.status_code == 409

    silent = client.post("/api/sync/config", json={"Enabled": True, "ServerUrl": "https://new.example", "Token": "t"})
    assert silent.status_code == 409
    assert silent.get_json()["locked"] is True
    assert sync_lock_repository.is_sync_locked() is True

    emergency = client.get("/api/sync/emergency/status").get_json()
    assert emergency["success"] is True
    assert emergency["locked"] is True
    assert emergency["confirm_phrase"] == emergency_service.EMERGENCY_CONFIRM_PHRASE


def test_locked_login_is_admin_only_and_respects_the_local_guard():
    from app.main import create_app

    emergency_service.lock_local_sync(backup_file="b.json", guard=emergency_service.set_local_guard("guard-123"))
    client = create_app().test_client()

    member = client.post("/api/sync/login", json={"name": "معتز", "password": "x"})
    assert member.status_code == 403
    assert member.get_json()["locked"] is True

    wrong_guard = client.post("/api/sync/login", json={"name": "admin", "password": "admin"})
    assert wrong_guard.status_code == 401

    admin = client.post("/api/sync/login", json={"name": "admin", "password": "guard-123"})
    assert admin.status_code == 200
    assert admin.get_json()["member"]["role"] == "admin"


def test_unlock_needs_confirmation_and_a_real_connection(monkeypatch):
    from app.main import create_app

    emergency_service.lock_local_sync(backup_file="b.json")
    client = create_app().test_client()

    monkeypatch.setattr(sync_service, "sync_http_call", lambda *a, **k: (None, "no such host"))
    refused = client.post("/api/sync/config", json={
        "Enabled": True, "ServerUrl": "https://new.example", "Token": "t", "ConfirmUnlock": True,
    })
    assert refused.status_code == 400
    assert sync_lock_repository.is_sync_locked() is True

    monkeypatch.setattr(sync_service, "sync_http_call", lambda *a, **k: ({"success": True, "brands": []}, None))
    accepted = client.post("/api/sync/config", json={
        "Enabled": True, "ServerUrl": "https://new.example/", "Token": "new-token", "ConfirmUnlock": True,
    })
    assert accepted.status_code == 200
    assert sync_lock_repository.is_sync_locked() is False
    config = sync_service.load_sync_config()
    assert config["Enabled"] is True
    assert config["ServerUrl"] == "https://new.example"
    assert config["Token"] == "new-token"


def test_http_flow_backup_shutdown_then_restore_status(tmp_path, monkeypatch):
    """
    Arabic: نفس مسار الواجهة بالضبط: نسخة احتياطية من اللوحة ← تنفيذ المسح والقفل ← بقاء النسخة
            معروضة لإعادة الرفع لاحقاً. هذا الاختبار يحمي أسماء الحقول التي ترسلها الإضافة.
    English: The exact popup path: a backup from the panel -> the erase and lock -> the backup
             stays listed for the later re-upload. It protects the field names the extension sends.
    """
    from app.main import create_app

    _enable_sync()
    _write_local_archive(tmp_path, {"k-local": {"id": 4}})

    def fake_sync_http(server_url, token, action, payload=None, method="POST"):
        if action == "pull":
            return {"items": {"k1": {"id": 1}}}, None
        if action == "brands":
            return {"brands": [{"id": 1, "name": "Nike"}]}, None
        if action == "erase":
            return {"success": True, "deleted": {"products": 1, "members": 2}, "total_deleted": 3}, None
        raise AssertionError(f"unexpected action: {action}")

    monkeypatch.setattr(sync_service, "sync_http_call", fake_sync_http)
    client = create_app().test_client()

    backup = client.post("/api/sync/emergency/backup", json={"Actor": "يوسف"})
    assert backup.status_code == 200
    backup_data = backup.get_json()["backup"]
    assert client.get(backup_data["download_url"]).status_code == 200

    confirmed = client.post("/api/sync/emergency/shutdown", json={
        "Confirm": emergency_service.EMERGENCY_CONFIRM_PHRASE,
        "EraseServer": True,
        "LocalGuardPassword": "guard-123",
        "Actor": "يوسف",
    })
    assert confirmed.status_code == 200
    body = confirmed.get_json()
    assert body["success"] is True
    assert body["server_erase"]["total_deleted"] == 3

    status = client.get("/api/sync/emergency/status").get_json()
    assert status["locked"] is True
    assert status["guard_set"] is True
    listed = [item["name"] for item in status["backups"]]
    # Arabic: نسختان: التي أخذها الأدمن يدوياً، ونسخة الإيقاف الإلزامية - ولا تمسح إحداهما الأخرى
    #         حتى لو وقعتا في نفس الثانية (الطابع الزمني بالثواني فقط).
    # English: Two backups: the admin's manual one and the shutdown's mandatory one - and neither
    #          overwrites the other even when they land in the same second (second-accurate stamp).
    assert os.path.basename(backup_data["path"]) in listed
    assert body["backup"]["name"] in listed
    assert len(listed) == len(set(listed)) == 2

    restore_status = client.get("/api/sync/emergency/restore/status").get_json()
    assert restore_status["success"] is True
    assert restore_status["running"] is False

    # Arabic: طلب مسح بلا العبارة يُرفض ولا يغيّر شيئاً.
    # English: A shutdown request without the phrase is refused and changes nothing.
    refused = client.post("/api/sync/emergency/shutdown", json={"Confirm": "nope"})
    assert refused.status_code == 400
    assert refused.get_json()["success"] is False


def test_backup_download_route_serves_only_real_backup_names(tmp_path):
    from app.main import create_app

    _write_local_archive(tmp_path, {})
    emergency_service.create_emergency_backup()
    name = emergency_service.list_emergency_backups()[0]["name"]
    client = create_app().test_client()

    served = client.get(f"/api/sync/emergency/backup/{name}")
    assert served.status_code == 200
    assert served.headers["Content-Disposition"].startswith("attachment")

    # Arabic: أي اسم غير ملف نسخة احتياطية (‎.txt أو محاولة خروج من المجلد) يُرفض.
    # English: Any name that is not a backup file (.txt, or an escape attempt) is refused.
    assert client.get("/api/sync/emergency/backup/notes.txt").status_code == 404
    assert client.get("/api/sync/emergency/backup/..%2Fconfig%2Fsync_config.json").status_code == 404


# ---------------------------------------------------------------------------
# Arabic: إعادة الرفع.
# English: The re-upload.
# ---------------------------------------------------------------------------

def _write_backup_file(tmp_path, items, brands):
    path = os.path.join(str(tmp_path / "backups"), "alphacode_emergency_backup_20261006_120000.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump({
            "format": emergency_service.BACKUP_FORMAT,
            "version": emergency_service.BACKUP_VERSION,
            "generated_at": "2026-10-06T12:00:00",
            "local": {"archive": {}, "product_count": 0},
            "server": {"url": "https://old.example", "reachable": True, "items": items, "brands": brands},
        }, file, ensure_ascii=False)
    return path


def _wait_for_restore(timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = sync_lock_repository.load_restore_state()
        if not state.get("running") and state.get("finished_at"):
            return state
        time.sleep(0.05)
    raise AssertionError("the restore job never finished")


def test_restore_pushes_brands_then_products_then_fixes_the_id_counter(tmp_path, monkeypatch):
    monkeypatch.setattr(emergency_service, "RESTORE_PACING_SECONDS", 0)
    _enable_sync()
    emergency_service.lock_local_sync(backup_file="b.json", guard=emergency_service.set_local_guard("guard-123"))
    _write_backup_file(
        tmp_path,
        items={
            "k-completed-1": {"id": 12, "name_en": "A", "brand_name": "Nike"},
            "k-completed-2": {"id": 30, "name_en": "B", "brand_name": "Nike"},
            "k-reserved": {"status": "reserved", "added_by": "معتز"},
        },
        brands=[{"id": 1, "name": "Nike"}],
    )
    calls = []

    def fake_http(server_url, token, action, payload=None, method="POST"):
        calls.append((action, payload))
        if action == "brands":
            return {"success": True, "brands": [{"id": 1, "name": "Nike"}]}, None
        if action == "brands/sync":
            return {"success": True, "brand_count": 1}, None
        if action == "push":
            return {"success": True}, None
        if action == "bump_sequence":
            return {"success": True, "next_id": 31}, None
        raise AssertionError(f"unexpected action: {action}")

    monkeypatch.setattr(sync_service, "sync_http_call", fake_http)
    started = emergency_service.start_restore_job(
        backup_file="alphacode_emergency_backup_20261006_120000.json",
        server_url="https://new.example/alphacode_storage",
        token="new-token",
        confirm=emergency_service.RESTORE_CONFIRM_PHRASE,
        guard_password="guard-123",
    )
    assert started["success"] is True

    state = _wait_for_restore()
    actions = [action for action, _ in calls]
    assert actions[0] == "brands", "connectivity must be checked with the new credentials first"
    assert "brands/sync" in actions
    assert actions.index("brands/sync") < actions.index("push"), "brands must exist before products are pushed"
    assert actions.count("push") == 2, "the reserved placeholder must be skipped"
    assert state["pushed"] == 2
    assert state["skipped"] == 1
    assert state["brands_restored"] == 1
    assert state["failed"] == 0
    assert state["sequence_bumped_to"] == 30

    # Arabic: القفل يُفتح والإعدادات الجديدة تُحفظ بعد نجاح الفحص فعلاً.
    # English: The lock opens and the new settings are saved only after the check really passes.
    assert sync_lock_repository.is_sync_locked() is False
    config = sync_service.load_sync_config()
    assert config["Enabled"] is True
    assert config["ServerUrl"] == "https://new.example/alphacode_storage"
    assert config["Token"] == "new-token"


def test_restore_needs_the_phrase_the_file_and_the_guard(tmp_path, monkeypatch):
    _enable_sync()
    emergency_service.lock_local_sync(backup_file="b.json", guard=emergency_service.set_local_guard("guard-123"))
    _write_backup_file(tmp_path, items={"k": {"id": 1}}, brands=[])
    monkeypatch.setattr(sync_service, "sync_http_call", lambda *a, **k: ({"success": True, "brands": []}, None))

    name = "alphacode_emergency_backup_20261006_120000.json"
    assert emergency_service.start_restore_job(name, "https://new.example", "t", confirm="restore")["success"] is False
    assert emergency_service.start_restore_job("missing.json", "https://new.example", "t", "RESTORE")["success"] is False
    no_creds = emergency_service.start_restore_job(  # noqa: E501
        name, "", "", emergency_service.RESTORE_CONFIRM_PHRASE, guard_password="guard-123",
    )
    assert no_creds["success"] is False
    bad_guard = emergency_service.start_restore_job(
        name, "https://new.example", "t", emergency_service.RESTORE_CONFIRM_PHRASE, guard_password="wrong",
    )
    assert bad_guard["success"] is False
    assert "رمز الحماية" in bad_guard["error"]
    # Arabic: ولا شيء من هذا فتح القفل (الفحص فشل قبل أي حفظ).
    # English: None of that released the lock (every attempt failed before anything was saved).
    assert sync_lock_repository.is_sync_locked() is True
