"""Arabic: اختبار مسار إضافة براند جديد ضد TypeError التاريخي في sync_call.
English: Regression test for the new-brand route against the historical sync_call TypeError."""
import ast
import inspect
import tempfile

import pytest


@pytest.fixture(autouse=True)
def setup_temp_root_dir(monkeypatch):
    """Ensure all tests use a temporary directory for ALPHACODE_ROOT_DIR."""
    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch.setenv("ALPHACODE_ROOT_DIR", temp_dir)
        yield temp_dir


def _sync_call_calls_in(function):
    """Arabic: يعيد قائمة بنداءات sync_call داخل دالة مع كلمات المفاتيح المستخدمة.
    English: Return the sync_call calls inside a function with the keywords they use."""
    tree = ast.parse(inspect.getsource(function))
    calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "id", getattr(node.func, "attr", None))
            if name == "sync_call":
                calls.append([kw.arg for kw in node.keywords if kw.arg])
    return calls


def test_api_add_brand_kwargs_match_sync_call_signature():
    """Arabic: كل كلمات المفاتيح التي يستخدمها مسار إضافة براند في sync_call يجب أن تكون موجودة
            في توقيع sync_call الفعلي (كان data= يرمي TypeError ويعطي HTTP 500).
    English: Every keyword the brand-add route passes to sync_call must exist in the real
             signature (data= used to raise TypeError and produced HTTP 500)."""
    from app.api.routes import core_routes
    from app.services.sync_service import sync_call

    signature = inspect.signature(sync_call)
    calls = _sync_call_calls_in(core_routes.api_add_brand)
    assert calls, "api_add_brand should call sync_call"
    for keywords in calls:
        for keyword in keywords:
            assert keyword in signature.parameters, (
                f"api_add_brand passes {keyword!r} to sync_call "
                f"but sync_call only accepts: {list(signature.parameters)}"
            )


def test_api_add_brand_forwards_payload_without_typeerror(monkeypatch):
    """Arabic: استدعاء /api/brands/add يجب أن يوصل الحمولة إلى sync_call بدون TypeError
            ويرجع استجابة الخادم كما هي.
    English: POST /api/brands/add must hand the body to sync_call without TypeError and
             relay the server response."""
    from app.main import create_app
    from app.api.routes import core_routes
    from app.repositories.sync_config_repository import save_sync_config

    save_sync_config({
        "Enabled": True,
        "ServerUrl": "https://central.example",
        "Token": "test-token",
        "AddedByName": "tester",
    })

    captured = {}

    def fake_sync_call(action, payload=None, method="POST"):
        # Same real signature as app.services.sync_service.sync_call - passing an unknown
        # keyword (like data=) would raise TypeError here, exactly as in production.
        captured["action"] = action
        captured["payload"] = payload
        captured["method"] = method
        return {"success": True, "id": 7, "name": (payload or {}).get("name")}, None

    monkeypatch.setattr(core_routes, "sync_call", fake_sync_call)

    app = create_app()
    client = app.test_client()
    response = client.post("/api/brands/add", json={"name": "Nike", "id": 7})

    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is True
    assert captured["action"] == "brands/add"
    assert captured["method"] == "POST"
    assert captured["payload"] == {"name": "Nike", "id": 7}
