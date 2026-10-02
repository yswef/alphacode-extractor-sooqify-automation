"""Regression coverage for the canonical Sooqify brand-ID map."""

from app.services.product_helpers import canonicalize_brand_name, parse_brand_records


def test_arabic_brand_labels_canonicalize_to_extension_names():
    assert canonicalize_brand_name("كارتية") == "Cartier"
    assert canonicalize_brand_name("فرانك مولر") == "Franck Muller"
    assert canonicalize_brand_name("نيو بالانس") == "New Balance"
    assert canonicalize_brand_name("باتك فيليب") == "Patek Philippe"
    assert canonicalize_brand_name("أديداس") == "Adidas"
    assert canonicalize_brand_name("رولكس") == "Rolex"


def test_brand_records_keep_store_ids_and_drop_invalid_duplicate_rows():
    records = [
        {"id": 1, "name": "Air Jordan"},
        {"id": 2, "name": "كارتية"},
        {"id": 0, "name": "Invalid"},
        {"id": 3, "name": "فرانك مولر"},
        {"id": 4, "name": "New Balance"},
        {"id": 4, "name": "Duplicate ID"},
        {"id": 6, "name": "باتك فيليب"},
    ]
    assert parse_brand_records(records) == {
        "Air Jordan": 1,
        "Cartier": 2,
        "Franck Muller": 3,
        "New Balance": 4,
        "Patek Philippe": 6,
    }


def test_upload_brand_map_uses_shared_live_ids_instead_of_stale_local_json(monkeypatch):
    from app.api.routes import upload_routes

    monkeypatch.setattr(upload_routes, "load_sync_config", lambda: {"Enabled": True})
    monkeypatch.setattr(
        upload_routes,
        "sync_call",
        lambda action, **kwargs: ({
            "success": True,
            "brands": [
                {"id": 1, "name": "Air Jordan"},
                {"id": 7, "name": "أديداس"},
                {"id": 8, "name": "رولكس"},
            ],
        }, None),
    )

    brand_map, shared, error = upload_routes._load_brand_map_for_upload({
        "BrandMapJson": '{"Adidas": 8, "Air Jordan": 6}',
    })
    assert shared is True
    assert error is None
    assert brand_map == {"Air Jordan": 1, "Adidas": 7, "Rolex": 8}


def test_upload_brand_map_fails_closed_when_shared_map_is_unavailable(monkeypatch):
    from app.api.routes import upload_routes

    monkeypatch.setattr(upload_routes, "load_sync_config", lambda: {"Enabled": True})
    monkeypatch.setattr(upload_routes, "sync_call", lambda *args, **kwargs: (None, "network down"))

    brand_map, shared, error = upload_routes._load_brand_map_for_upload({
        "BrandMapJson": '{"Air Jordan": 6}',
    })
    assert shared is True
    assert brand_map == {}
    assert "network down" in error


def test_get_brands_returns_canonical_names_and_live_ids(monkeypatch):
    from app.api.routes import core_routes
    from app.main import create_app

    monkeypatch.setattr(core_routes, "load_sync_config", lambda: {"Enabled": True})
    monkeypatch.setattr(
        core_routes,
        "sync_call",
        lambda action, **kwargs: ({"success": True, "brands": [
            {"id": 1, "name": "Air Jordan"},
            {"id": 2, "name": "كارتية"},
            {"id": 7, "name": "أديداس"},
        ]}, None),
    )
    response = create_app().test_client().get("/api/brands")
    assert response.status_code == 200
    assert response.get_json()["brands"] == [
        {"id": 1, "name": "Air Jordan"},
        {"id": 2, "name": "Cartier"},
        {"id": 7, "name": "Adidas"},
    ]


def test_add_brand_route_uses_php_action_and_payload_keyword(monkeypatch):
    from app.api.routes import core_routes
    from app.main import create_app

    calls = []
    monkeypatch.setattr(core_routes, "load_sync_config", lambda: {"Enabled": True})

    def fake_sync_call(action, payload=None, method="POST"):
        calls.append((action, payload, method))
        return ({"success": True, "brand": {"id": 12, "name": "Adidas"}}, None)

    monkeypatch.setattr(core_routes, "sync_call", fake_sync_call)
    response = create_app().test_client().post(
        "/api/brands/add", json={"id": 12, "name": "أديداس"}
    )
    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert calls == [("add_brand", {"name": "Adidas", "id": 12}, "POST")]


def test_brand_sync_route_canonicalizes_and_validates_import(monkeypatch):
    from app.api.routes import core_routes
    from app.main import create_app

    calls = []
    monkeypatch.setattr(core_routes, "load_sync_config", lambda: {"Enabled": True})

    def fake_sync_call(action, payload=None, method="POST"):
        calls.append((action, payload, method))
        return ({"success": True, "brand_count": len(payload["brands"]), "brands": payload["brands"]}, None)

    monkeypatch.setattr(core_routes, "sync_call", fake_sync_call)
    client = create_app().test_client()

    response = client.post("/api/brands/sync", json={
        "confirm_replace": True,
        "brands": [
            {"id": 1, "name": "Air Jordan"},
            {"id": 2, "name": "كارتية"},
            {"id": 7, "name": "أديداس"},
        ],
    })
    assert response.status_code == 200
    assert calls == [(
        "brands/sync",
        {"confirm_replace": True, "brands": [
            {"id": 1, "name": "Air Jordan"},
            {"id": 2, "name": "Cartier"},
            {"id": 7, "name": "Adidas"},
        ]},
        "POST",
    )]

    duplicate = client.post("/api/brands/sync", json={
        "confirm_replace": True,
        "brands": [{"id": 1, "name": "Nike"}, {"id": 1, "name": "Adidas"}],
    })
    assert duplicate.status_code == 400
    assert len(calls) == 1
