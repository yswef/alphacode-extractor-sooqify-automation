# =========================================================
# AlphaCode Extractor - Reports Module
# Arabic: توليد تقارير PDF يومية وشهرية من الأرشيف، بمعزل عن app.py الكبير.
# English: Generates daily/monthly PDF reports from the archive, kept out of the large app.py.
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
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

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


def _entries_for_scope(archive_entries, scope, target_date):
    """Arabic: تصفية عناصر الأرشيف حسب اليوم أو الشهر المطلوب. English: Filter archive entries to the requested day or month."""
    if scope == "monthly":
        prefix = target_date.strftime("%Y-%m")
    else:
        prefix = target_date.strftime("%Y-%m-%d")

    matched = []
    for item in archive_entries.values():
        if item.get("id") is None:
            continue  # Arabic: تجاهل سجلات الحجز التفاؤلي بلا id. English: Skip optimistic-lock reservation stubs with no id.
        item_date = str(item.get("date") or item.get("created_at") or "")
        if item_date.startswith(prefix):
            matched.append(item)
    return matched


def _build_summary_table(entries):
    """Arabic: جدول ملخص عام (العدد الكلي، حسب النوع، حسب مصدر الـ ID). English: A general summary table (total count, by type, by ID source)."""
    total = len(entries)
    by_type = Counter(item.get("product_type") or "shoes" for item in entries)
    by_id_source = Counter(item.get("id_source") or "local_fallback" for item in entries)

    rows = [
        [_rtl("البند") if _ARABIC_SUPPORT else "Metric", _rtl("القيمة") if _ARABIC_SUPPORT else "Value"],
        [_rtl("إجمالي المنتجات") if _ARABIC_SUPPORT else "Total products", str(total)],
        [_rtl("أحذية") if _ARABIC_SUPPORT else "Shoes", str(by_type.get("shoes", 0))],
        [_rtl("ساعات") if _ARABIC_SUPPORT else "Watches", str(by_type.get("watches", 0))],
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
        added_by = item.get("added_by") or ("Unknown" if not _ARABIC_SUPPORT else _rtl("غير محدد"))
        by_user[added_by]["total"] += 1
        by_user[added_by][item.get("product_type") or "shoes"] += 1

    header = [
        _rtl("المستخدم") if _ARABIC_SUPPORT else "User",
        _rtl("الإجمالي") if _ARABIC_SUPPORT else "Total",
        _rtl("أحذية") if _ARABIC_SUPPORT else "Shoes",
        _rtl("ساعات") if _ARABIC_SUPPORT else "Watches",
    ]
    rows = [header]
    for user, counts in sorted(by_user.items(), key=lambda pair: -pair[1]["total"]):
        rows.append([user, str(counts["total"]), str(counts.get("shoes", 0)), str(counts.get("watches", 0))])

    if len(rows) == 1:
        rows.append(["-", "0", "0", "0"])

    table = Table(rows, colWidths=[60 * mm, 25 * mm, 25 * mm, 25 * mm])
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


def generate_report(archive_entries, scope, output_path, target_date=None):
    """
    Arabic: يبني تقرير PDF احترافي (يومي أو شهري) من عناصر الأرشيف ويحفظه في output_path.
    English: Builds a professional PDF report (daily or monthly) from archive entries and saves it to output_path.

    archive_entries: dict of {key: product_dict}, e.g. from app.py's archive_entries(load_archive()).
    scope: "daily" or "monthly".
    output_path: full .pdf file path to write.
    target_date: a datetime; defaults to now.
    """
    target_date = target_date or datetime.now()
    entries = _entries_for_scope(archive_entries, scope, target_date)

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

    period_label = target_date.strftime("%Y-%m") if scope == "monthly" else target_date.strftime("%Y-%m-%d")
    scope_label_ar = "تقرير شهري" if scope == "monthly" else "تقرير يومي"
    scope_label_en = "Monthly Report" if scope == "monthly" else "Daily Report"

    story = [
        Paragraph("AlphaCode Extractor", title_style),
        Paragraph(_rtl(scope_label_ar) if _ARABIC_SUPPORT else scope_label_en, subtitle_style),
        Paragraph(f"{period_label} — Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}", subtitle_style),
        Spacer(1, 10 * mm),
        Paragraph(_rtl("الملخص العام") if _ARABIC_SUPPORT else "Summary", section_style),
        _build_summary_table(entries),
        Paragraph(_rtl("حسب المستخدم") if _ARABIC_SUPPORT else "By User", section_style),
        _build_per_user_table(entries),
    ]

    doc.build(story)
    return output_path