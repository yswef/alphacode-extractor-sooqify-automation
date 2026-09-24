"""
Arabic: Blueprint لروابط الرفع والتوليد وأرشيف المنتجات.
English: Blueprint for upload, generation, and product-archive routes.
"""
import json
import logging
import os
import shutil
import uuid
from datetime import datetime
import threading

import requests
from flask import Blueprint, jsonify, request, send_from_directory

from app.core.runtime import paths_state
from app.core.utils import (
    compact_prompt_text,
    is_valid_marker,
    normalize_text,
    safe_bool,
    safe_float,
    safe_int,
    unique_text_values
)
from app.core.config import write_json_temp
from app.repositories.archive_repository import load_archive, save_archive
from app.repositories.sync_config_repository import load_sync_config
from app.services.sync_service import sync_push_product, sync_reserve_id, sync_reserve_key
from app.services.upload_service import (
    build_variant_fields,
    build_watch_variations_from_absolute_yuan,
    download_single_image,
    extract_settings,
    json_cell,
    resolve_store_images_for_upload,
    strip_existing_image_transform,
)

# Arabic: مساعدات المنتجات (الأرشيف، المجلدات، Excel، البراندات).
# English: Product helpers (archive, folders, Excel, brands).
from app.services.product_helpers import (
    HEADERS,
    MIN_REQUIRED_PRODUCT_IMAGES,
    build_pending_product,
    canonicalize_brand_name,
    commit_archive_excel,
    commit_transaction,
    create_filtered_excel_temp,
    create_temp_excel,
    clean_code_for_path,
    clean_folder_name,
    delete_product_folder,
    enforce_arabic_product_name,
    enforce_product_name_rules,
    find_archive_key_by_id,
    find_existing_product,
    find_product_by_id,
    get_brand_folder_name,
    get_next_id,
    get_product_image_dir,
    normalize_allowed_brands,
    parse_brand_map_json,
    rebuild_archive_metadata,
    resolve_allowed_brand,
    update_product_workflow_status,
)

# Arabic: مصدر الحقيقة الوحيد لفروقات الأحذية/الساعات (نظير extension/product_types.js).
# English: The single source of truth for shoes/watches differences (mirrors extension/product_types.js).
from app.services.product_type_profiles import (
    compute_product_type_price,
    get_profile,
    product_type_category_id,
    product_type_fee,
    product_type_sub_category_id,
    resolve_product_type,
)

logger = logging.getLogger(__name__)

upload_bp = Blueprint("upload_bp", __name__)
SAVE_LOCK = threading.RLock()


def _archive_entries(archive):
    return {
        key: value for key, value in archive.items()
        if not str(key).startswith("_") and isinstance(value, dict)
    }


# ---------------------------------------------------------------------------
# Routes — Dry Run & Extract
# ---------------------------------------------------------------------------

@upload_bp.route("/api/dry-run", methods=["POST"])
def dry_run_extract():
    """Arabic: محاكاة فحص المنتج دون أي كتابة على القرص. English: Simulate product validation without any disk writes."""
    data = request.get_json(silent=True) or {}
    settings = extract_settings(data)
    report = {
        "dry_run": True,
        "ts": datetime.now().isoformat(),
        "input_summary": {
            "name_en": compact_prompt_text(data.get("NameEN"), 100),
            "style_code": compact_prompt_text(data.get("StyleCode"), 40),
            "search_code": compact_prompt_text(data.get("SearchCode"), 40),
            "product_type": resolve_product_type(data.get("ProductType")),
            "original_price_yuan": data.get("OriginalPrice"),
            "image_count": len(data.get("Images") or []),
            "sizes_raw": data.get("Sizes"),
            "variants_raw": data.get("Variants"),
        },
        "settings_snapshot": {
            "ExchangeRate": settings.get("ExchangeRate"),
            "AddedFeeYuan": settings.get("AddedFeeYuan"),
            "WatchFlatFeeYuan": settings.get("WatchFlatFeeYuan"),
            "CategoryId": settings.get("CategoryId"),
            "WatchCategoryId": settings.get("WatchCategoryId"),
            "Stock": settings.get("Stock"),
        },
        "price_calculation": {},
        "sooqify_payload_preview": {},
        "validation_errors": [],
    }

    # Arabic: كان هذا المسار يحمل صيغة مستقلة للأحذية تعتمد `FeePercent` - وهو إعداد غير
    #         موجود أصلاً لا بالإكستنشن ولا بـextract_settings، فيؤول دايماً إلى 0 ويتجاهل
    #         AddedFeeYuan (250). النتيجة: dry-run يعرض سعراً أقل من المسار الفعلي
    #         (/api/extract) لكل حذاء. الآن الحساب يمر من المصدر الموحّد ويطابق الفعلي.
    # English: This path carried an independent shoes formula based on `FeePercent` - a
    #          setting that exists neither in the extension nor in extract_settings, so it
    #          always collapsed to 0 and ignored AddedFeeYuan (250). Result: dry-run reported
    #          a lower price than the real path (/api/extract) for every shoe. The
    #          computation now goes through the unified source and matches the real path.
    original_yuan = safe_float(data.get("OriginalPrice"), 0)
    exchange_rate = safe_float(settings.get("ExchangeRate"), 1)
    product_type = resolve_product_type(data.get("ProductType"))
    type_fee = product_type_fee(product_type, settings)

    computed = compute_product_type_price(original_yuan, product_type, settings)
    total_yuan = computed["price_after_fee"]
    price_sar = computed["price_sar"]

    report["price_calculation"] = {
        "original_yuan": original_yuan,
        "product_type": product_type,
        "type_fee_yuan": type_fee,
        "fee_setting_key": get_profile(product_type)["fee_setting_key"],
        "total_yuan_before_exchange": total_yuan,
        "exchange_rate": exchange_rate,
        "final_price_sar": price_sar,
    }

    sizes = unique_text_values(data.get("Sizes") if isinstance(data.get("Sizes"), list) else [])
    raw_variants = data.get("Variants") if isinstance(data.get("Variants"), list) else []
    watch_colors = []
    for v in raw_variants:
        if not isinstance(v, dict):
            continue
        clabel = normalize_text(str(v.get("color") or "")).strip()
        try:
            abs_p = float(v.get("price") or 0)
        except (TypeError, ValueError):
            abs_p = 0.0
        if clabel and abs_p > 0:
            watch_colors.append({"label": clabel, "_abs_price_yuan": abs_p})

    if watch_colors and get_profile(product_type)["has_color_variant_editor"]:
        variant_rows = [{"type": vc["label"], "price": round(vc["_abs_price_yuan"] * exchange_rate), "stock": settings.get("Stock", 10)} for vc in watch_colors]
    elif sizes:
        variant_rows = [{"type": s, "price": price_sar, "stock": settings.get("Stock", 10)} for s in sizes]
    else:
        variant_rows = [{"type": "Default", "price": price_sar, "stock": settings.get("Stock", 10)}]
        report["validation_errors"].append("No sizes or colors provided - using Default variant.")

    if not data.get("NameEN"):
        report["validation_errors"].append("NameEN is empty.")
    if original_yuan <= 0:
        report["validation_errors"].append("OriginalPrice is zero or missing.")

    report["sooqify_payload_preview"] = {
        "name": data.get("NameEN", ""),
        "description": data.get("DescriptionEN", ""),
        "price": price_sar,
        "category_id": product_type_category_id(product_type, settings),
        "sub_category_id": product_type_sub_category_id(product_type, settings),
        "variations": variant_rows,
        "total_stock": sum(v["stock"] for v in variant_rows),
        "image_count": len(data.get("Images") or []),
    }

    logger.info("DRY RUN | style=%s type=%s price_sar=%s variants=%s",
        data.get("StyleCode"), product_type, price_sar, len(variant_rows))
    return jsonify({"success": True, "report": report})


@upload_bp.route("/api/extract", methods=["POST"])
def extract_product():
    """Arabic: تنزيل الصور وحفظ Excel والأرشيف. English: Download images, commit Excel/archive, prep Sooqify."""
    if not paths_state.ROOT_DIR_CONFIGURED or not paths_state.is_root_dir_valid(paths_state.ROOT_DIR):
        return jsonify({
            "success": False,
            "needs_folder_setup": True,
            "error": "No save folder is configured yet. Choose one from the extension settings first.",
        }), 409
        
    data = request.get_json(silent=True) or {}
    settings = extract_settings(data)
    search_code = normalize_text(data.get("SearchCode"))
    style_code = normalize_text(data.get("StyleCode"))
    name_en = normalize_text(data.get("NameEN") or data.get("Name")) or "Unnamed Product"
    description_en = normalize_text(data.get("DescriptionEN") or data.get("Description"))
    name_ar = normalize_text(data.get("NameAR")) or name_en
    description_ar = normalize_text(data.get("DescriptionAR")) or description_en
    brand_map = parse_brand_map_json(settings.get("BrandMapJson"))
    allowed_store_brands = list(brand_map.keys()) or [settings["BrandName"]]
    brand_name = resolve_allowed_brand(
        data.get("BrandName"),
        settings["BrandName"],
        allowed_store_brands,
        f"{data.get('NameEN', '')} {data.get('NameAR', '')} {data.get('DescriptionEN', '')}",
    )
    brand_id = brand_map.get(brand_name, safe_int(data.get("BrandId"), settings["BrandId"]))
    sizes = unique_text_values(data.get("Sizes") if isinstance(data.get("Sizes"), list) else [])
    supplier_store_name = normalize_text(data.get("SupplierStoreName") or settings["SupplierStoreName"])
    supplier_store_id = normalize_text(data.get("SupplierStoreId") or settings["SupplierStoreId"])

    raw_images = data.get("Images") if isinstance(data.get("Images"), list) else []
    images, seen_images = [], set()
    for image_url in raw_images:
        normalized_url = strip_existing_image_transform(image_url)
        if not normalized_url or normalized_url in seen_images:
            continue
        seen_images.add(normalized_url)
        images.append(normalized_url)
        if len(images) >= settings["MaxImages"]:
            break
    if not images:
        return jsonify({"success": False, "error": "No product images were received."}), 400

    if len(images) < MIN_REQUIRED_PRODUCT_IMAGES:
        return jsonify({
            "success": False,
            "skipped_low_images": True,
            "image_count": len(images),
            "min_required_images": MIN_REQUIRED_PRODUCT_IMAGES,
            "error": f"تم تخطي المنتج: عدد صوره {len(images)} أقل من الحد الأدنى المطلوب ({MIN_REQUIRED_PRODUCT_IMAGES}).",
        }), 422

    store_image_limit = max(1, min(safe_int(data.get("StoreImageLimit"), 6), 6))
    selected_indexes = []
    supplied_selection = data.get("SelectedImageIndexes") if isinstance(data.get("SelectedImageIndexes"), list) else []
    for value in supplied_selection:
        index = safe_int(value, -1)
        if 0 <= index < len(images) and index not in selected_indexes:
            selected_indexes.append(index)

    main_image_index = safe_int(data.get("MainImageIndex"), selected_indexes[0] if selected_indexes else 0)
    if not 0 <= main_image_index < len(images):
        main_image_index = selected_indexes[0] if selected_indexes else 0

    if not selected_indexes:
        selected_indexes = list(range(min(store_image_limit, len(images))))
    if main_image_index in selected_indexes:
        selected_indexes.remove(main_image_index)
    selected_indexes.insert(0, main_image_index)
    selected_indexes = selected_indexes[:store_image_limit]

    # Arabic: "ماذا نرفع للمتجر" و"ماذا ننزّل محلياً" سؤالان مختلفان، وكان الكود يربطهما
    #         بـ`and not UploadMainImageOnly`. وبما أن UploadMainImageOnly مفعّل افتراضياً
    #         منذ v5.0.0، كان download_selected_only يساوي False دائماً - أي أن خيار
    #         "نزّل الصور المختارة فقط" كان معطّلاً فعلياً ولا يمكن تفعيله إطلاقاً، فتُنزَّل
    #         كل صور كل منتج دائماً. هذا سبب استهلاك النت العالي الذي أبلغ عنه المستخدم.
    #         الآن يُحترم الخيار كما هو.
    # English: "what to upload to the store" and "what to download locally" are two different
    #          questions, and the code tied them together with `and not UploadMainImageOnly`.
    #          Since UploadMainImageOnly has defaulted to on since v5.0.0, download_selected_only
    #          was always False - the "download selected images only" option was effectively
    #          dead and could never be switched on, so every image of every product was always
    #          downloaded. That is the heavy bandwidth use the operator reported. The option is
    #          now honoured on its own.
    download_selected_only = safe_bool(
        data.get("DownloadSelectedImagesOnly"),
        settings["DownloadSelectedImagesOnly"],
    )

    # Arabic: صور استبعدها المستخدم صراحةً - لا تُنزَّل ولا تُرفع إطلاقاً.
    # English: Images the operator explicitly excluded - never downloaded, never uploaded.
    excluded_indexes = {
        int(index)
        for index in (data.get("ExcludedImageIndexes") or [])
        if isinstance(index, (int, float, str)) and str(index).strip().lstrip("-").isdigit()
    }

    download_indexes = selected_indexes if download_selected_only else list(range(len(images)))
    download_indexes = [index for index in download_indexes if index not in excluded_indexes]
    download_plan = [(index, images[index]) for index in download_indexes if 0 <= index < len(images)]

    sync_config = load_sync_config()
    added_by = sync_config["AddedByName"] or "غير محدد"
    dedup_key = search_code if is_valid_marker(search_code) else (style_code if is_valid_marker(style_code) else "")

    with SAVE_LOCK:
        archive = load_archive(paths_state.ARCHIVE_PATH)
        existing = find_existing_product(archive, search_code, style_code)
        if existing:
            return jsonify({
                "success": False,
                "exists": True,
                "id": existing.get("id"),
                "workflow_status": existing.get("workflow_status") or "prepared",
                "store_submission_status": existing.get("store_submission_status") or "not_submitted",
                "error": "This product already exists in the archive.",
            }), 409

        reserved_ok, conflict_item, reserve_error = sync_reserve_key(dedup_key, added_by)
        if not reserved_ok and conflict_item:
            return jsonify({
                "success": False,
                "exists": True,
                "remote_conflict": True,
                "id": conflict_item.get("id"),
                "added_by": conflict_item.get("added_by"),
                "error": "This product was just reserved or added by the other user.",
            }), 409

        next_id = sync_reserve_id()
        id_source = "remote"
        if next_id is None:
            next_id = get_next_id(archive)
            id_source = "local_fallback"

        transaction_id = uuid.uuid4().hex
        today_str = datetime.now().strftime("%Y-%m-%d")
        identifier = search_code if is_valid_marker(search_code) else style_code
        folder_base = clean_folder_name(name_en, identifier or next_id)
        folder_suffix = clean_code_for_path(identifier or f"ID-{next_id}")
        final_folder_name = f"{folder_base}__{folder_suffix}"[:115].rstrip(" .")
        brand_folder_name = get_brand_folder_name(brand_name)
        date_folder_name = today_str
        date_dir = os.path.join(paths_state.BASE_DIR, date_folder_name)
        final_product_folder = os.path.join(date_dir, final_folder_name)
        os.makedirs(date_dir, exist_ok=True)
        temp_root = os.path.join(paths_state.BASE_DIR, ".alphacode_tmp")
        os.makedirs(temp_root, exist_ok=True)
        temp_product_folder = os.path.join(temp_root, transaction_id)
        os.makedirs(temp_product_folder, exist_ok=False)

        local_images, downloaded_image_records, failed_images = [], [], []
        total_download_bytes = 0
        session = requests.Session()
        session.headers.update(HEADERS)
        logger.info(
            "Starting product transaction id=%s, search_code=%s, style_code=%s, images=%s",
            next_id, search_code or "NONE", style_code or "NONE", len(images),
        )
        try:
            for sequence_number, (source_index, image_url) in enumerate(download_plan, start=1):
                base_name = f"{today_str}-{uuid.uuid4().hex[:12]}"
                try:
                    downloaded_bytes, image_name, _ = download_single_image(
                        session,
                        image_url,
                        temp_product_folder,
                        base_name,
                        settings,
                        source_index + 1,
                    )
                    total_download_bytes += downloaded_bytes
                    local_images.append(image_name)
                    downloaded_image_records.append({"source_index": source_index, "name": image_name})
                except Exception as exc:
                    failed_images.append({
                        "index": source_index + 1,
                        "sequence": sequence_number,
                        "url": image_url,
                        "error": str(exc),
                    })
                    logger.error("Image source index %s could not be downloaded: %s", source_index + 1, exc)
            if settings["RequireAllImages"] and failed_images:
                raise RuntimeError(
                    f"{len(failed_images)} of {len(download_plan)} planned images could not be downloaded. Nothing was saved."
                )
            if not local_images:
                raise RuntimeError("No image could be downloaded. Nothing was saved.")

            style_code_txt_path = os.path.join(temp_product_folder, "style_code.txt")
            with open(style_code_txt_path, "w", encoding="utf-8") as style_file:
                style_file.write(f"Style Code: {style_code or '-'}\n")
                style_file.write(f"Search Code: {search_code or '-'}\n")
                style_file.write(f"Product ID: {next_id}\n")

            downloaded_by_index = {item["source_index"]: item["name"] for item in downloaded_image_records}
            store_images = [downloaded_by_index[index] for index in selected_indexes if index in downloaded_by_index]
            if not store_images:
                store_images = local_images[:store_image_limit]
            store_images = resolve_store_images_for_upload(
                store_images,
                selected_indexes,
                main_image_index,
                bool(settings["UploadMainImageOnly"]),
            )
            store_main_image = store_images[0] if store_images else ""
            logger.info(
                "Store image selection prepared. id=%s selected=%s main=%s all_downloaded=%s",
                next_id, store_images, store_main_image, len(local_images),
            )

            raw_variants = data.get("Variants") if isinstance(data.get("Variants"), list) else []
            watch_colors = []
            for v in raw_variants:
                if not isinstance(v, dict):
                    continue
                clabel = normalize_text(str(v.get("color") or "")).strip()
                try:
                    abs_price = float(v.get("price") or 0)
                except (TypeError, ValueError):
                    abs_price = 0.0
                if clabel and abs_price > 0:
                    watch_colors.append({"label": clabel, "_abs_price_yuan": abs_price})

            # Arabic: مسار ألوان الساعات لا يعمل إلا لو النوع يستخدم خاصية خيارات أصلاً.
            #         حالياً الساعات بلا خاصية (بطلب المستخدم) فيسقط للمسار العادي الذي
            #         يُرجع منتجاً بسعر واحد بلا Variations.
            # English: The watch-colour path only applies when the type uses a variant attribute
            #          at all. Watches currently use none (per the operator's request), so this
            #          falls through to the normal path, which yields a single-price product
            #          with no Variations.
            if (
                watch_colors
                and get_profile(settings["ProductType"])["has_color_variant_editor"]
                and get_profile(settings["ProductType"])["uses_variant_attribute"]
            ):
                variations, choice_options, attributes, total_stock, variant_price_rows = (
                    build_watch_variations_from_absolute_yuan(
                        watch_colors, settings, data.get("OriginalPrice"),
                    )
                )
            else:
                variations, choice_options, attributes, total_stock = build_variant_fields(
                    sizes, data.get("WatchColors"), data.get("PriceSAR"),
                    settings["Stock"], settings, settings["ProductType"], data.get("OriginalPrice"),
                )
                variant_price_rows = json.loads(variations)
            # Arabic: الفئة والفئة الفرعية الفعليتان من المصدر الموحّد بدل شرط مكرر هنا.
            # English: Effective category/subcategory from the unified source instead of a
            #          duplicated condition here.
            effective_category_id = product_type_category_id(settings["ProductType"], settings)
            effective_subcategory_id = product_type_sub_category_id(settings["ProductType"], settings)
            new_row = {
                "Id": next_id,
                "Name": name_en,
                "Description": description_en,
                "Image": store_main_image,
                "CategoryId": effective_category_id,
                "SubCategoryId": effective_subcategory_id,
                "UnitId": settings["UnitId"],
                "Stock": total_stock,
                "Price": data.get("PriceSAR"),
                "Discount": settings["Discount"],
                "DiscountType": settings["DiscountType"],
                "AvailableTimeStarts": settings["AvailableTimeStarts"],
                "AvailableTimeEnds": settings["AvailableTimeEnds"],
                "Variations": variations,
                "ChoiceOptions": choice_options,
                "AddOns": "[]",
                "Attributes": attributes,
                "StoreId": settings["StoreId"],
                "ModuleId": settings["ModuleId"],
                "Status": settings["Status"],
                "Veg": settings["Veg"],
                "Recommended": settings["Recommended"],
            }
            archive_key = dedup_key or f"ID_{next_id}"
            settings_for_store = {
                "StoreId": settings["StoreId"],
                "CategoryId": effective_category_id,
                "SubCategoryId": effective_subcategory_id,
                "UnitId": settings["UnitId"],
                "Stock": settings["Stock"],
                "Discount": settings["Discount"],
                "DiscountType": settings["DiscountType"],
                "AvailableTimeStarts": settings["AvailableTimeStarts"],
                "AvailableTimeEnds": settings["AvailableTimeEnds"],
                "MaximumCartQuantity": settings["MaximumCartQuantity"],
                "Veg": settings["Veg"],
                "SizeAttributeId": settings["SizeAttributeId"],
                "SizeChoiceNo": settings["SizeChoiceNo"],
                "SizeactualChoiceNo": settings["SizeactualChoiceNo"],
                "SizeTitle": settings["SizeTitle"],
                "WatchColorAttributeId": settings["WatchColorAttributeId"],
                "WatchColorTitle": settings["WatchColorTitle"],
                "ProductType": settings["ProductType"],
                "DefaultLanguage": settings["DefaultLanguage"],
                "DownloadSelectedImagesOnly": download_selected_only,
            }
            archive_item = {
                "id": next_id,
                "product_type": settings["ProductType"],
                "name": name_en,
                "description": description_en,
                "name_en": name_en,
                "description_en": description_en,
                "name_ar": name_ar,
                "description_ar": description_ar,
                "brand_name": brand_name,
                "brand_id": brand_id,
                "style_code": style_code,
                "search_code": search_code,
                "price": data.get("PriceSAR"),
                "variants": variant_price_rows,
                "sizes": (
                    [row["type"] for row in variant_price_rows]
                    if get_profile(settings["ProductType"])["has_color_variant_editor"]
                    else sizes
                ),
                "date": today_str,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "workflow_status": "prepared",
                "store_submission_status": "not_submitted",
                "folder": final_folder_name,
                "brand_folder": brand_folder_name,
                "date_folder": date_folder_name,
                "added_by": added_by,
                "id_source": id_source,
                "upload_main_image_only": settings["UploadMainImageOnly"],
                "images": local_images,
                "store_images": store_images,
                "store_main_image": store_main_image,
                "selected_image_indexes": selected_indexes,
                "download_selected_images_only": download_selected_only,
                "source_image_count": len(images),
                "downloaded_image_count": len(local_images),
                "source_url": normalize_text(data.get("SourceUrl")),
                "supplier_store_name": supplier_store_name,
                "supplier_store_id": supplier_store_id,
                "settings": settings_for_store,
            }
            updated_archive = dict(archive)
            updated_archive[archive_key] = archive_item
            if is_valid_marker(search_code):
                updated_archive["_last_added_code"] = search_code
            updated_archive["_last_added_id"] = next_id

            temp_excel = create_temp_excel(new_row, transaction_id)
            temp_archive = write_json_temp(paths_state.ARCHIVE_PATH, updated_archive, transaction_id)
            commit_transaction(temp_product_folder, final_product_folder, temp_excel, temp_archive, transaction_id)
            threading.Thread(target=sync_push_product, args=(archive_key, archive_item), daemon=True).start()
            pending_product = build_pending_product(next_id, archive_item)
            logger.info(
                "Product saved successfully. id=%s, downloaded=%s/%s, source_images=%s, selected_only=%s, transferred_bytes=%s",
                next_id, len(local_images), len(download_plan), len(images), download_selected_only, total_download_bytes,
            )
            return jsonify({
                "success": True,
                "id": next_id,
                "folder": final_product_folder,
                "source_images": len(images),
                "requested_images": len(download_plan),
                "downloaded_images": len(local_images),
                "download_selected_only": download_selected_only,
                "download_mode": "selected_only" if download_selected_only else "all_source_images",
                "failed_images": failed_images,
                "image_names": local_images,
                "store_image_names": store_images,
                "store_main_image": store_main_image,
                "transferred_bytes": total_download_bytes,
                "pending_product": pending_product,
            })
        except Exception as exc:
            logger.exception("Product transaction failed: %s", exc)
            shutil.rmtree(temp_product_folder, ignore_errors=True)
            return jsonify({"success": False, "error": str(exc), "failed_images": failed_images}), 500


# ---------------------------------------------------------------------------
# Routes — Archive Queries
# ---------------------------------------------------------------------------

@upload_bp.route("/api/check", methods=["POST"])
def check_product():
    """Arabic: فحص وجود المنتج في الأرشيف قبل التنزيل. English: Check archive for duplicate before downloading."""
    data = request.get_json(silent=True) or {}
    archive = load_archive(paths_state.ARCHIVE_PATH)
    existing = find_existing_product(archive, data.get("SearchCode"), data.get("StyleCode"))
    entries = _archive_entries(archive)
    response = {
        "exists": bool(existing),
        "last_id": max([safe_int(item.get("id"), 0) for item in entries.values()] or [0]),
        "last_added_code": archive.get("_last_added_code"),
    }
    if existing:
        response["id"] = existing.get("id")
        response["workflow_status"] = existing.get("workflow_status") or "prepared"
        response["store_submission_status"] = existing.get("store_submission_status") or "not_submitted"
        response["image_count"] = len(existing.get("images") or [])
        response["supplier_store_name"] = existing.get("supplier_store_name")
    return jsonify(response)


@upload_bp.route("/api/archive/product/<int:product_id>", methods=["GET"])
def get_archived_product(product_id):
    """Arabic: استرجاع بيانات المنتج بالـ ID المحلي. English: Retrieve product by local ID."""
    product = find_product_by_id(load_archive(paths_state.ARCHIVE_PATH), product_id)
    if not product:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    return jsonify({"success": True, "product": product})


@upload_bp.route("/api/archive/last", methods=["GET"])
def get_last_archived_product():
    """Arabic: إعادة آخر منتج أُضيف مع رابط المورد وكود البحث. English: Return last added product."""
    archive = load_archive(paths_state.ARCHIVE_PATH)
    entries = list(_archive_entries(archive).values())
    if not entries:
        return jsonify({"success": False, "error": "No archived product is available."}), 404
    product = max(entries, key=lambda item: safe_int(item.get("id"), 0))
    return jsonify({
        "success": True,
        "product": {
            "id": safe_int(product.get("id"), 0),
            "search_code": normalize_text(product.get("search_code")),
            "style_code": normalize_text(product.get("style_code")),
            "source_url": normalize_text(product.get("source_url")),
            "name_en": normalize_text(product.get("name_en") or product.get("name")),
            "workflow_status": normalize_text(product.get("workflow_status")) or "prepared",
            "store_submission_status": normalize_text(product.get("store_submission_status")) or "not_submitted",
        },
    })


@upload_bp.route("/api/archive/stats", methods=["GET"])
def get_archive_stats():
    """Arabic: إحصاءات الأرشيف لإدارة البيانات. English: Return archive stats for data management."""
    archive = load_archive(paths_state.ARCHIVE_PATH)
    entries = {key: item for key, item in _archive_entries(archive).items() if item.get("id") is not None}
    image_count = sum(len(item.get("images") or []) for item in entries.values())
    return jsonify({
        "success": True,
        "products": len(entries),
        "images": image_count,
        "last_id": max([safe_int(item.get("id"), 0) for item in entries.values()] or [0]),
        "archive_path": paths_state.ARCHIVE_PATH,
        "excel_path": paths_state.EXCEL_PATH,
        "image_root": paths_state.BASE_DIR if paths_state.ROOT_DIR_CONFIGURED else "",
        "root_configured": paths_state.ROOT_DIR_CONFIGURED,
    })


@upload_bp.route("/api/archive/recent", methods=["GET"])
def get_recent_products():
    """Arabic: شاشة تشخيص صغيرة للمنتجات المضافة حديثاً. English: Small diagnostics view of recently added products."""
    limit = max(1, min(safe_int(request.args.get("limit"), 15), 100))
    archive = load_archive(paths_state.ARCHIVE_PATH)
    entries = [item for item in _archive_entries(archive).values() if item.get("id") is not None]
    entries.sort(key=lambda item: safe_int(item.get("id"), 0), reverse=True)
    recent = [
        {
            "id": item.get("id"),
            "name_en": item.get("name_en") or item.get("name"),
            "brand_name": item.get("brand_name"),
            "brand_folder": item.get("brand_folder"),
            "added_by": item.get("added_by") or "غير محدد",
            "id_source": item.get("id_source") or "local_fallback",
            "created_at": item.get("created_at"),
            "workflow_status": item.get("workflow_status"),
        }
        for item in entries[:limit]
    ]
    return jsonify({"success": True, "products": recent})


@upload_bp.route("/api/pending/latest", methods=["GET"])
def get_latest_pending_product():
    """Arabic: إعادة آخر منتج مجهز وتغليفه بالفرونت إند. English: Return latest prepared product for form autofill."""
    archive = load_archive(paths_state.ARCHIVE_PATH)
    entries = list(_archive_entries(archive).values())
    if not entries:
        return jsonify({"success": False, "error": "No prepared product is available."}), 404
    product = max(entries, key=lambda item: safe_int(item.get("id"), 0))
    product_id = safe_int(product.get("id"), 0)
    return jsonify({"success": True, "pending_product": build_pending_product(product_id, product)})


@upload_bp.route("/api/pending/<int:product_id>", methods=["GET"])
def get_pending_product(product_id):
    """Arabic: إعادة حزمة التعبئة المباشرة للوحة المتجر. English: Return form autofill package by ID."""
    product = find_product_by_id(load_archive(paths_state.ARCHIVE_PATH), product_id)
    if not product:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    return jsonify({"success": True, "pending_product": build_pending_product(product_id, product)})


@upload_bp.route("/api/product-images/<int:product_id>/<path:filename>", methods=["GET"])
def serve_product_image(product_id, filename):
    """Arabic: تقديم صورة محلية للإضافة عبر HTTP. English: Serve a local image via HTTP without exposing paths."""
    product = find_product_by_id(load_archive(paths_state.ARCHIVE_PATH), product_id)
    if not product:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    safe_filename = os.path.basename(filename)
    if safe_filename not in (product.get("images") or []):
        return jsonify({"success": False, "error": "Image is not registered for this product."}), 404
    folder_path = get_product_image_dir(product)
    return send_from_directory(folder_path, safe_filename, as_attachment=False)


@upload_bp.route("/api/archive/product/<int:product_id>/status", methods=["POST"])
def set_archived_product_status(product_id):
    """Arabic: تحديث حالة المنتج عند بدء/نجاح الإرسال. English: Update product status when store submission starts/ends."""
    data = request.get_json(silent=True) or {}
    try:
        item = update_product_workflow_status(product_id, data.get("status"), data.get("details"))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    if not item:
        return jsonify({"success": False, "error": "Product ID was not found."}), 404
    logger.info("Product workflow status updated. id=%s status=%s", product_id, item.get("workflow_status"))
    return jsonify({"success": True, "product": item})


@upload_bp.route("/api/archive/product/<int:product_id>", methods=["DELETE"])
def delete_archived_product(product_id):
    """Arabic: حذف سجل واحد من JSON وExcel مع خيار حذف صوره. English: Delete one product from JSON/Excel and optionally images."""
    data = request.get_json(silent=True) or {}
    delete_images = safe_bool(data.get("delete_images"), False)
    with SAVE_LOCK:
        archive = load_archive(paths_state.ARCHIVE_PATH)
        key = find_archive_key_by_id(archive, product_id)
        if not key:
            return jsonify({"success": False, "error": "Product ID was not found."}), 404
        product = archive[key]
        updated = dict(archive)
        updated.pop(key, None)
        updated = rebuild_archive_metadata(updated)
        token = uuid.uuid4().hex
        temp_archive = write_json_temp(paths_state.ARCHIVE_PATH, updated, token)
        temp_excel = create_filtered_excel_temp([product_id], token)
        try:
            commit_archive_excel(temp_archive, temp_excel, token)
            images_deleted = delete_product_folder(product) if delete_images else False
            logger.info("Product deleted. id=%s delete_images=%s", product_id, delete_images)
            return jsonify({"success": True, "id": product_id, "delete_images": delete_images, "images_deleted": images_deleted})
        except Exception as exc:
            logger.exception("Could not delete product id=%s: %s", product_id, exc)
            return jsonify({"success": False, "error": str(exc)}), 500


@upload_bp.route("/api/archive/clear", methods=["POST"])
def clear_archive_data():
    """Arabic: مسح جميع المنتجات من JSON وExcel. English: Clear all product data with optional image deletion."""
    data = request.get_json(silent=True) or {}
    delete_images = safe_bool(data.get("delete_images"), False)
    with SAVE_LOCK:
        archive = load_archive(paths_state.ARCHIVE_PATH)
        products = list(_archive_entries(archive).values())
        token = uuid.uuid4().hex
        temp_archive = write_json_temp(paths_state.ARCHIVE_PATH, {}, token)
        temp_excel = create_filtered_excel_temp([], token, clear_all=True)
        try:
            commit_archive_excel(temp_archive, temp_excel, token)
            deleted_folders = 0
            image_errors = []
            if delete_images:
                for product in products:
                    try:
                        if delete_product_folder(product):
                            deleted_folders += 1
                    except Exception as exc:
                        image_errors.append(str(exc))
            logger.info("Archive cleared. products=%s images=%s", len(products), delete_images)
            return jsonify({
                "success": True,
                "products_deleted": len(products),
                "folders_deleted": deleted_folders,
                "image_errors": image_errors,
            })
        except Exception as exc:
            logger.exception("Could not clear archive: %s", exc)
            return jsonify({"success": False, "error": str(exc)}), 500
