"""
Arabic: الشكل الموحَّد لـ"وحدة عمل منجزة" — العقد المشترك بين إضافة AlphaCode وتطبيق
        محدّث الصور (Sooqify Image Updater)، حتى يخرج تقرير واحد يغطي عمل الطرفين.

        لماذا طبقة وسيطة بدل فرض شكل أحد الطرفين على الآخر؟ نوقشت ثلاثة خيارات:

          (1) فرض شكل منتج AlphaCode على تطبيق الصور: يتطلب من التطبيق تعبئة ~35 حقلاً
              (price, variants, brand_id, images...) لا معنى لها عند تعديل صور منتج
              موجود أصلاً. سيولّد حقولاً وهمية تفسد فحص "إصلاح البيانات" وتُحتسب
              منتجات جديدة بالتقرير. مرفوض.
          (2) فرض شكل حدث تطبيق الصور على AlphaCode: يفقد النوع (أحذية/ساعات) ومصدر
              الـ ID وكل ما تبنى عليه التقارير الحالية، ويستلزم ترحيل 3800 سجل. مرفوض.
          (3) طبقة عرض رقيقة: كل طرف يبقى بشكله الأصلي على القرص، ويُسقَط (project)
              إلى "وحدة عمل" عند بناء التقرير فقط. منتجات AlphaCode تُسقَط وقت التقرير
              (بلا ترحيل ولا خطر على التقارير القائمة)، وتطبيق الصور يكتب وحدات العمل
              أصلاً بهذا الشكل. **المُعتمد.**

        الوحدة بالنهاية: {source, user, date, item_type, item_id, status} + حقول عدّ
        اختيارية. اسم الحقل `date` مقصود: هو نفس اسم الحقل الذي تصفّي عليه
        `report_service._item_day()` منذ البداية، فتعمل كل النطاقات الأربعة على وحدات
        العمل بلا أي تعديل بمنطق التواريخ.

English: The unified shape of a "completed work unit" — the shared contract between the
         AlphaCode extension and the Sooqify Image Updater app, so one report can cover
         both sides' work.

         Why a thin overlay instead of forcing one side's shape on the other? Three
         options were weighed:

           (1) Force AlphaCode's product shape on the image app: it would have to fill
               ~35 fields (price, variants, brand_id, images...) that are meaningless
               when re-uploading images for a product that already exists. That fabricates
               fields which break the data-repair scan and get counted as new products.
               Rejected.
           (2) Force the image app's event shape on AlphaCode: loses product type, ID
               source and everything the current reports are built on, and would require
               migrating 3,800 records. Rejected.
           (3) A thin projection layer: each side keeps its own on-disk shape and is
               projected into a "work unit" only while building the report. AlphaCode
               products are projected at report time (no migration, no risk to existing
               reports); the image app writes work units natively. **Chosen.**

         The unit: {source, user, date, item_type, item_id, status} plus optional counters.
         The field name `date` is deliberate: it is the very field
         `report_service._item_day()` has always filtered on, so all four date scopes work
         on work units with no change to the date logic.

Arabic: نظير هذا الملف بتطبيق محدّث الصور هو `app/work_log.py` — أي تعديل على الثوابت
        هنا يجب أن يُطبَّق هناك أيضاً (نفس نمط product_type_profiles.py ↔ product_types.js).
English: The counterpart in the image-updater app is `app/work_log.py` — any change to the
         constants here must be applied there too (same pattern as
         product_type_profiles.py ↔ product_types.js).
"""

from __future__ import annotations

SCHEMA_VERSION = 1

# Arabic: الحقل المميّز. غيابه يعني "سجل منتج قديم" — وهذا ما يحفظ التوافق الخلفي:
#         3800 سجلاً موجوداً لا يحمل الحقل، فيبقى يُعامل كمنتج بالضبط كما قبل.
# English: The discriminator. Its absence means "a legacy product record" - which is what
#          preserves backwards compatibility: the 3,800 existing records carry no such
#          field, so they keep being treated as products exactly as before.
RECORD_KIND_FIELD = "record_kind"
RECORD_KIND_WORK_UNIT = "work_unit"

# Arabic: المصادر المعروفة وتسمياتها بالتقرير.
# English: Known sources and their report labels.
SOURCE_EXTENSION = "extension"
SOURCE_IMAGE_UPDATER = "image_updater"

SOURCE_LABELS = {
    SOURCE_EXTENSION: ("إضافة AlphaCode", "AlphaCode Extension"),
    SOURCE_IMAGE_UPDATER: ("محدّث صور سوقيفاي", "Sooqify Image Updater"),
}

# Arabic: أنواع وحدات العمل. "product_added" هو ما تنتجه الإضافة،
#         و"product_images_updated" هو ما ينتجه تطبيق المصممة.
# English: Work-unit types. "product_added" is what the extension produces;
#          "product_images_updated" is what the designer's app produces.
ITEM_TYPE_PRODUCT_ADDED = "product_added"
ITEM_TYPE_IMAGES_UPDATED = "product_images_updated"

ITEM_TYPE_LABELS = {
    ITEM_TYPE_PRODUCT_ADDED: ("منتج مُضاف", "Product added"),
    ITEM_TYPE_IMAGES_UPDATED: ("صور مُحدَّثة", "Images updated"),
}

STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_SKIPPED = "skipped"

# Arabic: الحالات التي تُحتسب "عملاً منجزاً" بالتقرير. الفاشل/المتخطّى يُسجَّل لكن لا يُحتسب،
#         حتى لا يتحول التقرير إلى أداة تضخيم أرقام.
# English: The statuses that count as "completed work" in the report. Failed/skipped are
#          recorded but not counted, so the report never inflates numbers.
COUNTED_STATUSES = {STATUS_DONE}


def is_work_unit(item):
    """Arabic: هل هذا السجل وحدة عمل موحَّدة (لا سجل منتج)؟ English: Is this record a unified work unit (not a product record)?"""
    return isinstance(item, dict) and item.get(RECORD_KIND_FIELD) == RECORD_KIND_WORK_UNIT


def make_work_unit(source, user, date, item_type, item_id, status=STATUS_DONE, quantity=1, timestamp=None, extra=None):
    """
    Arabic: يبني وحدة عمل بالشكل الموحَّد. `quantity` معنىً خاص بالنوع (عدد الصور المرفوعة
            مثلاً) ولا يُستخدم أبداً كبديل عن عدّ الوحدات نفسها.
    English: Builds a work unit in the unified shape. `quantity` is type-specific (e.g. how
             many images were uploaded) and is never used as a substitute for counting the
             units themselves.
    """
    unit = {
        RECORD_KIND_FIELD: RECORD_KIND_WORK_UNIT,
        "schema_version": SCHEMA_VERSION,
        "source": str(source or ""),
        "user": str(user or ""),
        "date": str(date or "")[:10],
        "timestamp": str(timestamp or ""),
        "item_type": str(item_type or ""),
        "item_id": str(item_id or ""),
        "status": str(status or STATUS_DONE),
        "quantity": int(quantity or 0),
    }
    if extra:
        unit.update(extra)
    return unit


def work_unit_key(unit):
    """
    Arabic: مفتاح حتمي (deterministic) للوحدة داخل الأرشيف المشترك. حتميته تجعل إعادة
            الدفع idempotent: نفس الوحدة تُكتب فوق نفسها بدل أن تُحتسب مرتين بالتقرير.
            لا يبدأ بـ"_" عن قصد: `sync_reconcile_full` يستثني المفاتيح البادئة بـ"_"
            من الرفع، فلو بدأناه بها لما وصلت وحدات العمل للسيرفر أبداً.
    English: A deterministic key for the unit inside the shared archive. Being deterministic
             makes re-pushing idempotent: the same unit overwrites itself instead of being
             counted twice in the report. Deliberately not "_"-prefixed:
             `sync_reconcile_full` excludes "_"-prefixed keys from pushing, so such a prefix
             would mean work units never reach the server at all.
    """
    return "WU::{source}::{item_type}::{item_id}::{date}".format(
        source=unit.get("source") or "unknown",
        item_type=unit.get("item_type") or "unknown",
        item_id=unit.get("item_id") or "unknown",
        date=(unit.get("date") or "")[:10] or "unknown",
    )


def project_product(item):
    """
    Arabic: يُسقِط سجل منتج AlphaCode إلى وحدة عمل، للقراءة فقط وقت بناء التقرير.
            لا يُكتب هذا الإسقاط على القرص أبداً — الأرشيف يبقى كما هو حرفياً.
    English: Projects an AlphaCode product record into a work unit, read-only at report
             build time. The projection is never written to disk - the archive stays
             literally unchanged.
    """
    raw_date = str(item.get("date") or item.get("created_at") or "")
    return make_work_unit(
        source=SOURCE_EXTENSION,
        user=item.get("added_by") or "",
        date=raw_date[:10],
        item_type=ITEM_TYPE_PRODUCT_ADDED,
        item_id=item.get("id"),
        status=STATUS_DONE,
        quantity=1,
        timestamp=raw_date,
        extra={"product_type": item.get("product_type")},
    )


def partition_archive(archive_entries):
    """
    Arabic: يفصل الأرشيف إلى (سجلات منتجات، وحدات عمل). كل ما ليس وحدة عمل صريحة يُعامل
            منتجاً — وهذا ما يجعل السلوك القديم يبقى حرفياً بلا استثناء.
    English: Splits the archive into (product records, work units). Anything not explicitly
             a work unit is treated as a product - which is what keeps the old behaviour
             literally intact.

    Returns: (products_dict, work_units_list)
    """
    products = {}
    work_units = []
    for key, item in (archive_entries or {}).items():
        if not isinstance(item, dict):
            continue
        if is_work_unit(item):
            work_units.append(item)
        else:
            products[key] = item
    return products, work_units
