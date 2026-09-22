"""
Arabic: ربط هوية المستخدم بين المصدرين.

        المشكلة الحقيقية: أرشيف AlphaCode يحمل `added_by` بأسماء عربية ("معتز"، "يوسف")،
        وتطبيق محدّث الصور يحمل `OperatorName` نصاً حراً يكتبه المشغّل بنفسه أول تشغيل —
        وقد يكتبه "yousef" (وهو فعلاً المُحفِّز الذي يفتح وضع المطوّر هناك، انظر
        DEVELOPER_NAME_TRIGGER) أو "يوسف " بمسافة، أو "أبو يوسف". **لا يصح افتراض تطابق
        نصي.** بلا ربط صريح سيظهر نفس الشخص صفّين بالتقرير، وهذا بالضبط نوع الخطأ الذي
        جعل تقريراً سابقاً يبدو صحيحاً وهو ناقص.

        **المصدر الأدق للهوية هو الخادم نفسه**: `sync.php` يحمل جدولي `members` و
        `member_aliases`، و`action=whoami` يطابق بالاسم أو بأي مرادف بلا حساسية لحالة
        الأحرف ويرجّع `display_name`. لذلك تطبيق محدّث الصور يحلّ اسم مشغّله عبر whoami
        **قبل** تسجيل وحدة العمل، فتصل الوحدة للأرشيف وهي تحمل الاسم القانوني أصلاً.
        الخريطة أدناه هي شبكة الأمان لما لا يستطيع الخادم حلّه: سجلات قديمة كُتبت قبل
        هذا الربط، أو اسم لم يُضَف بعد لجدول member_aliases.

        لذلك الربط طبقتان:
          (1) **خريطة صريحة** يكتبها المشرف بملف `report_identities.json` جوار الأرشيف:
              {"يوسف": ["yousef", "Yousef Alhamzy", "image_updater:yousef"]}
              هذه هي الطبقة الوحيدة التي تستطيع ربط أبجديتين مختلفتين. لا تُخمَّن.
          (2) **تطبيع نصي** للفروق الإملائية داخل نفس الأبجدية (مسافات زائدة، تطويل،
              تشكيل، أ/إ/آ، ى/ي، ة/ه). يربط "يوسف " بـ"يوسف" ولا يربطها أبداً بـ"yousef".

        وحتى لا يُخفي الربط خطأً: جدول "حسب المستخدم والمصدر" بالتقرير يُظهر المصادر التي
        ظهر تحتها كل مستخدم — فلو انقسم شخص لصفّين يُرى ذلك فوراً بدل أن يُبتلع بصمت.

English: User-identity linking across the two sources.

         The real problem: the AlphaCode archive carries `added_by` as Arabic names
         ("معتز", "يوسف"), while the image-updater app carries `OperatorName` as free text
         the operator types at first launch - possibly "yousef" (which is in fact the
         trigger that unlocks developer mode there, see DEVELOPER_NAME_TRIGGER), or "يوسف "
         with a trailing space, or "أبو يوسف". **Textual equality must not be assumed.**
         Without explicit linking the same person shows up as two report rows - exactly the
         class of mistake that made an earlier report look correct while being incomplete.

         So linking has two layers:
           (1) An **explicit map** the supervisor writes in `report_identities.json` next to
               the archive:
               {"يوسف": ["yousef", "Yousef Alhamzy", "image_updater:yousef"]}
               This is the only layer that can bridge two different alphabets. It is never
               guessed.
           (2) **Text normalization** for spelling differences within the same alphabet
               (extra spaces, tatweel, diacritics, أ/إ/آ, ى/ي, ة/ه). It links "يوسف " to
               "يوسف" and never links either to "yousef".

         And so that linking never hides a mistake: the report's "by user and source" table
         shows which sources each user appeared under - so a person split across two rows is
         seen immediately instead of being silently swallowed.
"""

from __future__ import annotations

import json
import logging
import os
import re

logger = logging.getLogger("alphacode")

IDENTITY_MAP_FILENAME = "report_identities.json"

# Arabic: التشكيل والتطويل - تُحذف قبل المقارنة فقط، لا تُمس البيانات المخزّنة.
# English: Diacritics and tatweel - stripped for comparison only, stored data is untouched.
_ARABIC_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")

_LETTER_FOLDING = {
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
    "ى": "ي", "ئ": "ي",
    "ة": "ه",
    "ؤ": "و",
}

UNKNOWN_USER_AR = "غير محدد"
UNKNOWN_USER_EN = "Unknown"


def normalize_identity(raw):
    """
    Arabic: يطبّع نص اسم للمقارنة فقط (مسافات، تطويل، تشكيل، أحرف متبادلة، حالة أحرف
            لاتينية). لا يترجم ولا ينقل بين الأبجديات — هذا عمل الخريطة الصريحة.
    English: Normalizes a name string for comparison only (spaces, tatweel, diacritics,
             interchangeable letters, Latin case). It never transliterates between
             alphabets - that is the explicit map's job.
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    text = _ARABIC_DIACRITICS.sub("", text)
    text = "".join(_LETTER_FOLDING.get(ch, ch) for ch in text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.casefold()


def load_identity_map(directory):
    """
    Arabic: يقرأ خريطة الهوية الصريحة إن وُجدت. غيابها ليس خطأً — يعني فقط أن الربط
            سيعتمد على التطبيع النصي وحده. أي تلف بالملف يُسجَّل بوضوح ولا يُسقط التقرير.
    English: Reads the explicit identity map when present. Its absence is not an error - it
             just means linking falls back to text normalization alone. A corrupt file is
             logged clearly and never brings the report down.

    Returns: {normalized_alias: canonical_display_name}
    """
    if not directory:
        return {}
    path = os.path.join(directory, IDENTITY_MAP_FILENAME)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        logger.warning("Identity map at %s is unreadable, falling back to text normalization only: %s", path, exc)
        return {}
    if not isinstance(raw, dict):
        logger.warning("Identity map at %s is not a JSON object, ignoring it.", path)
        return {}

    resolved = {}
    for canonical, aliases in raw.items():
        canonical_name = str(canonical or "").strip()
        if not canonical_name:
            continue
        # Arabic: الاسم القانوني يربط نفسه أيضاً، حتى لا يتوقف الربط على ذكره بالقائمة.
        # English: The canonical name maps to itself too, so linking never depends on it
        #          being repeated inside its own alias list.
        resolved[normalize_identity(canonical_name)] = canonical_name
        for alias in (aliases if isinstance(aliases, list) else [aliases]):
            alias_key = normalize_identity(alias)
            if alias_key:
                resolved[alias_key] = canonical_name
    return resolved


def resolve_identity(raw_user, source=None, identity_map=None):
    """
    Arabic: يرجّع اسم العرض الموحَّد لمستخدم. يجرّب الخريطة بمفتاح "<المصدر>:<الاسم>" أولاً
            (يسمح بأن يكون نفس النص لشخصين مختلفين بمصدرين مختلفين)، ثم بالاسم وحده، ثم
            يرجّع الاسم كما ورد مجرّداً من المسافات.
    English: Returns the unified display name for a user. Tries the map with
             "<source>:<name>" first (so the same text can be two different people in two
             different sources), then the bare name, then returns the name as-is, trimmed.
    """
    identity_map = identity_map or {}
    raw = str(raw_user or "").strip()
    if not raw:
        return ""

    if source:
        scoped = identity_map.get(normalize_identity(f"{source}:{raw}"))
        if scoped:
            return scoped
    mapped = identity_map.get(normalize_identity(raw))
    if mapped:
        return mapped
    return raw


def unknown_user_label(arabic_support):
    """Arabic: تسمية المستخدم غير المحدد. English: The label for an unidentified user."""
    return UNKNOWN_USER_AR if arabic_support else UNKNOWN_USER_EN
