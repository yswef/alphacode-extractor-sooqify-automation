"""Pure, read-only audit logic for archive records and sanitized store snapshots."""

from __future__ import annotations

import math
import re
import unicodedata


PRICE_TOLERANCE_SAR = 0


def _number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _integer(value):
    number = _number(value)
    return int(number) if number is not None and number.is_integer() else 0


def _text(value):
    return str(value or "").strip()


def _norm(value):
    value = unicodedata.normalize("NFKC", _text(value)).casefold()
    value = re.sub(r"[\u064b-\u065f\u0670]", "", value)
    return re.sub(r"\s+", " ", value).strip()


def _field_available(record, field):
    record = record if isinstance(record, dict) else {}
    availability = record.get("fields_available")
    if isinstance(availability, dict) and isinstance(availability.get(field), bool):
        return availability[field]
    value_by_field = {
        "name": record.get("name_ar") or record.get("name") or record.get("name_en"),
        "price": record.get("price"),
        "brand": record.get("brand_name"),
        "brand_id": record.get("brand_id"),
        "image_count": record.get("image_count"),
        "style_code": record.get("style_code"),
        "search_code": record.get("search_code"),
        "local_id_tags": record.get("local_tags") or record.get("tags"),
    }
    value = value_by_field.get(field)
    if field == "local_id_tags":
        return bool(value)
    return value not in (None, "")


def canonical_brand(value):
    name = _norm(value)
    aliases = {
        "كارتية": "cartier",
        "كارتير": "cartier",
        "كارتييه": "cartier",
        "cartier": "cartier",
        "باتك فيليب": "patek philippe",
        "باتيك فيليب": "patek philippe",
        "patek philippe": "patek philippe",
    }
    return aliases.get(name, name)


def _fee_and_rate(product):
    settings = product.get("settings") if isinstance(product.get("settings"), dict) else {}
    product_type = _text(product.get("product_type") or settings.get("ProductType")).lower()
    if product_type not in {"shoes", "watches"}:
        return None, None
    original_yuan = _number(product.get("original_price_yuan"))
    rate = _number(settings.get("ExchangeRate"))
    fee_key = "WatchFlatFeeYuan" if product_type == "watches" else "AddedFeeYuan"
    fee = _number(settings.get(fee_key))
    if original_yuan is None or original_yuan <= 0 or rate is None or rate <= 0 or fee is None:
        return None, None
    return math.floor((original_yuan + fee) * rate + 0.5), product_type


def _tag_ids(record):
    raw = record.get("local_tags")
    if raw is None:
        raw = record.get("tags")
    if not isinstance(raw, (list, tuple, set)):
        raw = [raw]
    ids = set()
    for value in raw:
        for token in re.findall(r"\d+", _text(value)):
            number = _integer(token)
            if number > 0:
                ids.add(number)
    local_id = _integer(record.get("local_id"))
    if local_id > 0:
        ids.add(local_id)
    return ids


def audit_snapshot(snapshot, archive_items, price_baselines=None):
    """Join by exact Local ID tag, known Store ID, unique codes, then exact name/price."""
    if not isinstance(snapshot, dict) or snapshot.get("complete") is not True:
        raise ValueError("A complete Sooqify scan is required for an audit.")
    store_products = snapshot.get("products")
    if not isinstance(store_products, list):
        raise ValueError("The scan snapshot has no product list.")
    archive_items = archive_items if isinstance(archive_items, dict) else {}

    price_baselines = price_baselines if isinstance(price_baselines, dict) else {}
    archive_by_id = {}
    for item in archive_items.values():
        if not isinstance(item, dict) or item.get("id") is None:
            continue
        if item.get("_work_unit") or item.get("record_type") == "work_unit":
            continue
        local_id = _integer(item.get("id"))
        if local_id <= 0:
            continue
        merged = dict(item)
        baseline = price_baselines.get(str(local_id)) or price_baselines.get(local_id)
        if isinstance(baseline, dict):
            for key in ("original_price_yuan", "product_type"):
                if merged.get(key) in (None, "") and baseline.get(key) not in (None, ""):
                    merged[key] = baseline[key]
            merged_settings = dict(merged.get("settings") or {})
            merged_settings.update(baseline.get("settings") or {})
            merged["settings"] = merged_settings
        archive_by_id[local_id] = merged

    code_indexes = {"search_code": {}, "style_code": {}}
    name_index = {}
    for local_id, archived in archive_by_id.items():
        for field, index in code_indexes.items():
            code = _norm(archived.get(field))
            if code and code not in {"-", "none", "no_code", "n/a", "na", "null", "undefined", "0"}:
                index.setdefault(code, set()).add(local_id)
        for value in (archived.get("name_en"), archived.get("name_ar") or archived.get("name")):
            name = _norm(value)
            if name:
                name_index.setdefault(name, set()).add(local_id)

    store_by_id = {}
    for store in store_products:
        if isinstance(store, dict):
            store_id = _integer(store.get("id") or store.get("store_product_id"))
            if store_id > 0:
                store_by_id[store_id] = store

    archive_by_store_id = {}
    for local_id, archived in archive_by_id.items():
        store_id = _integer(archived.get("store_product_id"))
        if store_id > 0:
            archive_by_store_id.setdefault(store_id, set()).add(local_id)

    stores_by_local_id = {}
    for store in store_products:
        if not isinstance(store, dict):
            continue
        tag_ids = _tag_ids(store)
        if tag_ids:
            for local_id in tag_ids:
                stores_by_local_id.setdefault(local_id, []).append({**store, "_match_basis": "local_id_tag"})
            continue

        store_id = _integer(store.get("id") or store.get("store_product_id"))
        store_id_candidates = archive_by_store_id.get(store_id, set()) if store_id > 0 else set()
        if len(store_id_candidates) == 1:
            local_id = next(iter(store_id_candidates))
            stores_by_local_id.setdefault(local_id, []).append({**store, "_match_basis": "store_product_id"})
            continue

        candidates = set()
        match_basis = ""
        for field in ("search_code", "style_code"):
            code = _norm(store.get(field)) if _field_available(store, field) else ""
            indexed = code_indexes[field].get(code, set()) if code else set()
            if len(indexed) == 1:
                candidates = set(indexed)
                match_basis = field
                break
        if not candidates and _field_available(store, "name") and _field_available(store, "price"):
            name = _norm(store.get("name_ar") or store.get("name") or store.get("name_en"))
            possible = name_index.get(name, set()) if name else set()
            store_price = _number(store.get("price"))
            if store_price is not None:
                possible = {
                    local_id for local_id in possible
                    if _number(archive_by_id[local_id].get("price")) is not None
                    and _number(archive_by_id[local_id].get("price")) == store_price
                }
            else:
                possible = set()
            if len(possible) == 1:
                candidates = set(possible)
                match_basis = "exact_name_price"
        if len(candidates) == 1:
            local_id = next(iter(candidates))
            stores_by_local_id.setdefault(local_id, []).append({**store, "_match_basis": match_basis})

    details = []
    matched_store_ids = set()
    for local_id, archived in sorted(archive_by_id.items()):
        status = _text(archived.get("workflow_status") or archived.get("store_submission_status")).lower()
        candidates = stores_by_local_id.get(local_id, [])
        if not candidates:
            expected_store_id = _integer(archived.get("store_product_id"))
            confirmed_absent = expected_store_id > 0 and expected_store_id not in store_by_id
            if status == "submitted" and confirmed_absent:
                details.append(_base_row(local_id, archived, None, ["missing_from_store"], "missing"))
            else:
                details.append(_base_row(local_id, archived, None, ["store_id_unresolved"], "unlinked"))
            continue
        if len(candidates) > 1:
            for store in candidates:
                matched_store_ids.add(_integer(store.get("id") or store.get("store_product_id")))
            details.append(_base_row(local_id, archived, candidates[0], ["duplicate_store_matches"], "issues"))
            continue

        store = candidates[0]
        store_id = _integer(store.get("id") or store.get("store_product_id"))
        if store_id > 0:
            matched_store_ids.add(store_id)
        findings = []
        known_store_id = _integer(archived.get("store_product_id"))
        if known_store_id > 0 and store_id != known_store_id:
            findings.append("store_id_mismatch")

        if store.get("image_count") is None:
            findings.append("image_count_unavailable")
        elif _integer(store.get("image_count")) < 1:
            findings.append("no_store_image")

        formula_price, _ = _fee_and_rate(archived)
        expected_price = formula_price if formula_price is not None else _number(archived.get("price"))
        if formula_price is None:
            findings.append("price_formula_baseline_missing")
        store_price = _number(store.get("price"))
        if store_price is None or store_price <= 0:
            findings.append("store_price_missing" if _field_available(store, "price") else "store_price_unavailable")
        elif expected_price is not None and abs(store_price - expected_price) > PRICE_TOLERANCE_SAR:
            findings.append("store_price_mismatch")

        expected_brand_id = _integer(archived.get("brand_id"))
        actual_brand_id = _integer(store.get("brand_id"))
        expected_brand = canonical_brand(archived.get("brand_name"))
        actual_brand = canonical_brand(store.get("brand_name"))
        if expected_brand_id > 0:
            if actual_brand_id > 0 and expected_brand_id != actual_brand_id:
                findings.append("brand_id_mismatch")
            elif actual_brand_id <= 0:
                findings.append("store_brand_id_missing" if _field_available(store, "brand_id") else "store_brand_id_unavailable")
        if expected_brand and actual_brand and expected_brand != actual_brand:
            findings.append("brand_name_mismatch")
        elif expected_brand and not actual_brand:
            findings.append("store_brand_missing" if _field_available(store, "brand") else "store_brand_unavailable")

        names = {_norm(archived.get("name_en")), _norm(archived.get("name_ar") or archived.get("name"))} - {""}
        store_name = _norm(store.get("name_ar") or store.get("name") or store.get("name_en"))
        if names and store_name and store_name not in names:
            findings.append("name_mismatch")
        elif names and not store_name:
            findings.append("store_name_missing" if _field_available(store, "name") else "store_name_unavailable")

        unverifiable_only = {
            "price_formula_baseline_missing", "image_count_unavailable",
            "store_price_unavailable", "store_brand_unavailable",
            "store_brand_id_unavailable", "store_name_unavailable",
        }
        row_status = "match" if not findings else (
            "unverified" if set(findings).issubset(unverifiable_only) else "issues"
        )
        details.append(_base_row(local_id, archived, store, findings, row_status))

    for store in store_products:
        if not isinstance(store, dict):
            continue
        store_id = _integer(store.get("id") or store.get("store_product_id"))
        if store_id in matched_store_ids:
            continue
        local_tags = _tag_ids(store)
        if not local_tags or not any(local_id in archive_by_id for local_id in local_tags):
            details.append(_base_row(None, {}, store, ["store_product_unlinked"], "unlinked_store"))

    summary = {
        "archive_products": len(archive_by_id),
        "store_products": len(store_products),
        "matched": sum(row["status"] == "match" for row in details),
        "issues": sum(row["status"] in {"issues", "missing"} for row in details),
        "unverified": sum(row["status"] == "unverified" for row in details),
        "price_formula_baseline_missing": sum("price_formula_baseline_missing" in row["findings"] for row in details),
        "submitted_missing": sum("missing_from_store" in row["findings"] for row in details),
        "no_store_image": sum("no_store_image" in row["findings"] for row in details),
        "image_count_unavailable": sum("image_count_unavailable" in row["findings"] for row in details),
        "name_mismatch": sum("name_mismatch" in row["findings"] for row in details),
        "brand_mismatch": sum(any(x in row["findings"] for x in ("brand_id_mismatch", "brand_name_mismatch")) for row in details),
        "price_mismatch": sum("store_price_mismatch" in row["findings"] for row in details),
        "store_unlinked": sum(row["status"] == "unlinked_store" for row in details),
        "archive_unresolved": sum(row["status"] == "unlinked" for row in details),
    }
    return {"summary": summary, "details": details}


def _base_row(local_id, archived, store, findings, status):
    archived = archived if isinstance(archived, dict) else {}
    store = store if isinstance(store, dict) else {}
    formula_price, _ = _fee_and_rate(archived)
    archive_price = _number(archived.get("price"))
    expected_price = formula_price if formula_price is not None else archive_price
    unavailable_fields = []
    if store:
        unavailable_fields = [
            field for field in ("name", "price", "brand", "brand_id", "image_count", "style_code", "search_code", "local_id_tags")
            if not _field_available(store, field)
        ]
    return {
        "local_id": local_id,
        "store_product_id": _integer(store.get("id") or store.get("store_product_id")) or _integer(archived.get("store_product_id")) or None,
        "name_en": _text(archived.get("name_en") or archived.get("name")),
        "name_ar": _text(archived.get("name_ar")),
        "store_name": _text(store.get("name_ar") or store.get("name") or store.get("name_en")),
        "expected_brand": _text(archived.get("brand_name")),
        "expected_brand_id": _integer(archived.get("brand_id")) or None,
        "store_brand": _text(store.get("brand_name")),
        "store_brand_id": _integer(store.get("brand_id")) or None,
        "archive_price_sar": archive_price,
        "expected_price_sar": expected_price,
        "price_basis": "saved_cny_formula" if formula_price is not None else "archive_price_only",
        "store_price_sar": _number(store.get("price")),
        "store_image_count": _integer(store.get("image_count")) if store.get("image_count") is not None else None,
        "match_basis": _text(store.get("_match_basis")),
        "store_fields_unavailable": "; ".join(unavailable_fields),
        "added_by": _text(archived.get("added_by")) or "غير محدد",
        "workflow_status": _text(archived.get("workflow_status") or archived.get("store_submission_status")) or "unknown",
        "status": status,
        "findings": findings,
    }
