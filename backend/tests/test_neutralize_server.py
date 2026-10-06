"""
Arabic: اختبارات «تعطيل السيرفر» — الميزة التي تُخربه وتُوقفه باستخدام أوامر نسخة sync.php
        القديمة وحدها (pull, brands, brands/sync, push, reserve_id)، بلا action=erase.

        لماذا هذه الاختبارات ضرورية: العملية تُعدّل بيانات الإنتاج فعلياً ولا رجعة فيها بلا
        النسخة الاحتياطية، فكل خطأ في ترتيبها أو في حمولة الرفع يعني إما تعطيلاً ناقصاً يظنه
        المشغّل كاملاً، أو تلفاً بلا نسخة. وهذه أهم الحالات المحمية:
          - لا كتابة إطلاقاً إن فشلت النسخة الاحتياطية أو كان السيرفر غير قابل للوصول.
          - الحمولة الموحّدة تحفظ المعرّف حرفياً (وإلا رفض push الصف بـ409 duplicate) وتستبدل
            كل شيء آخر.
          - استبدال البراندات يسبق توحيد المنتجات، وإلا رُفض كل منتج ببراند غير موجود.
          - حجوزات بلا معرّف لا تُلمس.
          - حظر 403 يوقف العملية بهدوء وبقابليّة استئناف، لا انهيار.
          - العبارة NEUTRALIZE شرط، ولا تعطيل بلا اختيار خطوة واحدة على الأقل.

English: Tests for the "neutralize the server" feature - the one that sabotages and stops it using
         only the old sync.php actions (pull, brands, brands/sync, push, reserve_id), with no
         action=erase.

         Why they matter: the run really modifies production data and is irreversible without the
         backup, so any mistake in the order or in the pushed payload means either a shutdown the
         operator believes is total while it is not, or damage with no backup. Key protected cases:
           - no write at all when the backup fails or the server is unreachable,
           - the unified payload keeps the id verbatim (otherwise push answers 409 duplicate) and
             replaces everything else,
           - replacing brands precedes unifying products, or every product is refused for an
             unknown brand,
           - reservations without an id are never touched,
           - a 403 block stops the job quietly and resumably instead of crashing,
           - NEUTRALIZE is mandatory, and at least one step must be selected.
"""
import time

import pytest

from app.repositories import sync_lock_repository
from app.repositories.sync_config_repository import save_sync_config
from app.services import emergency_service, neutralize_service, sync_service


@pytest.fixture(autouse=True)
def isolate_neutralize_state(tmp_path, monkeypatch):
    """Arabic: كل ملفات الميزة (القفل، حالة الاستعادة، حالة التعطيل، مجلد النسخ) في مجلد مؤقت لكل اختبار. English: Every file of the feature (lock, restore state, neutralize state, backup folder) goes to a per-test temporary folder."""
    monkeypatch.setattr(sync_lock_repository, "SYNC_LOCK_PATH", str(tmp_path / "sync_lock.json"))
    monkeypatch.setattr(sync_lock_repository, "RESTORE_STATE_PATH", str(tmp_path / "restore_state.json"))
    monkeypatch.setattr(neutralize_service, "NEUTRALIZE_STATE_PATH", str(tmp_path / "neutralize_state.json"))
    monkeypatch.setattr(emergency_service, "EMERGENCY_BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.setattr(emergency_service, "emergency_backup_dir", lambda: str(tmp_path / "backups"))
    monkeypatch.setattr(neutralize_service, "NEUTRALIZE_PACING_SECONDS", 0)
    monkeypatch.setattr(neutralize_service, "NEUTRALIZE_ID_PACING_SECONDS", 0)
    yield tmp_path


def _enable_sync(url="https://old.example/alphacode_storage", token="secret-token"):
    save_sync_config({"Enabled": True, "ServerUrl": url, "Token": token, "AddedByName": "يوسف"})


def _server_with(items, brands):
    """
    Arabic: سيرفر وهمي يحاكي نسخة sync.php القديمة *بدقة*: push يرفض تغيير المعرّف (duplicate)،
            وbrands/sync يستبدل الجدول كاملاً، وباقي الأوامر كما هي. هذا أقوى من مجرد تتبّع النداءات
            لأنه يجعل الاختبار يكشف فعلاً ما سيحدث على البيانات.
    English: A fake server that mimics the old sync.php *exactly*: push refuses an id change
            (duplicate), brands/sync replaces the whole table, and the other actions behave as
            before. Stronger than plain call-tracking, because the test then shows what really
            happens to the data.
    """
    state = {"items": dict(items), "brands": [dict(brand) for brand in brands], "reserved": 0,
             "calls": [], "reject_ids": False}

    def fake(server_url, token, action, payload=None, method="POST"):
        state["calls"].append(action)
        if action == "pull":
            return {"items": dict(state["items"]), "server_time": "2026-10-06T12:00:00"}, None
        if action == "brands":
            return {"brands": [dict(brand) for brand in state["brands"]]}, None
        if action == "brands/sync":
            if (payload or {}).get("confirm_replace") is not True:
                return {"success": False, "error": "confirm_replace required"}, None
            rows = (payload or {}).get("brands") or []
            if not rows:
                return {"success": False, "error": "brands must contain between 1 and 500 rows"}, None
            previous = [dict(brand) for brand in state["brands"]]
            state["brands"] = [dict(row) for row in rows]
            return {"success": True, "brand_count": len(rows), "previous_brands": previous}, None
        if action == "push":
            key = (payload or {}).get("key")
            product = (payload or {}).get("product") or {}
            existing = state["items"].get(key)
            if existing and str(existing.get("id")) != str(product.get("id")):
                return {"success": False, "duplicate": True, "existing": existing}, 409
            brand_names = {str(brand["name"]) for brand in state["brands"]}
            if str(product.get("brand_name") or "") not in brand_names:
                return {"success": False, "error": "Brand is not in the shared store map"}, 409
            stored = dict(product)
            stored["synced_at"] = "2026-10-06T12:00:00"
            state["items"][key] = stored
            return {"success": True}, None
        if action == "reserve_id":
            state["reserved"] += 1
            return {"success": True, "id": 1000 + state["reserved"]}, None
        raise AssertionError(f"the neutralize path must never call: {action}")

    return state, fake


PRODUCTS = {
    "SKU-1": {"id": 1, "name_en": "Air Jordan 1", "style_code": "AJ1", "price": 300,
              "brand_name": "Air Jordan", "brand_id": 6, "images": ["a.jpg"], "product_type": "shoes"},
    "SKU-2": {"id": 2, "name_en": "Rolex Sub", "style_code": "RLX", "price": 900,
              "brand_name": "Rolex", "brand_id": 7, "product_type": "watches"},
    "SKU-3": {"status": "reserved", "added_by": "معتز"},
}
BRANDS = [{"id": 6, "name": "Air Jordan"}, {"id": 7, "name": "Rolex"}]


def _run(options=None, **kwargs):
    opts = {"RewriteProducts": True, "ReplaceBrands": True, "BumpIds": False, "LockLocal": False}
    if options:
        opts.update(options)
    result = neutralize_service.start_neutralize_job(
        raw_options=opts, confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE, **kwargs
    )
    assert result["success"] is True, result
    deadline = time.time() + 10
    while time.time() < deadline:
        state = neutralize_service.neutralize_status()
        if not state.get("running") and state.get("phase") in ("done", "failed"):
            return state
        time.sleep(0.02)
    raise AssertionError("the neutralize job never finished")


# ---------------------------------------------------------------------------
# Arabic: الحمايات قبل أي كتابة.
# English: The guards before any write.
# ---------------------------------------------------------------------------

def test_confirmation_phrase_is_mandatory(monkeypatch, tmp_path):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    refused = neutralize_service.start_neutralize_job({"RewriteProducts": True}, confirm="neutralize")
    assert refused["success"] is False
    assert neutralize_service.NEUTRALIZE_CONFIRM_PHRASE in refused["error"]
    assert state["calls"] == [], "nothing may reach the server without the phrase"


def test_at_least_one_step_must_be_selected(monkeypatch):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    result = neutralize_service.start_neutralize_job(
        {"RewriteProducts": False, "ReplaceBrands": False, "BumpIds": False},
        confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE,
    )
    assert result["success"] is False
    assert state["calls"] == []


def test_no_write_when_the_backup_cannot_be_written(monkeypatch, tmp_path):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    def exploding_backup(**kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(emergency_service, "create_emergency_backup", exploding_backup)
    result = neutralize_service.start_neutralize_job(
        {"RewriteProducts": True, "ReplaceBrands": True, "LockLocal": False},
        confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE,
    )
    assert result["success"] is True  # the job starts, then fails inside - see the state below
    deadline = time.time() + 5
    while time.time() < deadline and neutralize_service.neutralize_status().get("running"):
        time.sleep(0.02)
    final = neutralize_service.neutralize_status()
    assert final["phase"] == "failed"
    assert "النسخة الاحتياطية" in final["last_error"]
    # Arabic: أهم ضمان: لا نداء كتابة واحد (brands/sync أو push) بعد فشل النسخة.
    # English: The key guarantee: not one write call (brands/sync or push) after a failed backup.
    assert "brands/sync" not in state["calls"] and "push" not in state["calls"]
    assert state["items"]["SKU-2"]["name_en"] == "Rolex Sub"


def test_no_write_when_the_server_cannot_be_read(monkeypatch):
    _enable_sync()
    monkeypatch.setattr(sync_service, "sync_http_call", lambda *a, **k: (None, "connection refused"))
    result = neutralize_service.start_neutralize_job(
        {"RewriteProducts": True}, confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE
    )
    assert result["success"] is False
    assert "تعذر قراءة السيرفر" in result["error"]


# ---------------------------------------------------------------------------
# Arabic: التنفيذ الفعلي — الترتيب والنتيجة على البيانات.
# English: The actual run - order and the resulting data.
# ---------------------------------------------------------------------------

def test_full_neutralize_replaces_brands_then_unifies_every_product(monkeypatch, tmp_path):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    final = _run({"BumpIds": True, "IdSteps": 3})

    # 1) الترتيب: النسخة أولاً (‎pull من collect)، ثم استبدال البراندات، ثم المنتجات، ثم العدّاد.
    calls = state["calls"]
    assert calls.count("brands/sync") == 1
    assert calls.index("brands/sync") < calls.index("push")
    assert calls.count("push") == 2, "الصفوف بلا معرّف (حجز) لا تُلمس"
    assert calls.count("reserve_id") == 3

    # 2) البراندات الحقيقية انحذفت وبقي الوهمي وحده.
    assert [brand["name"] for brand in state["brands"]] == ["AlphaCode"]
    assert "Air Jordan" in final["previous_brands"] and "Rolex" in final["previous_brands"]

    # 3) كل منتج صار صفاً موحّداً: نفس المعرّف، بلا اسم ولا كود ولا سعر ولا صور، بالبراند الوهمي.
    for key, kept_id in (("SKU-1", 1), ("SKU-2", 2)):
        item = state["items"][key]
        assert str(item["id"]) == str(kept_id), "push يرفض تغيير المعرّف — يجب أن يبقى حرفياً"
        assert item["name_en"] == "AlphaCode"
        assert item["style_code"] == "" and item["price"] == 0 and item["images"] == []
        assert item["brand_name"] == "AlphaCode" and item["brand_id"] == 1
        assert item["neutralized_by"] == neutralize_service.NEUTRALIZE_MARKER
        assert item["product_type"] in ("shoes", "watches"), "نوع المنتج يُحفظ لئلا تتعطل مساراته"

    # 4) الحجز بلا معرّف بقي كما هو.
    assert state["items"]["SKU-3"]["status"] == "reserved"
    assert final["products_done"] == 2
    assert final["products_reserved"] == 1
    assert final["ids_bumped"] == 3
    assert final["phase"] == "done"


def test_re_adding_a_unified_product_is_now_impossible_for_members(monkeypatch):
    """
    Arabic: الهدف العملي: أي عضو يحاول إضافة منتج سبق رفعه يصطدم بحجز المفتاح (duplicate) بدل أن ينجح.
    English: The practical goal: a member re-adding a product that was ever uploaded hits the key
             reservation (duplicate) instead of succeeding.
    """
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)
    _run({})

    # Arabic: هكذا يبدو منع الإضافة من داخل الإضافة: reserve_key يرى الصف الموجود ويرد duplicate.
    existing = state["items"]["SKU-1"]
    assert existing.get("neutralized") is True
    assert existing.get("name_en") == "AlphaCode"


def test_products_keep_their_own_brands_when_brand_replacement_is_skipped(monkeypatch):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    final = _run({"ReplaceBrands": False})

    assert state["brands"] == [{"id": 6, "name": "Air Jordan"}, {"id": 7, "name": "Rolex"}]
    assert state["items"]["SKU-1"]["brand_name"] == "Air Jordan"
    assert state["items"]["SKU-2"]["brand_name"] == "Rolex"
    assert state["items"]["SKU-1"]["name_en"] == "AlphaCode"
    assert final["products_done"] == 2


def test_a_refused_brand_replacement_aborts_before_touching_products(monkeypatch):
    """
    Arabic: لو رفض السيرفر استبدال البراندات (مثلاً مفتاح أجنبي على الجدول) فلا تُلمس المنتجات:
            توحيدها ببراند وهمي غير موجود في الخريطة كان سيُرفض بـ409 لكل منتج، فالأفضل إلغاء كامل
            برسالة تشرح البديل.
    English: When the server refuses the brand replacement (e.g. a foreign key on the table) the
             products are not touched: unifying them onto a brand missing from the map would be
             refused with 409 for every product, so a full abort with an explanation is better.
    """
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)

    def refusing(server_url, token, action, payload=None, method="POST"):
        if action == "brands/sync":
            state["calls"].append(action)
            return {"success": False, "error": "the database has a foreign key to brands"}, None
        return fake(server_url, token, action, payload, method)

    monkeypatch.setattr(sync_service, "sync_http_call", refusing)
    final = _run({})

    assert final["phase"] == "failed"
    assert "استبدال البراندات" in final["last_error"]
    assert "push" not in state["calls"]
    assert state["items"]["SKU-1"]["name_en"] == "Air Jordan 1"


def test_host_block_stops_the_job_and_leaves_it_resumable(monkeypatch):
    """
    Arabic: حظر 403 من الاستضافة (المعروف في هذا المشروع) يجب أن يوقف التعطيل بهدوء مع رسالة
            «أعد التشغيل وسيكمل»، لا أن يُسقط العملية أو يكرر الطلبات فيطيل الحظر.
    English: A 403 host block (well known in this project) must stop the shutdown quietly with a
             "re-run and it resumes" message - never crash the job or keep retrying and extend the
             block.
    """
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    pushes = {"count": 0}

    def blocking(server_url, token, action, payload=None, method="POST"):
        if action == "push":
            pushes["count"] += 1
            if pushes["count"] > 1:
                return None, "sync_throttled"
        return fake(server_url, token, action, payload, method)

    monkeypatch.setattr(sync_service, "sync_http_call", blocking)
    final = _run({})

    assert final["phase"] == "done"
    assert final["products_done"] == 1
    assert final["products_skipped"] >= 1
    assert any("403" in warning for warning in final["warnings"])
    assert "في المرة القادمة" not in final["last_error"]


def test_second_run_skips_rows_that_are_already_unified(monkeypatch):
    """
    Arabic: الاستئناف: تشغيل ثانٍ بعد الأول لا يعيد رفع ما انتهى (العلامة موجودة في الصف)، فينتهي
            بسرعة بلا طلبات زائدة على الاستضافة الحساسة لحد الطلبات.
    English: Resuming: a second run after the first does not re-push what already finished (the row
             carries the marker), so it ends fast without extra requests to a rate-limited host.
    """
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)
    _run({})
    first_push_count = state["calls"].count("push")

    final = _run({})
    assert state["calls"].count("push") == first_push_count, "لا رفع مكرر للصفوف الموحّدة"
    assert final["products_already"] == 2


def test_local_lock_stops_sync_after_the_shutdown(monkeypatch):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    final = _run({"LockLocal": True}, guard_password="guard-123")

    assert final["locked"] is True
    assert sync_lock_repository.is_sync_locked() is True
    assert final["backup_file"], "النسخة الاحتياطية تُسجَّل في القفل ليعرف الأدمن مصدر الاستعادة"
    lock = sync_lock_repository.load_sync_lock()
    assert lock["BackupFile"] == final["backup_file"]
    assert lock["LocalGuardHash"], "رمز الحماية المحلي كان مطلوباً فيجب أن يُخزَّن"


def test_locked_machine_without_credentials_cannot_neutralize(monkeypatch):
    """
    Arabic: القفل يمسح رابط السيرفر والكود، فجهاز مقفول بلا بيانات اعتماد لا يستطيع تعطيل سيرفر
            أصلاً — والرسالة تقول ذلك بدل محاولة فاشلة صامتة. والفتح له مسار واحد: الاستعادة أو
            ConfirmUnlock.
    English: The lock wipes the server URL and token, so a locked machine has no credentials and
             cannot neutralize any server - and the message says so instead of a silent failed
             attempt. Releasing it has one path: the restore flow or ConfirmUnlock.
    """
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)
    emergency_service.lock_local_sync(backup_file="b.json", guard=emergency_service.set_local_guard("guard-123"))

    result = neutralize_service.start_neutralize_job(
        {"RewriteProducts": True, "ReplaceBrands": True, "LockLocal": False},
        confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE, guard_password="guard-123",
    )
    assert result["success"] is False
    assert "لا يوجد رابط سيرفر" in result["error"]
    assert state["calls"] == []


def test_guard_is_required_when_a_locked_machine_still_has_credentials(monkeypatch):
    """
    Arabic: حالة حقيقية عارضة: ملف القفل موجود لكن الإعدادات ما زالت تحمل رابطاً وكوداً (تعديل يدوي
            لـsync_config.json أو نسخة قديمة). هنا يمنع رمز الحماية المحلي أي عضو من تنفيذ تعطيل
            صامت على سيرفر ما زال حياً.
    English: A real edge case: the lock file exists while the settings still carry a URL and token (a
             manual sync_config.json edit or an older build). Here the local guard password stops a
             member from running a silent shutdown against a still-live server.
    """
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)
    emergency_service.lock_local_sync(backup_file="b.json", guard=emergency_service.set_local_guard("guard-123"))
    _enable_sync()  # Arabic: نُعيد بيانات الاعتماد يدوياً لمحاكاة تلك الحالة. English: restore credentials by hand to simulate that state.

    wrong = neutralize_service.start_neutralize_job(
        {"RewriteProducts": True, "ReplaceBrands": True, "LockLocal": False},
        confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE, guard_password="nope",
    )
    assert wrong["success"] is False
    assert "رمز الحماية" in wrong["error"]
    assert state["calls"] == []

    right = neutralize_service.start_neutralize_job(
        {"RewriteProducts": True, "ReplaceBrands": True, "LockLocal": False},
        confirm=neutralize_service.NEUTRALIZE_CONFIRM_PHRASE, guard_password="guard-123",
    )
    assert right["success"] is True


# ---------------------------------------------------------------------------
# Arabic: المعاينة.
# English: The preview.
# ---------------------------------------------------------------------------

def test_plan_is_read_only_and_shows_what_will_be_deleted(monkeypatch):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    plan = neutralize_service.neutralize_plan({"BumpIds": True, "IdSteps": 10})

    assert plan["success"] is True
    assert plan["server_reachable"] is True
    assert plan["product_count"] == 3
    assert plan["products_to_rewrite"] == 2
    assert plan["reserved_rows"] == 1
    assert plan["brands_current"] == ["Air Jordan", "Rolex"]
    assert plan["id_steps"] == 10
    assert plan["estimated_seconds"] > 0
    assert plan["warnings"], "المعاينة بلا تحذيرات تخفي المخاطر عن الأدمن"
    assert any("الأعضاء لا يمكن حذفهم" in warning for warning in plan["warnings"])
    assert set(state["calls"]) == {"pull", "brands"}, "المعاينة قراءة فقط — لا كتابة"


def test_plan_marks_an_unreachable_server_as_blocked(monkeypatch):
    _enable_sync()
    monkeypatch.setattr(sync_service, "sync_http_call", lambda *a, **k: (None, "no route to host"))
    plan = neutralize_service.neutralize_plan({})
    assert plan["success"] is True
    assert plan["server_reachable"] is False
    assert plan["blocked_reason"]


def test_id_steps_are_clamped(monkeypatch):
    opts = neutralize_service.normalize_options({"BumpIds": True, "IdSteps": 999999})
    assert opts["id_steps"] == neutralize_service.MAX_ID_STEPS
    opts = neutralize_service.normalize_options({"BumpIds": True, "IdSteps": -50})
    assert opts["id_steps"] == 0
    # Arabic: براند بمعرّف غير صالح أو اسم فاضٍ يرجع للافتراضي بدل كسر الطلب.
    # English: An invalid brand id or an empty name falls back to the default instead of breaking the request.
    opts = neutralize_service.normalize_options({"BrandId": 0, "BrandName": "  "})
    assert opts["brand_id"] == neutralize_service.DEFAULT_BRAND_ID
    assert opts["brand_name"] == neutralize_service.DEFAULT_BRAND_NAME


def test_placeholder_can_be_unified_by_the_admin(monkeypatch):
    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)

    _run({
        "Placeholder": {"name_en": "STOP", "name_ar": "توقف", "price": 1, "added_by": "الأدمن"},
        "ReplaceBrands": False,
    })
    assert state["items"]["SKU-1"]["name_en"] == "STOP"
    assert state["items"]["SKU-1"]["name_ar"] == "توقف"
    assert state["items"]["SKU-1"]["price"] == 1
    assert state["items"]["SKU-1"]["added_by"] == "الأدمن"


# ---------------------------------------------------------------------------
# Arabic: مسارات الـAPI.
# English: The API routes.
# ---------------------------------------------------------------------------

def test_routes_expose_plan_start_and_status(monkeypatch):
    from app.main import create_app

    _enable_sync()
    state, fake = _server_with(PRODUCTS, BRANDS)
    monkeypatch.setattr(sync_service, "sync_http_call", fake)
    client = create_app().test_client()

    plan = client.post("/api/sync/emergency/neutralize/plan", json={"Options": {"BumpIds": False}})
    assert plan.status_code == 200
    assert plan.get_json()["products_to_rewrite"] == 2

    started = client.post("/api/sync/emergency/neutralize", json={
        "Options": {"RewriteProducts": True, "ReplaceBrands": True, "LockLocal": False},
        "Confirm": neutralize_service.NEUTRALIZE_CONFIRM_PHRASE,
        "Actor": "يوسف",
    })
    assert started.status_code == 200
    assert started.get_json()["success"] is True

    deadline = time.time() + 10
    body = {}
    while time.time() < deadline:
        body = client.get("/api/sync/emergency/neutralize/status").get_json()
        if not body.get("running") and body.get("phase") in ("done", "failed"):
            break
        time.sleep(0.02)
    assert body["success"] is True
    assert body["phase"] == "done"
    assert body["products_done"] == 2

    # Arabic: حالة الإيقاف الطارئ تُرفق حالة التعطيل والعبارة حتى تعرضها اللوحة فوراً.
    # English: The emergency status attaches the neutralize state and phrase so the popup shows them at once.
    emergency = client.get("/api/sync/emergency/status").get_json()
    assert emergency["neutralize"]["phase"] == "done"
    assert emergency["neutralize_phrase"] == neutralize_service.NEUTRALIZE_CONFIRM_PHRASE

    refused = client.post("/api/sync/emergency/neutralize", json={"Confirm": "wrong", "Options": {}})
    assert refused.status_code == 400
