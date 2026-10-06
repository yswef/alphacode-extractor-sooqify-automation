from audit import audit_snapshot


def test_pair_uses_real_store_id_and_exact_local_tag():
    snapshot = {
        "complete": True,
        "products": [{
            "id": 6638,
            "name_ar": "ساعة باتيك فيليب",
            "brand_id": 5,
            "brand_name": "Patek Philippe",
            "price": 1320,
            "image_count": 1,
            "local_tags": ["6017"],
        }],
    }
    archive = {"sku-1": {
        "id": 6017,
        "name_en": "Patek Philippe Automatic Watch",
        "name_ar": "ساعة باتيك فيليب",
        "brand_id": 5,
        "brand_name": "Patek Philippe",
        "price": 1320,
        "workflow_status": "submitted",
        "added_by": "Yusuf",
    }}
    baseline = {"6017": {
        "original_price_yuan": 500,
        "product_type": "watches",
        "settings": {"ExchangeRate": 1.2, "WatchFlatFeeYuan": 600},
    }}

    result = audit_snapshot(snapshot, archive, baseline)

    assert result["details"][0]["status"] == "match"
    assert result["details"][0]["store_product_id"] == 6638
    assert result["details"][0]["expected_price_sar"] == 1320
    assert result["summary"]["matched"] == 1


def test_price_formula_uses_javascript_rounding_at_half_integer():
    snapshot = {"complete": True, "products": [{
        "id": 7005,
        "local_tags": [6025],
        "name": "Rounding test",
        "price": 3,
        "image_count": 1,
    }]}
    archive = {"local": {
        "id": 6025,
        "name_en": "Rounding test",
        "price": 3,
        "workflow_status": "submitted",
    }}
    baseline = {"6025": {
        "original_price_yuan": 1,
        "product_type": "shoes",
        "settings": {"ExchangeRate": 2.5, "AddedFeeYuan": 0},
    }}

    result = audit_snapshot(snapshot, archive, baseline)

    assert result["details"][0]["expected_price_sar"] == 3
    assert result["details"][0]["status"] == "match"


def test_cartier_brand_id_issue_is_reported_without_any_delete_action():
    snapshot = {
        "complete": True,
        "products": [{
            "id": 6638,
            "name_ar": "ساعة باتيك فيليب",
            "brand_id": 9,
            "brand_name": "Cartier",
            "price": 745,
            "image_count": 1,
            "local_tags": ["6017"],
        }],
    }
    archive = {"sku-1": {
        "id": 6017,
        "name_ar": "ساعة باتيك فيليب",
        "brand_id": 5,
        "brand_name": "Patek Philippe",
        "price": 745,
        "workflow_status": "submitted",
    }}

    result = audit_snapshot(snapshot, archive)

    assert "brand_id_mismatch" in result["details"][0]["findings"]
    assert "brand_name_mismatch" in result["details"][0]["findings"]
    assert "delete" not in result["details"][0]


def test_partial_scan_cannot_be_audited():
    try:
        audit_snapshot({"complete": False, "products": []}, {})
        assert False, "partial scan should fail closed"
    except ValueError as error:
        assert "complete" in str(error)


def test_list_only_fallback_uses_unique_search_code_without_fetching_detail_pages():
    snapshot = {
        "complete": True,
        "products": [{
            "id": 7001,
            "name": "ساعة أصلية",
            "brand_name": "Cartier",
            "price": 745,
            "image_count": None,
            "search_code": "SKU-AR-01",
            "local_tags": [],
        }],
    }
    archive = {"sku": {
        "id": 6017,
        "name_ar": "ساعة أصلية",
        "search_code": "SKU-AR-01",
        "brand_name": "Cartier",
        "price": 745,
        "workflow_status": "submitted",
    }}

    result = audit_snapshot(snapshot, archive)

    row = result["details"][0]
    assert row["local_id"] == 6017
    assert row["store_product_id"] == 7001
    assert row["match_basis"] == "search_code"
    assert "image_count_unavailable" in row["findings"]
    assert row["store_name"] == "ساعة أصلية"
    assert row["status"] == "unverified"


def test_fields_absent_from_the_list_are_reported_as_unavailable_not_missing():
    snapshot = {
        "complete": True,
        "products": [{
            "id": 7004,
            "search_code": "MATCH-ME",
            "price": None,
            "name": "",
            "brand_name": "",
            "brand_id": None,
            "image_count": None,
            "fields_available": {
                "name": False,
                "price": False,
                "brand": False,
                "brand_id": False,
                "image_count": False,
                "search_code": True,
                "style_code": False,
            },
        }],
    }
    archive = {"local": {
        "id": 6024,
        "search_code": "MATCH-ME",
        "name_en": "Archived item",
        "price": 100,
        "brand_id": 5,
        "brand_name": "Patek Philippe",
        "workflow_status": "submitted",
    }}

    result = audit_snapshot(snapshot, archive)
    row = result["details"][0]

    assert row["match_basis"] == "search_code"
    assert row["status"] == "unverified"
    assert "store_name_unavailable" in row["findings"]
    assert "store_price_unavailable" in row["findings"]
    assert "store_brand_unavailable" in row["findings"]
    assert "store_brand_id_unavailable" in row["findings"]
    assert row["store_fields_unavailable"] == "name; price; brand; brand_id; image_count; style_code; local_id_tags"
    assert "missing_from_store" not in row["findings"]


def test_store_product_id_is_a_separate_exact_matching_key():
    snapshot = {
        "complete": True,
        "products": [{"id": 7003, "name": "Renamed at store", "price": 100, "image_count": 1}],
    }
    archive = {"local": {
        "id": 6021,
        "store_product_id": 7003,
        "name_en": "Original archive name",
        "price": 100,
        "workflow_status": "submitted",
    }}

    result = audit_snapshot(snapshot, archive)

    row = result["details"][0]
    assert row["local_id"] == 6021
    assert row["store_product_id"] == 7003
    assert row["match_basis"] == "store_product_id"
    assert "name_mismatch" in row["findings"]


def test_missing_is_confirmed_only_when_a_known_store_id_is_absent():
    snapshot = {"complete": True, "products": []}
    archive = {
        "without-store-id": {"id": 6022, "workflow_status": "submitted", "name_en": "Unknown link"},
        "with-store-id": {"id": 6023, "store_product_id": 7999, "workflow_status": "submitted"},
    }

    result = audit_snapshot(snapshot, archive)
    rows = {row["local_id"]: row for row in result["details"]}

    assert rows[6022]["status"] == "unlinked"
    assert rows[6022]["findings"] == ["store_id_unresolved"]
    assert rows[6023]["status"] == "missing"
    assert rows[6023]["findings"] == ["missing_from_store"]
    assert result["summary"]["submitted_missing"] == 1


def test_exact_generic_name_and_price_fallback_is_unique_and_labeled():
    snapshot = {
        "complete": True,
        "products": [{"id": 7002, "name": "Classic Leather Wallet", "price": 100, "image_count": 1}],
    }
    archive = {"local": {
        "id": 6020,
        "name_en": "Classic Leather Wallet",
        "price": 100,
        "workflow_status": "submitted",
    }}

    result = audit_snapshot(snapshot, archive)

    row = result["details"][0]
    assert row["local_id"] == 6020
    assert row["match_basis"] == "exact_name_price"
    assert row["status"] == "unverified"  # the formula baseline is explicitly missing
    assert "price_formula_baseline_missing" in row["findings"]
