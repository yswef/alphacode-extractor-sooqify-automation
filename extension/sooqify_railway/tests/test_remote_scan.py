import threading

import pytest

from remote_browser import RemoteBrowser, RemoteBrowserError
from store_scan import ScanError, parse_extracted_page, scan_list_pages


def extracted_page(page_number, product_id, *, last_page=1, name="Test product", extra_fields=True):
    headers = ["Name English", "Price", "Brand", "Brand ID", "Style Code", "Search Code", "Local ID"]
    values = [name, "SAR 1,320.50", "Patek Philippe", "5", "STYLE-01", "SEARCH-01", "6017"]
    if extra_fields:
        headers.append("Image Count")
        values.append("2")
    links = [
        {
            "href": f"https://admin.sooqifyonline.com/admin/item/list?page={number}",
            "text": str(number),
            "disabled": False,
        }
        for number in range(1, last_page + 1)
    ]
    if last_page > 1:
        links[-1]["text"] += " last"
    return {
        "tables": [{
            "hasHeaders": True,
            "headers": headers,
            "rows": [{
                "cells": values,
                "links": [f"https://admin.sooqifyonline.com/admin/item/view/{product_id}"],
            }],
        }],
        "pageLinks": links,
        "hasPagination": last_page > 1,
        "activePageHref": f"https://admin.sooqifyonline.com/admin/item/list?page={page_number}",
        "activePageText": str(page_number),
        "hasPasswordField": False,
    }


def test_parser_uses_only_visible_list_fields_and_row_store_id():
    parsed = parse_extracted_page(extracted_page(1, 7801), 1)
    product = parsed["products"][0]
    assert product["id"] == 7801
    assert product["name_en"] == "Test product"
    assert product["price"] == 1320.5
    assert product["brand_id"] == 5
    assert product["local_tags"] == ["6017"]
    assert product["image_count"] == 2
    assert parsed["max_page"] == 0


def test_parser_keeps_unavailable_columns_unknown_not_zero():
    parsed = parse_extracted_page(extracted_page(1, 7802, extra_fields=False), 1)
    assert parsed["products"][0]["image_count"] is None
    assert parsed["products"][0]["fields_available"]["image_count"] is False


def test_parser_refuses_product_rows_without_observed_store_id():
    data = extracted_page(1, 7803)
    data["tables"][0]["rows"].append({"cells": ["another row"], "links": []})
    with pytest.raises(ScanError, match="Store ID|Store ID|Store ID|صفوف جدول القائمة"):
        parse_extracted_page(data, 1)


class FakeResponse:
    status = 200


class FakePage:
    def __init__(self, pages):
        self.pages = pages
        self.url = "https://admin.sooqifyonline.com/admin/item/list"
        self.requested = []

    def goto(self, url, **_kwargs):
        self.requested.append(url)
        self.url = url
        return FakeResponse()

    def evaluate(self, _script):
        page_number = int(self.url.rsplit("=", 1)[1])
        return self.pages[page_number]

    def wait_for_timeout(self, _milliseconds):
        return None


def test_server_scanner_only_visits_list_pages_and_emits_verified_records():
    fake = FakePage({
        1: extracted_page(1, 8801, last_page=2),
        2: extracted_page(2, 8802, last_page=2),
    })
    emitted = []
    summary = scan_list_pages(
        fake,
        on_progress=lambda *_args: None,
        on_page=lambda number, products: emitted.append((number, products)),
        cancelled=threading.Event(),
    )
    assert summary == {"pages_scanned": 2, "product_count": 2}
    assert len(emitted) == 2
    assert all("/admin/item/list?page=" in url for url in fake.requested)
    assert all("/admin/item/view/" not in url for url in fake.requested)


def test_server_scanner_rejects_login_redirect_without_promoting_data():
    fake = FakePage({})
    fake.url = "https://admin.sooqifyonline.com/admin/login"
    fake.goto = lambda url, **_kwargs: (setattr(fake, "url", "https://admin.sooqifyonline.com/admin/login") or FakeResponse())
    with pytest.raises(ScanError, match="سجّل الدخول"):
        scan_list_pages(
            fake,
            on_progress=lambda *_args: None,
            on_page=lambda *_args: pytest.fail("A login page must never emit product rows"),
            cancelled=threading.Event(),
        )


def test_remote_browser_is_opt_in_and_starts_without_transferring_local_session(tmp_path):
    browser = RemoteBrowser(tmp_path, enabled=False)
    assert browser.status()["enabled"] is False
    with pytest.raises(RemoteBrowserError, match="REMOTE_BROWSER_ENABLED"):
        browser.start()
    assert not (tmp_path / "sooqify_browser" / "profile").exists()


def test_remote_browser_route_policy_blocks_details_edits_deletes_and_external_navigation(tmp_path):
    class Request:
        def __init__(self, url, navigation=False):
            self.url = url
            self._navigation = navigation
            self.frame = type("Frame", (), {"parent_frame": None})()

        def is_navigation_request(self):
            return self._navigation

    class Route:
        def __init__(self, url, navigation=False):
            self.request = Request(url, navigation)
            self.action = ""

        def abort(self):
            self.action = "abort"

        def continue_(self):
            self.action = "continue"

    browser = RemoteBrowser(tmp_path, enabled=True)
    for route_name in ("view", "edit", "delete"):
        route = Route(f"https://admin.sooqifyonline.com/admin/item/{route_name}/123")
        browser._route_policy(route)
        assert route.action == "abort"
    safe_list = Route("https://admin.sooqifyonline.com/admin/item/list?page=2", navigation=True)
    browser._route_policy(safe_list)
    assert safe_list.action == "continue"
    outside = Route("https://example.org/", navigation=True)
    browser._route_policy(outside)
    assert outside.action == "abort"
