"""Server-side, list-only Sooqify scanner for an authenticated Playwright page."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

SOOQIFY_ORIGIN = "https://admin.sooqifyonline.com"
LIST_PATH = "/admin/item/list"
MAX_SCAN_PAGES = 5000


class ScanError(RuntimeError):
    """The list could not be scanned completely and safely."""


class ScanCancelled(ScanError):
    """The operator cancelled the current list scan."""


# Only reads rendered table text, action-link paths, and pagination links. It does not
# follow any row link or request a product view/edit/delete route.
_DOM_EXTRACTOR = r"""() => {
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const tables = Array.from(document.querySelectorAll('table')).map(table => {
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter(row => row.cells?.length);
    const rows = bodyRows.length
      ? bodyRows
      : Array.from(table.querySelectorAll('tr')).filter(row => row.querySelector('td'));
    const headerRow = table.querySelector('thead tr')
      || Array.from(table.querySelectorAll('tr')).find(row => row.querySelector('th'));
    return {
      hasHeaders: Boolean(table.querySelector('thead th, th')),
      headers: Array.from(headerRow?.querySelectorAll('th, td') || []).map(cell => normalize(cell.textContent)),
      rows: rows.map(row => ({
        cells: Array.from(row.cells || []).map(cell => normalize(cell.textContent)),
        links: Array.from(row.querySelectorAll('a[href]')).map(link => link.href),
      })),
    };
  });
  const pageLinks = Array.from(document.querySelectorAll('a[href*=\"page=\"]')).map(link => ({
    href: link.href,
    text: normalize(`${link.textContent} ${link.getAttribute('aria-label') || ''} ${link.title || ''} ${link.rel || ''} ${link.className || ''}`).toLowerCase(),
    disabled: link.getAttribute('aria-disabled') === 'true' || Boolean(link.closest('.disabled')),
  }));
  const active = document.querySelector('.pagination .active, .pagination [aria-current=\"page\"]');
  const activeLink = active?.querySelector('a[href*=\"page=\"]');
  return {
    tables,
    pageLinks,
    hasPagination: pageLinks.length > 1 || Boolean(document.querySelector('.pagination, [aria-label*=\"pagination\" i]')),
    activePageHref: activeLink?.href || '',
    activePageText: active ? normalize(active.textContent) : '',
    hasPasswordField: Boolean(document.querySelector('input[type=\"password\"]')),
  };
}"""

_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def normalize(value: object) -> str:
    return " ".join(str(value or "").translate(_ARABIC_DIGITS).split()).strip()


def parse_count(value: object) -> int | None:
    matches = re.findall(r"\d+", normalize(value))
    if len(matches) != 1:
        return None
    try:
        count = int(matches[0])
    except ValueError:
        return None
    return count if 0 <= count <= 2**53 - 1 else None


def parse_money(value: object) -> float | None:
    text = normalize(value).replace(",", "")
    matches = re.findall(r"(?:^|[^\d])(\d+(?:\.\d{1,2})?)(?:[^\d]|$)", text)
    if len(matches) != 1:
        return None
    try:
        number = float(matches[0])
    except ValueError:
        return None
    return number if number >= 0 else None


def header_kind(value: object) -> str:
    label = normalize(value).lower()
    if re.search(r"السعر|price|سعر", label):
        return "price"
    if re.search(r"brand.?id|id.?brand|معرف.*العلامة|رقم.*العلامة|معرف.*البراند", label):
        return "brand_id"
    if re.search(r"brand|براند|ماركة|العلامة التجارية", label):
        return "brand"
    if re.search(r"\bsku\b|style.?code|كود.*ستايل|كود الصنف", label):
        return "style_code"
    if re.search(r"search.?code|item.?code|رمز البحث|كود البحث", label):
        return "search_code"
    if re.search(r"local.?id|alphacode.*id|معرف.*ألفا|رقم.*ألفا", label):
        return "local_id"
    if re.search(r"image.?count|count.?of.?images|number.?of.?images|عدد الصور|عدد.*الصور", label):
        return "image_count"
    if re.search(r"image|صورة|الصورة", label):
        return "image"
    if re.search(r"\b(?:id|code|sku)\b|رقم|معرف", label):
        return ""

    has_name = re.search(r"\bname\b|\btitle\b|الاسم|اسم المنتج|^اسم$|^المنتج$|^product$", label)
    if has_name and re.search(r"arabic|\bar\b|عربي|العربية", label):
        return "name_ar"
    if has_name and re.search(r"english|\ben\b|إنجليزي|الإنجليزية", label):
        return "name_en"
    if has_name:
        return "name"
    return ""


def _store_id(links: object) -> int:
    for href in links if isinstance(links, list) else []:
        try:
            path = urlsplit(str(href)).path
        except ValueError:
            continue
        match = re.search(r"/admin/item/(?:view|edit)/(\d+)(?:/|$)", path, re.IGNORECASE)
        if match:
            value = int(match.group(1))
            if value > 0:
                return value
    return 0


def _page_number(href: object) -> int:
    try:
        values = parse_qs(urlsplit(str(href or "")).query).get("page", [])
        return int(values[0]) if values else 0
    except (TypeError, ValueError):
        return 0


def parse_extracted_page(data: object, requested_page: int) -> dict:
    """Normalize the DOM summary returned by Playwright; never infer hidden fields."""
    if not isinstance(data, dict):
        raise ScanError(f"تعذر قراءة بنية صفحة القائمة {requested_page}.")
    tables = data.get("tables") if isinstance(data.get("tables"), list) else []
    candidates = []
    for table in tables:
        if not isinstance(table, dict):
            continue
        rows = table.get("rows") if isinstance(table.get("rows"), list) else []
        valid_rows = [row for row in rows if isinstance(row, dict) and _store_id(row.get("links"))]
        if valid_rows or table.get("hasHeaders"):
            candidates.append((len(valid_rows), table, rows, valid_rows))
    if not candidates:
        raise ScanError(f"لم أتعرف على جدول قائمة المنتجات في الصفحة {requested_page}.")

    _, table, candidate_rows, rows = max(candidates, key=lambda item: item[0])
    if not rows:
        raise ScanError(f"لم أجد صفوف منتجات قابلة للتحقق في الصفحة {requested_page}؛ لم تُعتمد لقطة جديدة.")
    if len(candidate_rows) != len(rows):
        raise ScanError(f"بعض صفوف جدول القائمة لا تحتوي رابط إجراء يمكن استخراج Store ID منه (صفحة {requested_page}).")

    headers = table.get("headers") if isinstance(table.get("headers"), list) else []
    columns = [header_kind(value) for value in headers]
    if headers and any(len(row.get("cells", [])) != len(headers) for row in rows):
        raise ScanError(f"عدد أعمدة الصف لا يطابق العناوين في الصفحة {requested_page}؛ المسح غير مكتمل.")

    fields_available = {
        "name": any(key in {"name", "name_en", "name_ar"} for key in columns),
        "price": "price" in columns,
        "brand": "brand" in columns,
        "brand_id": "brand_id" in columns,
        "image_count": "image_count" in columns,
        "style_code": "style_code" in columns,
        "search_code": "search_code" in columns,
        "local_id_tags": "local_id" in columns,
    }
    products = []
    for row in rows:
        cells = row.get("cells") if isinstance(row.get("cells"), list) else []
        values = {}
        for index, cell in enumerate(cells):
            key = columns[index] if index < len(columns) else ""
            if key and not values.get(key):
                values[key] = normalize(cell)
        products.append({
            "id": _store_id(row.get("links")),
            "name_en": values.get("name_en", ""),
            "name_ar": values.get("name_ar", ""),
            "name": values.get("name", ""),
            "brand_name": values.get("brand", ""),
            "brand_id": parse_count(values.get("brand_id")) if fields_available["brand_id"] else None,
            "price": parse_money(values.get("price")),
            "image_count": parse_count(values.get("image_count")) if fields_available["image_count"] else None,
            "style_code": values.get("style_code", ""),
            "search_code": values.get("search_code", ""),
            "fields_available": fields_available,
            "local_tags": [values["local_id"]] if fields_available["local_id_tags"] and values.get("local_id") else [],
        })

    page_links = data.get("pageLinks") if isinstance(data.get("pageLinks"), list) else []
    linked_pages = []
    max_page = 0
    for link in page_links:
        if not isinstance(link, dict):
            continue
        page = _page_number(link.get("href"))
        label = normalize(link.get("text", "")).lower()
        if page > 0:
            linked_pages.append((page, label, bool(link.get("disabled"))))
        if page > max_page and re.search(r"last|الأخيرة|الاخيرة|آخر صفحة|»»", label):
            max_page = page
    if max_page and any(page > max_page for page, _, _ in linked_pages):
        raise ScanError(f"روابط الترقيم تتجاوز الصفحة الأخيرة المعلنة في الصفحة {requested_page}.")

    active_page = _page_number(data.get("activePageHref"))
    if not active_page:
        active_numbers = re.findall(r"\d+", normalize(data.get("activePageText", "")))
        active_page = int(active_numbers[0]) if active_numbers else 0
    current_page = active_page or requested_page
    has_next = any(page > current_page for page, _, _ in linked_pages)
    if not has_next:
        has_next = any(
            not disabled
            and re.search(r"next|التالي|التالية|›|»|→|>", label)
            and (page == 0 or page > current_page)
            for page, label, disabled in linked_pages
        )

    return {
        "page": requested_page,
        "products": products,
        "max_page": max_page,
        "has_pagination": bool(data.get("hasPagination")),
        "active_page": active_page,
        "has_next": has_next,
        "has_page_links": bool(page_links),
        "has_password_field": bool(data.get("hasPasswordField")),
    }


def scan_list_pages(page, *, on_progress, on_page, cancelled, max_pages: int = MAX_SCAN_PAGES) -> dict:
    """Visit only `/admin/item/list?page=N`, emitting verified pages as they arrive."""
    seen_ids: set[int] = set()
    max_page = 0
    reached_end = False
    last_page = 0
    last_signature: tuple[int, ...] | None = None
    pages_scanned = 0

    for page_number in range(1, max_pages + 1):
        if cancelled.is_set():
            raise ScanCancelled("أُلغي الفحص بناءً على طلب المستخدم؛ لم تُستبدل اللقطة المكتملة السابقة.")
        on_progress(page_number, max_page, len(seen_ids))
        response = page.goto(
            f"{SOOQIFY_ORIGIN}{LIST_PATH}?page={page_number}",
            wait_until="domcontentloaded",
            timeout=60_000,
        )
        if response is not None and response.status >= 400:
            raise ScanError(f"تعذر قراءة صفحة القائمة {page_number} (HTTP {response.status}).")
        current_url = urlsplit(page.url)
        if re.search(r"/login(?:/|$)", current_url.path, re.IGNORECASE):
            raise ScanError("انتهت جلسة Sooqify أو لم تسجل الدخول بعد؛ سجّل الدخول يدوياً وحل CAPTCHA ثم أعد الفحص.")
        data = page.evaluate(_DOM_EXTRACTOR)
        parsed = parse_extracted_page(data, page_number)
        if parsed["has_password_field"]:
            raise ScanError("الجلسة غير مسجلة؛ أكمل تسجيل الدخول وCAPTCHA يدوياً ثم أعد الفحص.")
        if parsed["active_page"] and parsed["active_page"] != page_number:
            raise ScanError(f"طلبت الصفحة {page_number} لكن ترقيم القائمة أظهر الصفحة {parsed['active_page']}؛ المسح غير مكتمل.")

        product_ids = [item["id"] for item in parsed["products"]]
        signature = tuple(product_ids)
        if last_signature is not None and last_signature == signature:
            reached_clamped_last_page = parsed["active_page"] == last_page and not parsed["has_next"]
            if (max_page and page_number <= max_page) or not reached_clamped_last_page:
                raise ScanError("رُصد تكرار صفحة دون دليل كافٍ على نهاية الترقيم؛ المسح غير مكتمل.")
            reached_end = True
            break
        duplicates = [item_id for item_id in product_ids if item_id in seen_ids]
        if duplicates:
            raise ScanError(f"تغيّرت القائمة أثناء المسح وظهرت IDs مكررة ({duplicates[:3]})؛ لم تُعتمد لقطة جديدة.")
        seen_ids.update(product_ids)
        on_page(page_number, parsed["products"])
        pages_scanned += 1
        last_page = page_number
        last_signature = signature
        on_progress(page_number, max_page or parsed["max_page"], len(seen_ids))
        if parsed["max_page"]:
            max_page = max(max_page, parsed["max_page"])
        if max_page and page_number >= max_page:
            reached_end = True
            break
        if not max_page and not parsed["has_next"]:
            if parsed["has_pagination"] and (not parsed["active_page"] or parsed["active_page"] != page_number or not parsed["has_page_links"]):
                raise ScanError(f"تعذر التحقق من نهاية الترقيم بعد الصفحة {page_number}؛ المسح غير مكتمل.")
            reached_end = True
            break
        if page_number == max_pages:
            raise ScanError(f"تجاوز الفحص حد {max_pages} صفحة؛ لم تُعتمد اللقطة.")
        page.wait_for_timeout(150)

    if not pages_scanned:
        raise ScanError("لم يُعثر على أي صف منتج في قائمة Sooqify.")
    if not reached_end:
        raise ScanError("لم يتم إثبات الوصول إلى نهاية قائمة Sooqify؛ لم تُعتمد اللقطة.")
    return {"pages_scanned": pages_scanned, "product_count": len(seen_ids)}
