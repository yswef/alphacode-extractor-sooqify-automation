# =========================================================
# AlphaCode Extractor - report_service (Phase 3)
# Arabic: توليد تقارير PDF يومية وشهرية من الأرشيف (منقول من Reports.py بدون تغيير منطق).
# English: Daily/monthly PDF reports from the archive (moved from Reports.py, logic unchanged).
# =========================================================
#
# Arabic: يتطلب: pip install reportlab --break-system-packages
# لدعم النصوص العربية بشكل صحيح (اتجاه وربط الحروف) يتطلب أيضاً:
#     pip install arabic-reshaper python-bidi --break-system-packages
# وخط يدعم العربية (مثلاً Tahoma أو Arial من مجلد خطوط ويندوز) - عدّل ARABIC_FONT_PATH بالأسفل.
# بدون هذه الحزم/الخط، التقرير يُنتج بنجاح لكن بعناوين إنجليزية فقط (Fallback آمن، لا يتعطل التطبيق).
#
# English: Requires: pip install reportlab --break-system-packages
# For correct Arabic text (shaping + direction) also requires:
#     pip install arabic-reshaper python-bidi --break-system-packages
# and an Arabic-capable font (e.g. Tahoma or Arial from the Windows Fonts folder) -
# set ARABIC_FONT_PATH below. Without these, the report still generates successfully
# with English-only labels (a safe fallback, never crashes the app).

import os
import reportlab
from collections import Counter, defaultdict
from datetime import datetime, timedelta

# Arabic: حدّ أمان لطول المدى المخصص حتى لا يُبنى تقرير بآلاف الأيام بالخطأ.
# English: Safety cap on a custom range so a thousands-of-days report is never built by mistake.
MAX_RANGE_DAYS = 366

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Arabic: أسماء الأنواع وتسمياتها من المصدر الموحّد بدل صفوف مكتوبة يدوياً.
# English: Type ids and labels come from the unified source instead of hand-written rows.
from app.services.product_type_profiles import PROFILES, resolve_product_type

# Arabic: الشكل الموحَّد لوحدات العمل وربط الهوية بين المصدرين.
# English: The unified work-unit shape and cross-source identity linking.
from app.services import work_units as wu
from app.services.report_identity import (
    load_identity_map,
    resolve_identity,
    unknown_user_label,
)

# Arabic: عدّل هذا المسار لأي خط .ttf يدعم العربية موجود على جهازك (اختياري).
# English: Point this at any Arabic-capable .ttf on your machine (optional).
ARABIC_FONT_PATH = r"C:\Windows\Fonts\tahoma.ttf"
ARABIC_FONT_NAME = "AlphaCodeArabic"

_ARABIC_SUPPORT = False
try:
    import arabic_reshaper
    from bidi.algorithm import get_display

    if os.path.isfile(ARABIC_FONT_PATH):
        pdfmetrics.registerFont(TTFont(ARABIC_FONT_NAME, ARABIC_FONT_PATH))
        _ARABIC_SUPPORT = True
except Exception:
    # Arabic: أي فشل هنا (حزمة ناقصة أو خط غير موجود) يرجع تلقائياً لتقرير إنجليزي فقط. English: Any failure here silently falls back to an English-only report.
    _ARABIC_SUPPORT = False


def _rtl(text):
    """Arabic: تحويل نص عربي لشكل صحيح للعرض في PDF (تشكيل + اتجاه)، أو إرجاعه كما هو إن لم تتوفر الحزم. English: Shape and reverse Arabic text for correct PDF display, or return it unchanged if the packages are unavailable."""
    text = str(text or "")
    if not _ARABIC_SUPPORT or not text:
        return text
    try:
        return get_display(arabic_reshaper.reshape(text))
    except Exception:
        return text


FONT_NAME = ARABIC_FONT_NAME if _ARABIC_SUPPORT else "Helvetica"
FONT_NAME_BOLD = ARABIC_FONT_NAME if _ARABIC_SUPPORT else "Helvetica-Bold"


def _item_day(item):
    """Arabic: يوم العنصر بصيغة YYYY-MM-DD أو "" إن تعذّر. English: The item day as YYYY-MM-DD, or "" when unavailable."""
    raw = str(item.get("date") or item.get("created_at") or "")
    return raw[:10] if len(raw) >= 10 else ""


def resolve_report_days(scope, target_date=None, days=None, date_from=None, date_to=None):
    """
    Arabic: يحوّل أي نطاق مطلوب إلى مجموعة أيام صريحة (YYYY-MM-DD) - هذي هي الوحدة التي
            يُبنى عليها التقرير الآن بدل القوالب الجامدة.
              - "daily"   : يوم واحد (target_date)          [متوافق مع القديم]
              - "monthly" : كل أيام شهر target_date          [متوافق مع القديم]
              - "days"    : أيام محددة يدوياً، غير متتالية   [جديد]
              - "range"   : من تاريخ إلى تاريخ، ويجوز عبور الشهور [جديد]
            يُرجع None للشهري بدل قائمة أيام، لأن المطابقة تتم ببادئة الشهر - هذا يحافظ
            على السلوك القديم حرفياً حتى لو كان الأرشيف يحمل تواريخ بصيغ غير متوقعة.
    English: Turns any requested scope into an explicit set of days (YYYY-MM-DD) - the unit
             the report is now built on, instead of the old rigid templates.
               - "daily"   : one day (target_date)            [backwards compatible]
               - "monthly" : every day of target_date's month [backwards compatible]
               - "days"    : hand-picked, non-consecutive days [new]
               - "range"   : from-date to to-date, may cross months [new]
             Returns None for monthly rather than a day list, because monthly matches on a
             month prefix - this keeps the old behaviour verbatim even when the archive
             carries dates in an unexpected shape.
    """
    if scope == "monthly":
        return None

    if scope == "days":
        # Arabic: أيام صريحة - نُزيل التكرار ونرتب، ونتجاهل أي قيمة غير صالحة بصمت.
        # English: Explicit days - de-duplicate and sort, silently dropping invalid values.
        valid = set()
        for raw in days or []:
            try:
                valid.add(datetime.strptime(str(raw).strip(), "%Y-%m-%d").strftime("%Y-%m-%d"))
            except ValueError:
                continue
        return sorted(valid)

    if scope == "range":
        start = datetime.strptime(str(date_from).strip(), "%Y-%m-%d")
        end = datetime.strptime(str(date_to).strip(), "%Y-%m-%d")
        if end < start:
            start, end = end, start
        # Arabic: عبور الشهور مدعوم مجاناً هنا لأن التوليد يتم يوماً بيوم لا بقالب شهري.
        # English: Crossing months is free here because generation walks day by day, not by month.
        span = (end - start).days
        if span > MAX_RANGE_DAYS:
            raise ValueError(
                f"المدى أطول من الحد المسموح ({MAX_RANGE_DAYS} يوماً). قسّمه إلى تقارير أصغر."
            )
        return [(start + timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(span + 1)]

    # Arabic: الافتراضي "daily" - يوم واحد.
    # English: Default "daily" - a single day.
    return [(target_date or datetime.now()).strftime("%Y-%m-%d")]


def _entries_for_days(archive_entries, days, month_prefix=None):
    """
    Arabic: تصفية عناصر الأرشيف على مجموعة أيام صريحة، أو على بادئة شهر (للتقرير الشهري).
    English: Filter archive entries to an explicit set of days, or to a month prefix (monthly).
    """
    day_set = set(days or [])
    matched = []
    for item in archive_entries.values():
        # Arabic: وحدات العمل الموحّدة تُستثنى صراحةً من قوائم "المنتجات". لولا هذا الشرط
        #         لصار عمل تطبيق الصور يُحتسب منتجات جديدة بجداول الملخص وحسب المستخدم،
        #         فتتضخم الأرقام. الاستثناء صريح لا ضمني: لا يعتمد على غياب `id`.
        # English: Unified work units are explicitly excluded from "product" lists. Without
        #          this guard, the image app's work would be counted as new products in the
        #          summary and per-user tables, inflating the numbers. The exclusion is
        #          explicit, not incidental: it does not rely on `id` being absent.
        if wu.is_work_unit(item):
            continue
        if item.get("id") is None:
            continue  # Arabic: تجاهل سجلات الحجز التفاؤلي بلا id. English: Skip optimistic-lock reservation stubs with no id.
        if month_prefix is not None:
            item_date = str(item.get("date") or item.get("created_at") or "")
            if item_date.startswith(month_prefix):
                matched.append(item)
        elif _item_day(item) in day_set:
            matched.append(item)
    return matched


def _entries_for_scope(archive_entries, scope, target_date):
    """
    Arabic: غلاف التوافق الخلفي - يبقى بنفس التوقيع والسلوك السابقين تماماً لأي مستدعٍ قديم.
    English: Backwards-compatibility wrapper - identical signature and behaviour for old callers.
    """
    if scope == "monthly":
        return _entries_for_days(archive_entries, None, month_prefix=target_date.strftime("%Y-%m"))
    return _entries_for_days(archive_entries, [target_date.strftime("%Y-%m-%d")])


def _build_summary_table(entries):
    """Arabic: جدول ملخص عام (العدد الكلي، حسب النوع، حسب مصدر الـ ID). English: A general summary table (total count, by type, by ID source)."""
    total = len(entries)
    by_type = Counter(resolve_product_type(item.get("product_type")) for item in entries)
    by_id_source = Counter(item.get("id_source") or "local_fallback" for item in entries)

    rows = [
        [_rtl("البند") if _ARABIC_SUPPORT else "Metric", _rtl("القيمة") if _ARABIC_SUPPORT else "Value"],
        [_rtl("إجمالي المنتجات") if _ARABIC_SUPPORT else "Total products", str(total)],
        *[
            [
                _rtl(profile["label_ar"]) if _ARABIC_SUPPORT else profile["label_en"],
                str(by_type.get(type_id, 0)),
            ]
            for type_id, profile in PROFILES.items()
        ],
        [_rtl("عبر المزامنة المركزية") if _ARABIC_SUPPORT else "Via central sync", str(by_id_source.get("remote", 0))],
        [_rtl("احتياطي محلي (راجعها)") if _ARABIC_SUPPORT else "Local fallback (review)", str(by_id_source.get("local_fallback", 0))],
    ]
    table = Table(rows, colWidths=[80 * mm, 40 * mm])
    table.setStyle(_table_style(header_rows=1))
    return table


def _build_per_user_table(entries):
    """Arabic: جدول تفصيلي بعدد المنتجات لكل مستخدم أضافها. English: A detailed table of how many products each user added."""
    by_user = defaultdict(lambda: Counter())
    for item in entries:
        # Arabic: التسمية تُخزَّن خاماً هنا وتمر بـ_rtl مرة واحدة عند العرض بالأسفل. كانت
        #         تُشكَّل هنا ثم تُشكَّل مرة ثانية بالعرض، ومرورها بـget_display مرتين يعيد
        #         عكسها - فكان "غير محدد" وحده يظهر مقلوباً بينما بقية الأسماء صحيحة.
        # English: The label is stored raw here and passed through _rtl exactly once when
        #          rendered below. It used to be shaped here and shaped again at render time,
        #          and going through get_display twice re-reverses it - so "غير محدد" alone
        #          printed backwards while every other name was correct.
        added_by = item.get("added_by") or ("Unknown" if not _ARABIC_SUPPORT else "غير محدد")
        by_user[added_by]["total"] += 1
        by_user[added_by][resolve_product_type(item.get("product_type"))] += 1

    header = [
        _rtl("المستخدم") if _ARABIC_SUPPORT else "User",
        _rtl("الإجمالي") if _ARABIC_SUPPORT else "Total",
        _rtl("أحذية") if _ARABIC_SUPPORT else "Shoes",
        _rtl("ساعات") if _ARABIC_SUPPORT else "Watches",
    ]
    rows = [header]
    for user, counts in sorted(by_user.items(), key=lambda pair: -pair[1]["total"]):
        # Arabic: اسم المستخدم عربي غالباً، فيجب أن يمر بـ_rtl مثل بقية النصوص العربية.
        #         بدونها كان "يوسف" يُطبع مقلوباً "فسوي" - كل الخلايا الأخرى كانت تمر
        #         بـ_rtl إلا هذي، فظهر الاسم وحده معكوساً بالتقرير.
        # English: The user name is usually Arabic, so it must go through _rtl like every other
        #          Arabic string. Without it "يوسف" printed reversed as "فسوي" - every other
        #          cell was passed through _rtl except this one, so only the name came out
        #          backwards in the report.
        display_name = _rtl(user) if _ARABIC_SUPPORT else user
        rows.append([display_name, str(counts["total"]), str(counts.get("shoes", 0)), str(counts.get("watches", 0))])

    if len(rows) == 1:
        rows.append(["-", "0", "0", "0"])

    table = Table(rows, colWidths=[60 * mm, 25 * mm, 25 * mm, 25 * mm])
    table.setStyle(_table_style(header_rows=1))
    return table





# ---------------------------------------------------------------------------
# Arabic: التقرير الموحَّد - وحدات العمل من المصدرين معاً.
# English: The unified report - work units from both sources together.
# ---------------------------------------------------------------------------

def _work_units_for_days(archive_entries, days, month_prefix=None):
    """
    Arabic: يجمع وحدات العمل المطابقة لنفس النطاق الزمني، بنفس منطق تصفية المنتجات حرفياً
            (بادئة شهر للشهري، ومجموعة أيام لغيره) - فلا يوجد منطق تاريخ ثانٍ يتباعد عن الأول.
    English: Collects the work units matching the same date scope, using literally the same
             filtering logic as products (a month prefix for monthly, an explicit day set
             otherwise) - so there is no second date logic to drift from the first.
    """
    day_set = set(days or [])
    matched = []
    for item in (archive_entries or {}).values():
        if not wu.is_work_unit(item):
            continue
        if month_prefix is not None:
            if str(item.get("date") or "").startswith(month_prefix):
                matched.append(item)
        elif _item_day(item) in day_set:
            matched.append(item)
    return matched


def unified_units(product_entries, work_unit_entries, identity_map=None):
    """
    Arabic: يبني قائمة وحدات عمل موحَّدة: منتجات AlphaCode تُسقَط وقت القراءة، ووحدات
            تطبيق الصور تُستخدم كما هي، ثم تُوحَّد هوية المستخدم على الطرفين.
            **لا تُحتسب إلا الحالات المنجزة** (COUNTED_STATUSES) - الفاشل يُسجَّل ولا يُعدّ.
    English: Builds one unified work-unit list: AlphaCode products are projected at read
             time, image-app units are used as-is, then the user identity is unified across
             both. **Only completed statuses are counted** (COUNTED_STATUSES) - failures are
             recorded but never counted.
    """
    identity_map = identity_map or {}
    units = []
    for item in product_entries or []:
        units.append(wu.project_product(item))
    for unit in work_unit_entries or []:
        if unit.get("status") not in wu.COUNTED_STATUSES:
            continue
        units.append(dict(unit))

    for unit in units:
        unit["user"] = resolve_identity(unit.get("user"), unit.get("source"), identity_map)
    return units


def _source_label(source_id):
    """Arabic: تسمية المصدر بلغة التقرير. English: The source label in the report language."""
    label_ar, label_en = wu.SOURCE_LABELS.get(source_id, (str(source_id or "?"), str(source_id or "?")))
    return label_ar if _ARABIC_SUPPORT else label_en


def _item_type_label(item_type):
    """Arabic: تسمية نوع وحدة العمل. English: The work-unit type label."""
    label_ar, label_en = wu.ITEM_TYPE_LABELS.get(item_type, (str(item_type or "?"), str(item_type or "?")))
    return label_ar if _ARABIC_SUPPORT else label_en


def _build_per_source_table(units):
    """
    Arabic: تفصيل حسب المصدر (إضافة / تطبيق المصممة) ونوع العمل، مع عدد المستخدمين
            المشاركين من كل مصدر. كل خلية عربية تمر بـ_rtl بلا استثناء.
    English: Breakdown by source (extension / designer's app) and work type, plus how many
             users contributed from each source. Every Arabic cell goes through _rtl, with
             no exception.
    """
    by_pair = Counter()
    users_per_source = defaultdict(set)
    for unit in units:
        by_pair[(unit.get("source"), unit.get("item_type"))] += 1
        if unit.get("user"):
            users_per_source[unit.get("source")].add(unit.get("user"))

    header = [
        _rtl("المصدر") if _ARABIC_SUPPORT else "Source",
        _rtl("نوع العمل") if _ARABIC_SUPPORT else "Work type",
        _rtl("عدد الوحدات") if _ARABIC_SUPPORT else "Units",
        _rtl("عدد المستخدمين") if _ARABIC_SUPPORT else "Users",
    ]
    rows = [header]
    for (source_id, item_type), count in sorted(by_pair.items(), key=lambda pair: (-pair[1], str(pair[0]))):
        rows.append([
            _rtl(_source_label(source_id)) if _ARABIC_SUPPORT else _source_label(source_id),
            _rtl(_item_type_label(item_type)) if _ARABIC_SUPPORT else _item_type_label(item_type),
            str(count),
            str(len(users_per_source.get(source_id, ()))),
        ])

    if len(rows) == 1:
        rows.append(["-", "-", "0", "0"])
    else:
        rows.append([
            _rtl("الإجمالي") if _ARABIC_SUPPORT else "Total",
            "",
            str(sum(by_pair.values())),
            str(len({unit.get("user") for unit in units if unit.get("user")})),
        ])

    table = Table(rows, colWidths=[55 * mm, 40 * mm, 25 * mm, 30 * mm])
    table.setStyle(_table_style(header_rows=1))
    return table


def _build_per_user_source_table(units):
    """
    Arabic: تفصيل حسب المستخدم × المصدر. غرضه المزدوج: يُظهر إنتاجية كل شخص بكل أداة،
            **وأيضاً** يكشف فوراً لو انقسم شخص واحد لصفّين لأن الهوية لم تُربط بالخريطة
            الصريحة - بدل أن يُبتلع الانقسام بصمت داخل رقم مجمَّع.
    English: Breakdown by user x source. Its purpose is twofold: it shows each person's
             output per tool, **and** it immediately exposes one person split across two rows
             because their identity was not linked in the explicit map - instead of the split
             being silently swallowed inside an aggregate number.
    """
    sources = sorted({unit.get("source") for unit in units if unit.get("source")})
    by_user = defaultdict(Counter)
    for unit in units:
        user = unit.get("user") or unknown_user_label(_ARABIC_SUPPORT)
        by_user[user]["total"] += 1
        by_user[user][unit.get("source")] += 1

    header = [_rtl("المستخدم") if _ARABIC_SUPPORT else "User",
              _rtl("الإجمالي") if _ARABIC_SUPPORT else "Total"]
    for source_id in sources:
        label = _source_label(source_id)
        header.append(_rtl(label) if _ARABIC_SUPPORT else label)

    rows = [header]
    for user, counts in sorted(by_user.items(), key=lambda pair: (-pair[1]["total"], str(pair[0]))):
        # Arabic: اسم المستخدم عربي غالباً - يمر بـ_rtl مثل كل نص عربي آخر (نفس العيب الذي
        #         طبع "يوسف" كـ"فسوي" سابقاً بجدول "حسب المستخدم").
        # English: The user name is usually Arabic - it goes through _rtl like every other
        #          Arabic string (the same defect that printed "يوسف" as "فسوي" in the
        #          per-user table before).
        row = [_rtl(user) if _ARABIC_SUPPORT else user, str(counts["total"])]
        row.extend(str(counts.get(source_id, 0)) for source_id in sources)
        rows.append(row)

    if len(rows) == 1:
        rows.append(["-", "0", *["0"] * len(sources)])

    first_col = 55 * mm
    remaining = 2 + len(sources) - 1
    table = Table(rows, colWidths=[first_col, *[25 * mm] * remaining])
    table.setStyle(_table_style(header_rows=1))
    return table


def _table_style(header_rows=1, small=False):
    font_size = 8 if small else 9
    return TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), FONT_NAME),
        ("FONTNAME", (0, 0), (-1, header_rows - 1), FONT_NAME_BOLD),
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("BACKGROUND", (0, 0), (-1, header_rows - 1), colors.HexColor("#07022A")),
        ("TEXTCOLOR", (0, 0), (-1, header_rows - 1), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CCCCCC")),
        ("ROWBACKGROUNDS", (0, header_rows), (-1, -1), [colors.white, colors.HexColor("#F5F5F5")]),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ])


def describe_period(scope, days, target_date=None):
    """
    Arabic: تسمية المدة للعرض بالتقرير واسم الملف. تُبقي الصيغ القديمة كما هي حرفياً
            (يوم واحد -> YYYY-MM-DD، شهري -> YYYY-MM) وتضيف صيغاً للنطاقات الجديدة.
    English: The period label used in the report body and the filename. Keeps the old shapes
             verbatim (single day -> YYYY-MM-DD, monthly -> YYYY-MM) and adds the new ones.
    """
    if scope == "monthly":
        return (target_date or datetime.now()).strftime("%Y-%m")
    days = list(days or [])
    if not days:
        return (target_date or datetime.now()).strftime("%Y-%m-%d")
    if len(days) == 1:
        return days[0]
    if scope == "range":
        return f"{days[0]}_to_{days[-1]}"
    return f"{days[0]}_plus_{len(days) - 1}more"


def generate_report(
    archive_entries,
    scope,
    output_path,
    target_date=None,
    days=None,
    date_from=None,
    date_to=None,
    identity_dir=None,
):
    """
    Arabic: يبني تقرير PDF احترافي (يومي أو شهري) من عناصر الأرشيف ويحفظه في output_path.
    English: Builds a professional PDF report (daily or monthly) from archive entries and saves it to output_path.

    archive_entries: dict of {key: product_dict}, e.g. from app.py's archive_entries(load_archive()).
    scope: "daily" or "monthly".
    output_path: full .pdf file path to write.
    target_date: a datetime; defaults to now.
    identity_dir: optional folder holding report_identities.json (cross-source user map).
    """
    target_date = target_date or datetime.now()
    # Arabic: أي نطاق (قديم أو جديد) يُحوَّل لمجموعة أيام صريحة، ثم يُبنى التقرير عليها.
    # English: Every scope (old or new) becomes an explicit day set, and the report is built on it.
    if days is None and scope in ("days", "range"):
        days = resolve_report_days(scope, target_date, days, date_from, date_to)
    elif scope not in ("days", "range"):
        days = resolve_report_days(scope, target_date)
    month_prefix = target_date.strftime("%Y-%m") if scope == "monthly" else None
    entries = _entries_for_days(archive_entries, days, month_prefix=month_prefix)

    # Arabic: القسم الموحَّد يُبنى من نفس النطاق: منتجات الإضافة (المُصفّاة أعلاه) مُسقَطة،
    #         مضافاً إليها وحدات عمل تطبيق المصممة. الأقسام القديمة تبقى على `entries` وحدها
    #         بلا أي تغيير - هذا هو ما يضمن أن النطاقات الأربعة تحتفظ بسلوكها الحرفي.
    # English: The unified section is built from the same scope: the extension's products
    #          (filtered above) projected, plus the designer app's work units. The old
    #          sections still run on `entries` alone, unchanged - that is what guarantees the
    #          four date scopes keep their literal behaviour.
    unit_entries = _work_units_for_days(archive_entries, days, month_prefix=month_prefix)
    identity_map = load_identity_map(identity_dir)
    all_units = unified_units(entries, unit_entries, identity_map)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        topMargin=18 * mm, bottomMargin=18 * mm, leftMargin=16 * mm, rightMargin=16 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "AlphaCodeTitle", parent=styles["Title"], fontName=FONT_NAME_BOLD,
        textColor=colors.HexColor("#07022A"), fontSize=20, alignment=1,
    )
    subtitle_style = ParagraphStyle(
        "AlphaCodeSubtitle", parent=styles["Normal"], fontName=FONT_NAME,
        textColor=colors.HexColor("#555555"), fontSize=11, alignment=1,
    )
    section_style = ParagraphStyle(
        "AlphaCodeSection", parent=styles["Heading2"], fontName=FONT_NAME_BOLD,
        textColor=colors.HexColor("#07022A"), fontSize=13, spaceBefore=14, spaceAfter=6,
    )

    period_label = describe_period(scope, days, target_date)
    scope_labels = {
        "monthly": ("تقرير شهري", "Monthly Report"),
        "days": ("تقرير أيام محددة", "Selected Days Report"),
        "range": ("تقرير مدى مخصص", "Custom Range Report"),
    }
    scope_label_ar, scope_label_en = scope_labels.get(scope, ("تقرير يومي", "Daily Report"))

    # Arabic: للأيام المحددة نعرض قائمة الأيام صراحةً حتى يعرف القارئ ما الذي جُمِع بالضبط.
    # English: For hand-picked days, list them explicitly so the reader knows exactly what was combined.
    days_line = ""
    if scope == "days" and days and len(days) > 1:
        days_line = "الأيام: " + "، ".join(days) if _ARABIC_SUPPORT else "Days: " + ", ".join(days)
    elif scope == "range" and days:
        days_line = (
            f"من {days[0]} إلى {days[-1]} ({len(days)} يوماً)"
            if _ARABIC_SUPPORT else f"From {days[0]} to {days[-1]} ({len(days)} days)"
        )

    story = [
        Paragraph("AlphaCode Extractor", title_style),
        Paragraph(_rtl(scope_label_ar) if _ARABIC_SUPPORT else scope_label_en, subtitle_style),
        Paragraph(f"{period_label} — Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}", subtitle_style),
        *([Paragraph(_rtl(days_line) if _ARABIC_SUPPORT else days_line, subtitle_style)] if days_line else []),
        Spacer(1, 10 * mm),
        Paragraph(_rtl("الملخص العام") if _ARABIC_SUPPORT else "Summary", section_style),
        _build_summary_table(entries),
        Paragraph(_rtl("حسب المستخدم") if _ARABIC_SUPPORT else "By User", section_style),
        _build_per_user_table(entries),
        Paragraph(_rtl("حسب المصدر") if _ARABIC_SUPPORT else "By Source", section_style),
        _build_per_source_table(all_units),
        Paragraph(
            _rtl("حسب المستخدم والمصدر") if _ARABIC_SUPPORT else "By User and Source",
            section_style,
        ),
        _build_per_user_source_table(all_units),
    ]

    doc.build(story)
    return output_path