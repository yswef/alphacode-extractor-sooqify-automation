"""Arabic: إعدادات الاستخراج، الصور، ومتغيرات المتجر. English: Extract settings, images, and store variant rows."""
import json
import logging
import os
import time
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit

from PIL import Image, ImageOps

# Arabic: مصدر الحقيقة الوحيد لفروقات الأحذية/الساعات (نظير extension/product_types.js).
# English: The single source of truth for shoes/watches differences (mirrors extension/product_types.js).
from app.services.product_type_profiles import (
    get_profile,
    product_type_variant_attribute_id,
    product_type_variant_title,
    resolve_product_type,
)

logger = logging.getLogger("alphacode")

# Arabic: نفس القيم الافتراضية في app.py (الثوابت نفسها لم تُنقل). English: Same defaults as app.py (those constants were not moved).


def _normalize_text(value):
    """Arabic: توحيد النصوص قبل التخزين أو المقارنة. English: Normalize text before storage or comparison."""
    return str(value or "").strip()


def _safe_int(value, fallback):
    """Arabic: تحويل آمن إلى عدد صحيح. English: Safely coerce a value to integer."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return int(fallback)


def _safe_float(value, fallback):
    """Arabic: تحويل آمن إلى عدد عشري. English: Safely coerce a value to float."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def _safe_bool(value, fallback=False):
    """Arabic: قراءة القيم المنطقية القادمة من JavaScript. English: Parse boolean-like values received from JavaScript."""
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _unique_text_values(values):
    """Arabic: إزالة القيم المكررة مع المحافظة على ترتيبها. English: Deduplicate text values while preserving order."""
    result = []
    seen = set()
    for value in values or []:
        normalized = _normalize_text(value)
        key = normalized.casefold()
        if not normalized or key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def extract_settings(data):
    """Arabic: قراءة جميع الإعدادات مع قيم آمنة للمتاجر المستقبلية. English: Read all settings with safe defaults for future stores."""
    settings = data.get("Settings") if isinstance(data.get("Settings"), dict) else data
    return {
        "ProductType": resolve_product_type(_normalize_text(settings.get("ProductType"))),
        "CategoryId": _safe_int(settings.get("CategoryId"), 41),
        "SubCategoryId": _safe_int(settings.get("SubCategoryId"), 42),
        # Arabic: فئة الساعات (Timepieces) بدون فئة فرعية. English: The watches category (Timepieces), with no subcategory.
        "WatchCategoryId": _safe_int(settings.get("WatchCategoryId"), 46),
        # Arabic: رسم ثابت باليوان يُضاف لكل ساعة بلا استثناء (يحل محل فكرة الدرجة الأولى/الثانية). English: A flat CNY fee added to every watch with no exception (replaces the earlier grade-1/grade-2 idea).
        "WatchFlatFeeYuan": _safe_float(settings.get("WatchFlatFeeYuan"), 600),
        "WatchColorAttributeId": _safe_int(settings.get("WatchColorAttributeId"), 2),
        "WatchColorTitle": _normalize_text(settings.get("WatchColorTitle")) or "اللون",
        "UnitId": _safe_int(settings.get("UnitId"), 1),
        "Stock": max(0, _safe_int(settings.get("Stock"), 100)),
        "ExchangeRate": _safe_float(settings.get("ExchangeRate"), 0.5),
        "AddedFeeYuan": _safe_float(settings.get("AddedFeeYuan"), 250),
        "Discount": _safe_float(settings.get("Discount"), 0),
        "DiscountType": _normalize_text(settings.get("DiscountType")) or "percent",
        "AvailableTimeStarts": _normalize_text(settings.get("AvailableTimeStarts")) or "00:00:00",
        "AvailableTimeEnds": _normalize_text(settings.get("AvailableTimeEnds")) or "23:59:59",
        "MaximumCartQuantity": _normalize_text(settings.get("MaximumCartQuantity")),
        "StoreId": _safe_int(settings.get("StoreId"), 3),
        "ModuleId": _safe_int(settings.get("ModuleId"), 2),
        "Status": _normalize_text(settings.get("Status")) or "active",
        "Veg": _normalize_text(settings.get("Veg")) or "no",
        "Recommended": _normalize_text(settings.get("Recommended")) or "yes",
        "BrandId": _safe_int(settings.get("BrandId"), 6),
        "BrandName": _normalize_text(settings.get("BrandName")) or "Air Jordan",
        "BrandMapJson": _normalize_text(settings.get("BrandMapJson")) or '{"Air Jordan":6}',
        "SizeAttributeId": max(1, _safe_int(settings.get("SizeAttributeId"), 1)),
        "SizeChoiceNo": max(1, _safe_int(
            settings.get("SizeChoiceNo", settings.get("SizeactualChoiceNo")),
            1,
        )),
        "SizeactualChoiceNo": max(1, _safe_int(
            settings.get("SizeChoiceNo", settings.get("SizeactualChoiceNo")),
            1,
        )),
        "SizeTitle": _normalize_text(settings.get("SizeTitle")) or "الحجم",
        "DefaultLanguage": _normalize_text(settings.get("DefaultLanguage")).lower() or "en",
        "SupplierStoreName": _normalize_text(settings.get("SupplierStoreName")),
        "SupplierStoreId": _normalize_text(settings.get("SupplierStoreId")),
        "ImageMaxDimension": max(300, min(_safe_int(settings.get("ImageMaxDimension"), 1200), 3000)),
        "ImageQuality": max(35, min(_safe_int(settings.get("ImageQuality"), 75), 95)),
        "ImageFormat": _normalize_text(settings.get("ImageFormat")).lower() or "jpeg",
        "OptimizeImageAtSource": _safe_bool(settings.get("OptimizeImageAtSource"), True),
        "RequireAllImages": _safe_bool(settings.get("RequireAllImages"), True),
        "MaxImages": max(1, min(_safe_int(settings.get("MaxImages"), 30), 100)),
        "AIBaseUrl": _normalize_text(settings.get("AIBaseUrl")),
        "OfficialResearchOnRegenerate": _safe_bool(settings.get("OfficialResearchOnRegenerate"), True),
        "DownloadSelectedImagesOnly": _safe_bool(settings.get("DownloadSelectedImagesOnly"), False),
        # Arabic: عند التفعيل - يُرفع للمتجر الصورة الرئيسية فقط، وتُحفظ كل الصور محلياً كما هي (دون تصغير أو تربيع أو ضغط).
        # English: When enabled - only the main image is submitted to the store, and every image is saved locally untouched (no resize/square/compression).
        "UploadMainImageOnly": _safe_bool(settings.get("UploadMainImageOnly"), False),
    }


def normalize_image_format(value):
    """Arabic: فرض JPEG عند استقبال WebP لأن المتجر الحالي لا يدعمه. English: Force JPEG when WebP is requested because the current store rejects it."""
    aliases = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "jpeg"}
    return aliases.get(_normalize_text(value).lower(), "jpeg")


def strip_existing_image_transform(url):
    """Arabic: إزالة تحويل imageMogr2 القديم فقط. English: Remove only an existing imageMogr2 transform."""
    url = _normalize_text(url).replace("\\/", "/")
    if not url or "?" not in url:
        return url
    base, query = url.split("?", 1)
    parts = [part for part in query.split("&") if part and not part.lower().startswith("imagemogr2")]
    return f"{base}?{'&'.join(parts)}" if parts else base


def build_optimized_image_url(raw_url, settings):
    """Arabic: طلب نسخة JPEG مصغرة من CDN قبل تنزيلها لتقليل الإنترنت. English: Request a smaller JPEG from the CDN before download to reduce bandwidth."""
    source_url = strip_existing_image_transform(raw_url)
    # Arabic: وضع "الصورة الرئيسية فقط" يحفظ الصور الأصلية بجودتها الكاملة، فلا داعي لأي تحويل من الـ CDN.
    # English: "Main image only" mode saves originals at full quality, so no CDN transform is requested at all.
    if not settings["OptimizeImageAtSource"] or settings.get("UploadMainImageOnly"):
        return source_url
    try:
        parsed = urlsplit(source_url)
    except ValueError:
        return source_url
    if parsed.hostname not in {"xcimg.szwego.com", "img.szwego.com"}:
        return source_url
    transform = (
        f"imageMogr2/thumbnail/{settings['ImageMaxDimension']}x{settings['ImageMaxDimension']}>"
        f"/quality/{settings['ImageQuality']}/format/{normalize_image_format(settings['ImageFormat'])}"
    )
    query = f"{parsed.query}&{transform}" if parsed.query else transform
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


def sniff_image_extension(content):
    """Arabic: تحديد امتداد الصورة الحقيقي من أول بايتات الملف دون أي تحويل. English: Detect the real image extension from the file's leading bytes, no conversion involved."""
    if content[:3] == b"\xff\xd8\xff":
        return "jpg"
    if content[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return "jpg"


def get_dominant_bg_color(img):
    """جلب متوسّط لون الخلفية من زوايا الصورة الأربع"""
    # تحويل لـ RGB لضمان استخراج القيم ثلاثية (R, G, B)
    rgb_img = img.convert("RGB")
    w, h = rgb_img.size

    # أخذ عينات من الزوايا الأربع
    corners = [
        rgb_img.getpixel((0, 0)),  # أعلى اليسار
        rgb_img.getpixel((w - 1, 0)),  # أعلى اليمين
        rgb_img.getpixel((0, h - 1)),  # أسفل اليسار
        rgb_img.getpixel((w - 1, h - 1)),  # أسفل اليمين
    ]

    # حساب متوسط ألوان RGB للزوايا
    r = sum(c[0] for c in corners) // 4
    g = sum(c[1] for c in corners) // 4
    b = sum(c[2] for c in corners) // 4

    return (r, g, b)


def prepare_image_for_save(content, output_path, settings):
    """Arabic: تصغير الصورة وجعلها مربعة 1:1 مع ضغط ممتاز دون فقدان الجودة

    الملحوظة محلياً واستخراج لون الخلفية تلقائياً. English: Resize, convert to
    a centered 1:1 square canvas with auto background detection.
    """
    output_format = normalize_image_format(settings["ImageFormat"])
    max_dim = settings["ImageMaxDimension"]  # المقاس المربع المطلوب

    with Image.open(BytesIO(content)) as source_image:
        # 1. تصحيح اتجاه الصورة من الـ EXIF
        source_image = ImageOps.exif_transpose(source_image)

        # 2. استخراج لون الخلفية تلقائياً من زوايا الصورة الأصلية
        bg_color = get_dominant_bg_color(source_image)

        # 3. معالجة الشفافية وتحويل الألوان إلى RGB باستخدام لون الخلفية المكتشف
        if source_image.mode in {"RGBA", "LA"} or (
            source_image.mode == "P" and "transparency" in source_image.info
        ):
            rgba = source_image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, bg_color + (255,))
            background.paste(rgba, mask=rgba.getchannel("A"))
            source_image = background.convert("RGB")
        else:
            source_image = source_image.convert("RGB")

        # 4. تصغير الصورة مع الحفاظ على النسب الأصلية (دون تشويه)
        source_image.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)

        # 5. إنشاء القماش المربع بنفس لون الخلفية المكتشف تلقائياً
        square_canvas = Image.new("RGB", (max_dim, max_dim), bg_color)

        # 6. توسيط الصورة داخل القماش المربع (Padding)
        offset_x = (max_dim - source_image.width) // 2
        offset_y = (max_dim - source_image.height) // 2
        square_canvas.paste(source_image, (offset_x, offset_y))

        # 7. حفظ الصورة وضغطها بأعلى كفاءة
        if output_format == "png":
            square_canvas.save(
                output_path, "PNG", optimize=True, compress_level=9
            )
        else:
            quality_val = max(
                75, min(_safe_int(settings.get("ImageQuality"), 85), 95)
            )
            square_canvas.save(
                output_path,
                "JPEG",
                quality=quality_val,
                optimize=True,
                progressive=True,
            )

def download_single_image(session, raw_url, output_dir, base_name, settings, image_number):
    """
    Arabic: تنزيل صورة مع ثلاث محاولات والرجوع للرابط الأصلي. في وضع "الصورة الرئيسية فقط"
    تُحفظ البايتات كما وصلت تماماً دون أي تصغير أو تربيع أو ضغط، بامتداد يُكتشف من محتوى الملف.
    English: Download one image with retries and original-URL fallback. In "main image only"
    mode the bytes are saved exactly as received - no resize/square/compression - with an
    extension detected from the file content itself.
    Returns: (bytes_downloaded, final_filename, source_url_used)
    """
    raw_mode = bool(settings.get("UploadMainImageOnly"))
    original_url = strip_existing_image_transform(raw_url)
    if raw_mode:
        candidate_urls = [original_url]
    else:
        optimized_url = build_optimized_image_url(raw_url, settings)
        candidate_urls = [optimized_url] + ([original_url] if optimized_url != original_url else [])

    last_error = "Unknown download error"
    for candidate_index, candidate_url in enumerate(candidate_urls):
        for attempt in range(1, 4):
            try:
                response = session.get(candidate_url, timeout=(10, 30), stream=True)
                response.raise_for_status()
                content = response.content
                if not content:
                    raise ValueError("The image response was empty")

                if raw_mode:
                    extension = sniff_image_extension(content)
                    final_name = f"{base_name}.{extension}"
                    with open(os.path.join(output_dir, final_name), "wb") as raw_file:
                        raw_file.write(content)
                else:
                    output_format = normalize_image_format(settings["ImageFormat"])
                    extension = "png" if output_format == "png" else "jpg"
                    final_name = f"{base_name}.{extension}"
                    prepare_image_for_save(content, os.path.join(output_dir, final_name), settings)

                logger.info(
                    "Image %s downloaded (%s bytes, source=%s, mode=%s, attempt=%s)",
                    image_number,
                    len(content),
                    "optimized" if (not raw_mode and candidate_index == 0 and optimized_url != original_url) else "original",
                    "raw" if raw_mode else "processed",
                    attempt,
                )
                return len(content), final_name, candidate_url
            except Exception as exc:
                last_error = str(exc)
                logger.warning("Image %s download attempt %s failed: %s", image_number, attempt, exc)
                time.sleep(min(attempt, 2))
    raise RuntimeError(last_error)


def json_cell(value):
    """Arabic: تحويل القوائم إلى JSON مضغوط مناسب لخلايا Excel. English: Serialize lists as compact JSON for Excel cells."""
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def build_variant_fields(sizes, colors, price, stock, settings, product_type, base_price_yuan):
    """
    Arabic: يبني صفوف Variations لسوقيفاي. للأحذية: مقاسات بنفس السعر لكل واحد (سلوك أصلي بلا أي تغيير).
    للساعات: ألوان، كل لون بسعره الخاص = السعر الأساسي باليوان + فرق سعر اللون + رسم الساعات الثابت،
    محوّلاً بنفس سعر الصرف. لو ما وصلت أي ألوان (لم تُستخرج أو لم تُعدَّل يدوياً)، يُنشأ لون واحد
    افتراضي بالسعر الأساسي + الرسم الثابت فقط، حتى لا يبقى المنتج بلا سعر قابل للبيع.
    English: Builds Sooqify variation rows. Shoes: sizes, all at the identical price (original,
    unchanged behavior). Watches: colors, each with its own price = base CNY price + that color's
    delta + the flat watch fee, converted with the same exchange rate. If no colors were supplied
    (not extracted or not edited by the operator), a single default color is created at the base
    price plus the flat fee, so the product is never left without a sellable price.
    """
    # Arabic: نوع بلا خاصية خيارات (حالياً الساعات بطلب المستخدم) - لا Variations ولا
    #         ChoiceOptions ولا Attributes إطلاقاً؛ منتج بسعر واحد ومخزون واحد.
    # English: A type with no variant attribute (currently watches, per the operator's request)
    #          gets no Variations, ChoiceOptions or Attributes at all; a single-price,
    #          single-stock product.
    if not get_profile(product_type)["uses_variant_attribute"]:
        return "[]", "[]", "[]", settings["Stock"]

    if resolve_product_type(product_type) == "watches":
        variations = []
        for color in (colors or []):
            label = _normalize_text(color.get("label")) if isinstance(color, dict) else ""
            if not label:
                continue
            delta_yuan = _safe_float(color.get("delta_yuan"), 0) if isinstance(color, dict) else 0
            color_price_yuan = _safe_float(base_price_yuan, 0) + delta_yuan + settings["WatchFlatFeeYuan"]
            color_price_sar = round(color_price_yuan * settings["ExchangeRate"])
            variations.append({"type": label, "price": color_price_sar, "stock": settings["Stock"]})
        if not variations:
            default_price_yuan = _safe_float(base_price_yuan, 0) + settings["WatchFlatFeeYuan"]
            variations = [{
                "type": "Default",
                "price": round(default_price_yuan * settings["ExchangeRate"]),
                "stock": settings["Stock"],
            }]
        attribute_id = product_type_variant_attribute_id(product_type, settings)
        choice_options = [{
            "name": f"choice_{attribute_id}",
            "title": product_type_variant_title(product_type, settings),
            "options": [item["type"] for item in variations],
        }]
        attributes = [attribute_id]
        total_stock = settings["Stock"] * len(variations)
        return json_cell(variations), json_cell(choice_options), json_cell(attributes), total_stock

    # Arabic: سلوك الأحذية الأصلي بدون أي تغيير. English: Original shoe behavior, unchanged.
    normalized_sizes = _unique_text_values(sizes)
    if not normalized_sizes:
        return "[]", "[]", "[]", settings["Stock"]
    price_value = _safe_float(price, 0)
    if price_value.is_integer():
        price_value = int(price_value)
    variations = [
        {"type": size, "price": price_value, "stock": settings["Stock"]}
        for size in normalized_sizes
    ]
    attribute_id = product_type_variant_attribute_id(product_type, settings)
    choice_options = [
        {
            "name": f"choice_{attribute_id}",
            "title": product_type_variant_title(product_type, settings),
            "options": normalized_sizes,
        }
    ]
    attributes = [attribute_id]
    total_stock = settings["Stock"] * len(normalized_sizes)
    return json_cell(variations), json_cell(choice_options), json_cell(attributes), total_stock


def build_watch_variations_from_absolute_yuan(watch_colors, settings, original_price):
    """
    Arabic: مسار /api/extract عند وصول Variants من الإضافة: سعر مطلق باليوان × سعر الصرف
            (بدون إعادة إضافة WatchFlatFeeYuan على هذا المسار). منسوخ حرفياً من extract_product.
    English: /api/extract path when Variants arrive from the extension: absolute CNY × exchange
             rate (WatchFlatFeeYuan is not added again on this path). Copied verbatim from extract_product.
    """
    watch_stock = settings["Stock"]
    watch_attr_id = product_type_variant_attribute_id("watches", settings)
    watch_attr_title = product_type_variant_title("watches", settings)
    variant_price_rows = []
    for vc in watch_colors:
        color_price_sar = round(vc["_abs_price_yuan"] * settings["ExchangeRate"])
        variant_price_rows.append({"type": vc["label"], "price": color_price_sar, "stock": watch_stock})
    if not variant_price_rows:
        default_yuan = _safe_float(original_price, 0) + settings["WatchFlatFeeYuan"]
        variant_price_rows = [{"type": "Default", "price": round(default_yuan * settings["ExchangeRate"]), "stock": watch_stock}]
    variations = json_cell(variant_price_rows)
    choice_options = json_cell([{"name": f"choice_{watch_attr_id}", "title": watch_attr_title, "options": [r["type"] for r in variant_price_rows]}])
    attributes = json_cell([watch_attr_id])
    total_stock = watch_stock * len(variant_price_rows)
    return variations, choice_options, attributes, total_stock, variant_price_rows


def resolve_store_images_for_upload(image_names, selected_indexes, main_image_index, upload_main_image_only=False):
    """Arabic: يحسب قائمة الصور النهائية للمتجر مع إبقاء الصورة الرئيسية فقط إذا كان الخيار مفعلًا. English: Resolve the final store image list while keeping only the main image when the option is enabled."""
    if not image_names:
        return []

    ordered_names = list(image_names)
    if upload_main_image_only:
        if main_image_index in selected_indexes:
            main_position = selected_indexes.index(main_image_index)
            if main_position < len(ordered_names):
                return [ordered_names[main_position]]
        return [ordered_names[0]]

    main_name = ordered_names[0]
    if main_image_index in selected_indexes:
        main_position = selected_indexes.index(main_image_index)
        if main_position < len(ordered_names):
            main_name = ordered_names[main_position]

    gallery_names = [name for name in ordered_names if name != main_name]
    return [main_name] + gallery_names[:5]
