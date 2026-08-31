import os
import tempfile
import pytest

@pytest.fixture(autouse=True)
def setup_temp_root_dir(monkeypatch):
    """Ensure all tests use a temporary directory for ALPHACODE_ROOT_DIR."""
    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch.setenv("ALPHACODE_ROOT_DIR", temp_dir)
        yield temp_dir

def test_ai_helpers_smoke():
    from app.services.ai_helpers import normalize_text, canonicalize_brand_name
    assert normalize_text("  hello  ") == "hello"
    assert canonicalize_brand_name("adidas") == "Adidas"

def test_report_service_smoke():
    from app.services.report_service import _rtl
    # Just testing it doesn't crash on simple inputs
    res = _rtl("hello")
    assert isinstance(res, str)

def test_sync_service_smoke():
    from app.services.sync_service import load_sync_config
    # Should safely return defaults when the config file doesn't exist in the temp dir
    config = load_sync_config()
    assert isinstance(config, dict)
    assert "Enabled" in config

def test_upload_service_smoke():
    from app.services.upload_service import extract_settings
    # Testing it parses an empty payload to default settings safely
    settings = extract_settings({})
    assert isinstance(settings, dict)
    assert "ExchangeRate" in settings

def test_variant_extractor_service_smoke():
    from app.services.variant_extractor_service import build_watch_variant_messages
    msgs = build_watch_variant_messages("Some text", "ProductName", "Code", "Search")
    assert isinstance(msgs, list)
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
