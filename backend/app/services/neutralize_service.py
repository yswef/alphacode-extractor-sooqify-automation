"""Arabic: تعطيل السيرفر المركزي بلا تحديث sync.php — بأوامر النسخة القديمة المتاحة فقط.

المشكلة التي يحلّها هذا الملف: لو كان المرفوع على الاستضافة نسخة sync.php قديمة (بلا
action=erase) وتعذّر تحديثها، فلا توجد أي قوة تحذف صفاً واحداً — لكن توجد أوامر *تُحدّث* وتحلّ
محلّ الحذف فعلياً:

| الأمر | ما يفعله للتعطيل |
|---|---|
| `pull` | يقرأ كل المنتجات بحمولاتها الكاملة (وفيه `id` كل منتج، وهو شرط قبول التحديث) |
| `brands` | يقرأ خريطة البراندات الحالية قبل استبدالها (للتوثيق والنسخة الاحتياطية) |
| `brands/sync` | **يستبدل جدول البراندات كاملاً** بقائمة يقدمها العميل (`DELETE FROM brands` ثم إدراج) — فتُحذف كل البراندات الحقيقية ولا يبقى إلا براند وهمي واحد |
| `push` | **يُحدّث صفّ المنتج نفسه** (نفس المفتاح ونفس المعرّف) ببيانات موحّدة بلا قيمة، ويُرفض فقط إذا اختلف المعرّف — فنحن نبقي المعرّف كما هو ونوحّد كل الباقي |
| `reserve_id` | يقدّم عدّاد المعرّفات المزيد من الخطوات |

فالنتيجة على المستوى البياناتي: كل منتج مرفوع صار صفاً موحّداً بلا اسم ولا كود ولا سعر ولا صور،
وكل براند حقيقي اختفى، وأي محاولة لإعادة إضافة منتج سبق رفعه تصطدم بحجز المفتاح (‎duplicate‎)،
وكل منتج جديد يُربط إجبارياً بالبراند الوهمي الوحيد الباقي.

حدود لا يجوز تجميلها: الأعضاء لا يمكن حذفهم (لا يوجد أمر يقرأ أو يحذف جدولهم سوى `whoami`)،
فالدخول يبقى متاحاً في النسخ القديمة، وما يبقى صفاً في الجداول لا يُحذف نهائياً — هذا تعطيل
بياناتي كامل لا حذف. الكيل النهائي (منع كل شيء لكل الأجهزة) يحتاج حذف قاعدة البيانات من جانب
الاستضافة (عدّة الحذف) أو ملف shutdown.lock على نسخة sync.php جديدة.

English: Neutralizing the central server without updating sync.php - using only the actions the old
copy already has.

The problem this file solves: when the deployed sync.php predates action=erase and cannot be
updated, no action can delete a row - but actions that *update* replace deletion in practice:

| Action | What it does for the shutdown |
|---|---|
| `pull` | reads every product with its full payload (each carries its `id`, which the update requires) |
| `brands` | reads the current brand map before replacing it (for the record and the backup) |
| `brands/sync` | **replaces the whole brands table** with a client-supplied list (`DELETE FROM brands` then insert) - every real brand gone, one placeholder brand left |
| `push` | **updates the product's own row** (same key, same id) with unified, worthless data; it is refused only when the id differs - so keep the id and unify everything else |
| `reserve_id` | advances the ID counter by more steps |

The data-level outcome: every uploaded product is a unified row with no name, code, price or images;
every real brand is gone; re-adding a product that was ever uploaded hits the key reservation
(`duplicate`); and every new product is forced onto the single placeholder brand.

Limits that must not be prettified: members cannot be deleted (no action reads or deletes their table
except `whoami`), so login stays possible in old copies, and rows remain rows - this is a full
data-level shutdown, not a deletion. A true total kill (every device, every copy) needs the database
dropped host-side (the wipe kit) or a shutdown.lock on a newer sync.php.
"""
import logging
import threading
import time
from datetime import datetime

from app.core.config import NEUTRALIZE_STATE_PATH, load_json_file, save_json_atomic
from app.repositories.sync_config_repository import load_sync_config
from app.repositories.sync_lock_repository import is_sync_locked
from app.services import emergency_service, sync_service

logger = logging.getLogger("alphacode")

# Arabic: العبارة التي يكتبها الأدمن بنفسه - لا تعطيل بضغطة عابرة.
# English: The phrase the admin types - no shutdown by a stray click.
NEUTRALIZE_CONFIRM_PHRASE = "NEUTRALIZE"

# Arabic: البراند الوهمي الذي يبقى بعد استبدال القائمة (يجب أن يبقى براند واحد على الأقل لأن
#         brands/sync يرفض قائمة فاضية، وهو يرفض أيضاً Back-end أقل من براند أو أكثر من 500).
# English: The placeholder brand left after the replacement (at least one is mandatory because
#          brands/sync refuses an empty list, and it also rejects fewer than 1 or more than 500).
DEFAULT_BRAND_NAME = "AlphaCode"
DEFAULT_BRAND_ID = 1
MAX_BRAND_ID = 500
MAX_EXTRA_BRANDS = 100

# Arabic: خطوات عدّاد المعرّفات: كل خطوة نداء reserve_id حقيقي إلى السيرفر.
# English: ID counter steps: every step is a real reserve_id call to the server.
DEFAULT_ID_STEPS = 500
MAX_ID_STEPS = 5000

# Arabic: تأخير بين كل طلبين - نفس فلسفة المزامنة (لا نغرق الاستضافة فنصطدم بحظر 403 فينقطع
#         التعطيل في منتصفه).
# English: Pacing between requests - the same philosophy as sync (never flood the host into a 403
#          block that cuts the shutdown in half).
NEUTRALIZE_PACING_SECONDS = 0.2
NEUTRALIZE_ID_PACING_SECONDS = 0.15

# Arabic: علامة تُكتب في كل صف موحّد: تسمح باستئناف العملية بعد انقطاع دون إعادة ما انتهى،
#         وتُظهر لمن يفتح السيرفر لاحقاً أن البيانات عُطّلت عن قصد لا أنها تلفت.
# English: A marker written into every unified row: it lets the job resume after an interruption
#          without redoing finished work, and shows anyone opening the server later that the data was
#          neutralized deliberately rather than corrupted.
NEUTRALIZE_MARKER = "alphacode-neutralize-v1"

# Arabic: القيم الموحّدة الافتراضية التي تصير كل المنتجات عليها.
# English: The default unified values every product becomes.
DEFAULT_PLACEHOLDER = {
    "name_en": "AlphaCode",
    "name_ar": "AlphaCode",
    "description_en": "",
    "description_ar": "",
    "style_code": "",
    "search_code": "",
    "price": 0,
    "folder": "",
    "added_by": "AlphaCode",
}

ALLOWED_PLACEHOLDER_KEYS = (
    "name_en", "name_ar", "description_en", "description_ar",
    "style_code", "search_code", "price", "folder", "added_by",
)

# Arabic: عدد الصفوف بين كل حفظ لحالة التقدّم على القرص (لا نحفظ في كل منتج).
# English: Rows between progress writes to disk (never once per product).
PROGRESS_SAVE_EVERY = 25

_worker_thread = None
_worker_thread_lock = threading.Lock()


def _now():
    """Arabic: طابع زمني للقراءة. English: A timestamp for readability."""
    return datetime.now().isoformat(timespec="seconds")


def _to_int(value, fallback):
    """Arabic: تحويل آمن إلى عدد صحيح. English: Safe integer coercion."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return int(fallback)


def _empty_state():
    return {
        "running": False,
        "phase": "",
        "started_at": "",
        "finished_at": "",
        "actor": "",
        "server_url": "",
        "backup_file": "",
        "rewrite_products": False,
        "replace_brands": False,
        "bump_ids": False,
        "lock_local": False,
        "brand_name": "",
        "brand_id": 0,
        "id_steps": 0,
        "products_total": 0,
        "products_done": 0,
        "products_skipped": 0,
        "products_reserved": 0,
        "products_failed": 0,
        "products_already": 0,
        "ids_bumped": 0,
        "previous_brands": [],
        "brands_replaced": 0,
        "locked": False,
        "last_error": "",
        "warnings": [],
        "errors": [],
    }


def load_neutralize_state():
    """Arabic: قراءة حالة التعطيل مع القيم الافتراضية. English: Read the neutralize state with defaults."""
    state = _empty_state()
    stored = load_json_file(NEUTRALIZE_STATE_PATH, {})
    if isinstance(stored, dict):
        state.update({key: stored.get(key, state[key]) for key in state})
    return state


def save_neutralize_state(state):
    """Arabic: حفظ حالة التعطيل. English: Persist the neutralize state."""
    save_json_atomic(NEUTRALIZE_STATE_PATH, state)
    return state


def _update_state(**updates):
    """Arabic: تحديث حالة التعطيل على القرص. English: Update the neutralize state on disk."""
    state = load_neutralize_state()
    state.update(updates)
    return save_neutralize_state(state)


def normalize_options(raw):
    """
    Arabic: تنظيف خيارات التعطيل القادمة من الواجهة والتحقق من حدودها:
              RewriteProducts (توحيد بيانات المنتجات) — افتراضياً صحيح،
              ReplaceBrands (استبدال كل البراندات) — افتراضياً صحيح،
              BumpIds (تقديم العدّاد) — افتراضياً خطأ (اختياري، ولا يمنع أحداً فعلياً)،
              LockLocal (إيقاف المزامنة على هذا الجهاز) — افتراضياً صحيح،
              BrandName/BrandId/ExtraBrands/IdSteps/Placeholder.
    English: Sanitize the neutralize options coming from the UI and enforce their limits:
             RewriteProducts (unify product data) - true by default,
             ReplaceBrands (replace every brand) - true by default,
             BumpIds (advance the counter) - false by default (optional, and it blocks nobody),
             LockLocal (stop sync on this machine) - true by default,
             BrandName/BrandId/ExtraBrands/IdSteps/Placeholder.
    """
    raw = raw if isinstance(raw, dict) else {}
    brand_name = str(raw.get("BrandName") or DEFAULT_BRAND_NAME).strip() or DEFAULT_BRAND_NAME
    brand_id = _to_int(raw.get("BrandId"), DEFAULT_BRAND_ID)
    if brand_id <= 0:
        brand_id = DEFAULT_BRAND_ID
    brand_id = min(brand_id, MAX_BRAND_ID)

    extra_brands = []
    for entry in (raw.get("ExtraBrands") or [])[:MAX_EXTRA_BRANDS]:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        entry_id = _to_int(entry.get("id"), 0)
        if name and entry_id > 0 and entry_id != brand_id and name != brand_name:
            extra_brands.append({"id": min(entry_id, MAX_BRAND_ID), "name": name})

    placeholder = dict(DEFAULT_PLACEHOLDER)
    supplied = raw.get("Placeholder")
    custom_placeholder = False
    if isinstance(supplied, dict):
        for key in ALLOWED_PLACEHOLDER_KEYS:
            if key in supplied and supplied[key] is not None:
                custom_placeholder = True
                placeholder[key] = supplied[key]
    if not isinstance(placeholder.get("price"), (int, float)):
        placeholder["price"] = _to_int(placeholder.get("price"), 0)

    id_steps = _to_int(raw.get("IdSteps"), DEFAULT_ID_STEPS)
    id_steps = max(0, min(id_steps, MAX_ID_STEPS))

    return {
        "rewrite_products": bool(raw.get("RewriteProducts", True)),
        "replace_brands": bool(raw.get("ReplaceBrands", True)),
        "bump_ids": bool(raw.get("BumpIds", False)),
        "lock_local": bool(raw.get("LockLocal", True)),
        "brand_name": brand_name,
        "brand_id": brand_id,
        "extra_brands": extra_brands,
        "id_steps": id_steps,
        "placeholder": placeholder,
        "custom_placeholder": custom_placeholder,
    }


def build_neutralized_payload(item, brand_name, brand_id, placeholder, stamp):
    """
    Arabic: بناء الحمولة الموحّدة التي ستطمس المنتج الحالي: نحفظ المعرّف كما هو حرفياً (شرط
            قبول `push` للتحديث) ونستبدل كل الباقي، ونُفرغ الصور والمقاسات والاختلافات، ونكتب
            علامة التعطيل. ترجع None للصفوف بلا معرّف (حجوزات) فلا تُلمس.

            product_type يبقى كما هو فلا تتعطل المسارات الخاصة بكل نوع، ويمكن للأدمن توحيده
            بنفسه عبر Placeholder إن أراد.
    English: Build the unified payload that blanks the current product: keep the id verbatim (push
             requires it for an update), replace everything else, empty images/sizes/variants, and
             write the neutralize marker. Returns None for rows without an id (reservations) so they
             are never touched.

             product_type is preserved so per-type code paths keep working; the admin can unify it
             too through Placeholder when wanted.
    """
    product_id = item.get("id")
    if product_id in (None, "") or not isinstance(item, dict):
        return None
    payload = {
        "id": product_id,
        "name_en": placeholder["name_en"],
        "name_ar": placeholder["name_ar"],
        "description_en": placeholder["description_en"],
        "description_ar": placeholder["description_ar"],
        "style_code": placeholder["style_code"],
        "search_code": placeholder["search_code"],
        "price": placeholder["price"],
        "folder": placeholder["folder"],
        "added_by": placeholder["added_by"],
        "brand_name": brand_name,
        "brand_id": brand_id,
        "product_type": item.get("product_type") or "shoes",
        "workflow_status": "prepared",
        "store_submission_status": "not_submitted",
        "images": [],
        "image_urls": [],
        "variants": [],
        "sizes": [],
        "neutralized": True,
        "neutralized_by": NEUTRALIZE_MARKER,
        "neutralized_at": stamp,
    }
    return payload


# ---------------------------------------------------------------------------
# Arabic: المعاينة (قراءة فقط) — تعرض بالضبط ماذا سيُستبدل قبل أي كتابة.
# English: The preview (read-only) - shows exactly what will be replaced before any write.
# ---------------------------------------------------------------------------

def neutralize_plan(raw_options=None):
    """Arabic: معاينة ما سيحدث على السيرفر بلا أي تغيير: كم منتجاً سيُوحَّد، وأي البراندات ستُحذف. English: Preview what will happen server-side with no change at all: how many products get unified and which brands will be deleted."""
    opts = normalize_options(raw_options)
    snapshot = emergency_service.collect_server_snapshot()
    items = snapshot.get("items") or {}
    brands = snapshot.get("brands") or []
    with_id = {key: item for key, item in items.items()
               if isinstance(item, dict) and item.get("id") not in (None, "")}
    reserved = len(items) - len(with_id)
    already = sum(1 for item in with_id.values() if item.get("neutralized_by") == NEUTRALIZE_MARKER)
    current_brand_names = [str(brand.get("name") or "") for brand in brands if isinstance(brand, dict)]

    estimated = 0.0
    if opts["rewrite_products"]:
        estimated += len(with_id) * NEUTRALIZE_PACING_SECONDS
    if opts["bump_ids"]:
        estimated += opts["id_steps"] * NEUTRALIZE_ID_PACING_SECONDS

    plan = {
        "success": True,
        "server_reachable": bool(snapshot.get("reachable")),
        "server_error": snapshot.get("error") or "",
        "server_url": snapshot.get("url") or "",
        "product_count": len(items),
        "products_to_rewrite": len(with_id),
        "products_already_neutralized": already,
        "reserved_rows": reserved,
        "brands_current": current_brand_names,
        "brands_count": len(current_brand_names),
        "will_rewrite_products": opts["rewrite_products"],
        "will_replace_brands": opts["replace_brands"],
        "will_bump_ids": opts["bump_ids"],
        "will_lock_local": opts["lock_local"],
        "brand_name": opts["brand_name"],
        "brand_id": opts["brand_id"],
        "extra_brands": opts["extra_brands"],
        "id_steps": opts["id_steps"],
        "placeholder": opts["placeholder"],
        "estimated_seconds": int(estimated) + 5,
        "locked_already": is_sync_locked(),
        "warnings": _plan_warnings(opts),
        "blocked_reason": "",
    }
    if not snapshot.get("reachable"):
        plan["blocked_reason"] = (
            "لا يمكن التعطيل الآن: " + (snapshot.get("error") or "السيرفر غير قابل للوصول")
        )
    elif is_sync_locked():
        plan["blocked_reason"] = (
            "المزامنة موقوفة نهائياً على هذا الجهاز — لا معنى لتعطيل سيرفر لا نتصل به. "
            "لفتح القفل استخدم مسار الاستعادة أو احذف sync_lock.json."
        )
    elif not items and not brands:
        plan["blocked_reason"] = "السيرفر فارغ أصلاً — لا يوجد ما يُعطَّل."
    return plan


def _plan_warnings(opts):
    """Arabic: تحذيرات صريحة توضع أمام الأدمن قبل التنفيذ — بلا أي تجميل. English: Explicit warnings shown to the admin before the run - nothing prettified."""
    warnings = [
        "لا حذف فعلي: نسخة sync.php القديمة لا تملك أي أمر يحذف صفاً، فالصفوف تبقى لكن ببيانات "
        "موحّدة بلا قيمة. الحذف الحقيقي يحتاج ملف SQL من جانب قاعدة البيانات (عدّة الحذف).",
        "الأعضاء لا يمكن حذفهم ولا منع دخولهم بأي أمر متاح (لا يوجد أمر على جدولهم سوى whoami)، "
        "فالدخول يبقى ممكناً في النسخ القديمة — التعطيل بياناتي لا وصولي.",
    ]
    if opts["replace_brands"]:
        warnings.append(
            "استبدال البراندات يحذف كل البراندات الحقيقية من جدول brands، وكل منتج جديد من أي جهاز "
            "سيُربط إجبارياً بالبراند الوهمي الوحيد الباقي، وأي محاولة رفع ببراند حقيقي تُرفض (409)."
        )
        warnings.append(
            "لو كان في قاعدة البيانات مفتاح أجنبي (Foreign Key) يشير إلى جدول brands فسيرفض السيرفر "
            "الاستبدال — عندها يُلغى التعطيل كله ولا يتغيّر شيء."
        )
    if opts["rewrite_products"]:
        warnings.append(
            "توحيد المنتجات يطمس الاسم والوصف والأكواد والسعر والصور بكل صف، ولا رجعة بعده إلا من "
            "النسخة الاحتياطية — والنسخة تُؤخذ تلقائياً قبل أي كتابة."
        )
        warnings.append(
            "كل منتج سبق رفعه يصبح غير قابل لإعادة الإضافة من أي جهاز (حجز المفتاح يرد duplicate) — "
            "وهذا مقصود."
        )
        warnings.append(
            "قد تبقى صفوف الصور/المقاسات القديمة في الجداول الفرعية إذا كان sync_write_helpers لا "
            "يحذفها قبل الكتابة الجديدة (الملف على الاستضافة وغير مرئي لنا)."
        )
    if opts["bump_ids"]:
        warnings.append(
            f"تقديم العدّاد {opts['id_steps']} خطوة لا يمنع أحداً من العمل؛ فائدته الوحيدة أن أرقام "
            "المنتجات الجديدة تبدأ من بعيد ولا تصطدم بمعرّفات قديمة عند إعادة الرفع لاحقاً."
        )
    if opts["lock_local"]:
        warnings.append(
            "إيقاف المزامنة على هذا الجهاز يمسح رابط السيرفر والكود منه ويمنع أي نداء شبكة بعده — "
            "ويمكن فتحه لاحقاً من مسار الاستعادة."
        )
    return warnings


# ---------------------------------------------------------------------------
# Arabic: التنفيذ — خيط خلفي مع حالة تقدّم قابلة للاستئناف.
# English: The run - a background thread with resumable progress.
# ---------------------------------------------------------------------------

def start_neutralize_job(raw_options, confirm, actor="", guard_password=""):
    """
    Arabic: بدء التعطيل: تحقق العبارة + تحقق الوصول للسيرفر، ثم خيط خلفي يُنفّذ:
            نسخة احتياطية إلزامية ← استبدال البراندات ← توحيد كل المنتجات ← تقديم العدّاد ←
            إيقاف المزامنة على هذا الجهاز.
    English: Start the neutralize job: verify the phrase + server reachability, then a background
             thread runs: mandatory backup -> replace brands -> unify every product -> advance the
             counter -> stop sync on this machine.
    """
    global _worker_thread
    confirm = str(confirm or "").strip()
    if confirm != NEUTRALIZE_CONFIRM_PHRASE:
        return {"success": False, "error": f"اكتب العبارة {NEUTRALIZE_CONFIRM_PHRASE} حرفياً للتأكيد."}

    opts = normalize_options(raw_options)
    if not opts["rewrite_products"] and not opts["replace_brands"] and not opts["bump_ids"]:
        return {"success": False, "error": "اختر خطوة واحدة على الأقل (توحيد المنتجات أو استبدال البراندات أو تقديم العدّاد)."}

    if is_sync_locked():
        ok, guard_error = emergency_service.verify_local_guard(guard_password)
        if not ok:
            return {"success": False, "error": guard_error}

    with _worker_thread_lock:
        if (_worker_thread is not None and _worker_thread.is_alive()) or load_neutralize_state().get("running"):
            return {"success": False, "error": "عملية تعطيل قائمة بالفعل — انتظر انتهاءها أو افتح تقدّمها."}

    config = load_sync_config()
    server_url = str(config.get("ServerUrl") or "")
    token = str(config.get("Token") or "")
    if not server_url or not token:
        return {"success": False, "error": "لا يوجد رابط سيرفر وكود مزامنة محفوظان على هذا الجهاز."}

    # Arabic: فحص فعلي قبل أي كتابة: لا نبدأ تعطيلاً على سيرفر لا نستطيع قراءته أصلاً.
    # English: A real check before any write: never start a shutdown against a server we cannot read.
    data, error = sync_service.sync_http_call(server_url, token, "pull", {"since": ""}, method="POST")
    if error:
        return {"success": False, "error": "تعذر قراءة السيرفر قبل البدء: " + emergency_service.friendly_error(error)}

    state = _empty_state()
    state.update({
        "running": True,
        "phase": "backup",
        "started_at": _now(),
        "finished_at": "",
        "actor": str(actor or ""),
        "server_url": server_url,
        "rewrite_products": opts["rewrite_products"],
        "replace_brands": opts["replace_brands"],
        "bump_ids": opts["bump_ids"],
        "lock_local": opts["lock_local"],
        "brand_name": opts["brand_name"],
        "brand_id": opts["brand_id"],
        "id_steps": opts["id_steps"] if opts["bump_ids"] else 0,
    })
    save_neutralize_state(state)

    _worker_thread = threading.Thread(
        target=_worker,
        args=(opts, server_url, token, guard_password),
        name="alphacode-neutralize-worker",
        daemon=True,
    )
    _worker_thread.start()
    logger.warning("NEUTRALIZE started against %s (options=%s)", server_url, {
        key: opts[key] for key in ("rewrite_products", "replace_brands", "bump_ids", "lock_local", "id_steps")
    })
    return {"success": True, "state": load_neutralize_state()}


def _worker(opts, server_url, token, guard_password):
    """Arabic: الخيط الفعلي — كل خطوة تُحفظ حالتها، وأي فشل قاتل يوقف البقية ويشرح السبب. English: The real thread - every step records its state, and any fatal failure stops the rest and says why."""
    errors = []
    warnings = []
    try:
        # 1) النسخة الاحتياطية أولاً — لا تعطيل بلا نسخة، ونفس النسخة تصلح لإعادة الرفع لاحقاً.
        try:
            backup = emergency_service.create_emergency_backup(
                note="قبل تعطيل السيرفر (توحيد البيانات واستبدال البراندات)",
                actor=load_neutralize_state().get("actor") or "",
            )
        except Exception as exc:
            logger.exception("Neutralize aborted: backup failed: %s", exc)
            _update_state(running=False, phase="failed", finished_at=_now(),
                          last_error=f"تعذر إنشاء النسخة الاحتياطية، ولم يُغيَّر شيء على السيرفر: {exc}")
            return
        if not backup.get("server_reachable"):
            _update_state(
                running=False, phase="failed", finished_at=_now(), backup_file=backup.get("name") or "",
                last_error=("السيرفر غير قابل للوصول فلم تُقرأ بياناته، وأُلغي التعطيل حتى لا تتلف "
                            "بيانات بلا نسخة: " + str(backup.get("server_error") or "")),
            )
            return
        _update_state(phase="brands", backup_file=backup.get("name") or "")

        # 2) استبدال جدول البراندات كاملاً (وهذا هو "حذف البراندات" المتاح في النسخة القديمة).
        if opts["replace_brands"]:
            brand_rows = [{"id": opts["brand_id"], "name": opts["brand_name"]}] + opts["extra_brands"]
            data, error = sync_service.sync_http_call(
                server_url, token, "brands/sync",
                {"confirm_replace": True, "brands": brand_rows}, method="POST",
            )
            if error or not (data or {}).get("success"):
                reason = error or (data or {}).get("error") or "رفض السيرفر استبدال البراندات"
                logger.error("Neutralize stopped at the brand step: %s", reason)
                _update_state(
                    running=False, phase="failed", finished_at=_now(),
                    last_error=("تعذّر استبدال البراندات فأُلغي التعطيل كله ولم تُلمس المنتجات: "
                                + str(reason) +
                                " — لو كان السبب مفتاحاً أجنبياً على جدول brands فأزل خيار استبدال "
                                "البراندات ونفّذ توحيد المنتجات وحده."),
                )
                return
            previous = [str(brand.get("name") or "") for brand in (data.get("previous_brands") or [])
                        if isinstance(brand, dict)]
            _update_state(phase="products", previous_brands=previous,
                          brands_replaced=_to_int(data.get("brand_count"), len(brand_rows)))
            logger.warning("Neutralize: brands replaced (%s removed, %s kept)",
                           len(previous), data.get("brand_count"))
        else:
            _update_state(phase="products")

        # 3) توحيد بيانات كل منتج: نفس المفتاح ونفس المعرّف وكل الباقي موحّد بلا قيمة.
        if opts["rewrite_products"]:
            items_data, items_error = sync_service.sync_http_call(server_url, token, "pull", {"since": ""}, method="POST")
            if items_error:
                _update_state(running=False, phase="failed", finished_at=_now(),
                              last_error="تعذر سحب قائمة المنتجات: " + emergency_service.friendly_error(items_error))
                return
            items = (items_data or {}).get("items") or {}
            if not isinstance(items, dict):
                items = {}
            stamp = _now()
            targets = {key: item for key, item in items.items()
                       if isinstance(item, dict) and item.get("id") not in (None, "")}
            reserved = len(items) - len(targets)
            _update_state(products_total=len(targets), products_reserved=reserved)

            done = already = failed = skipped = 0
            brand_id_by_key = {}
            if not opts["replace_brands"]:
                # Arabic: بدون استبدال البراندات نبقي براند كل منتج كما هو، لأن push يرفض أي
                #         براند غير موجود في خريطة السيرفر.
                # English: Without replacing brands, each product keeps its own brand, because push
                #          rejects any brand missing from the server map.
                for brand in (emergency_service.collect_server_snapshot().get("brands") or []):
                    if isinstance(brand, dict) and str(brand.get("name") or "").strip():
                        brand_id_by_key[str(brand["name"]).strip()] = _to_int(brand.get("id"), 0)

            for index, (key, item) in enumerate(targets.items(), start=1):
                if (opts["placeholder"] == DEFAULT_PLACEHOLDER and not opts["custom_placeholder"]
                        and item.get("neutralized_by") == NEUTRALIZE_MARKER):
                    already += 1  # Arabic: صف سبق توحيده في محاولة سابقة — استئناف بلا إعادة. English: already unified in an earlier run - resume without redoing.
                    continue
                brand_name = opts["brand_name"]
                brand_id = opts["brand_id"]
                if not opts["replace_brands"]:
                    brand_name = str(item.get("brand_name") or item.get("BrandName") or "").strip()
                    brand_id = brand_id_by_key.get(brand_name, _to_int(item.get("brand_id"), 0))
                    if not brand_name or not brand_id:
                        skipped += 1
                        if len(errors) < 20:
                            errors.append({"key": str(key), "error": "بلا براند معروف في خريطة السيرفر — تُخطّي"})
                        continue
                payload = build_neutralized_payload(item, brand_name, brand_id, opts["placeholder"], stamp)
                if payload is None:
                    skipped += 1
                    continue
                data, error = sync_service.sync_http_call(
                    server_url, token, "push", {"key": key, "product": payload}, method="POST"
                )
                if error in ("sync_throttled", "sync_blocked_403"):
                    # Arabic: الاستضافة حظرتنا (403) — التوقف الآن أرحم من تكرار يطيل الحظر، والعملية
                    #         قابلة للاستئناف: الصفوف الموحّدة تحمل علامة تُتخطّى في التشغيل التالي.
                    # English: The host blocked us (403) - stopping now beats retrying and extending
                    #          the block, and the job resumes: unified rows carry a marker that the
                    #          next run skips.
                    warnings.append(
                        "توقفت الاستضافة عن قبول الطلبات مؤقتاً (403) عند المنتج رقم "
                        f"{index} من {len(targets)} — أعد تشغيل التعطيل بعد انتهاء التهدئة وسيكمل "
                        "من حيث توقّف (الصفوف الموحّدة تُتخطّى تلقائياً)."
                    )
                    skipped += len(targets) - index + 1
                    _update_state(products_done=done, products_failed=failed, products_skipped=skipped,
                                  products_already=already, errors=errors, warnings=warnings)
                    break
                if error or (data or {}).get("duplicate"):
                    failed += 1
                    if len(errors) < 20:
                        # Arabic: نُخزّن سبباً عربياً قصيراً + اسم المنتج ومفتاحه، لأن نصّ requests الخام
                        #         (مثل HTTPSConnectionPool(...)) يملأ اللوحة ولا يقول للأدمن أي منتج
                        #         فشل ولا كيف يجد الاسم في السجل. النص الخام يبقى في error_raw للمراجعة.
                        # English: Store a short readable reason plus the product's original name and
                        #          key: the raw requests text (HTTPSConnectionPool(...)) floods the
                        #          popup and tells the admin neither which product failed nor what to
                        #          look for. The raw text stays in error_raw for review.
                        errors.append({
                            "key": str(key),
                            "name": str(item.get("name_en") or item.get("name_ar") or "").strip(),
                            "error": (emergency_service.friendly_error(error) if error
                                      else "duplicate (المعرّف محجوز لصف آخر)"),
                            "error_raw": str(error or "duplicate")[:500],
                        })
                else:
                    done += 1
                if index % PROGRESS_SAVE_EVERY == 0:
                    _update_state(products_done=done, products_failed=failed, products_skipped=skipped,
                                  products_already=already, errors=errors)
                if NEUTRALIZE_PACING_SECONDS:
                    time.sleep(NEUTRALIZE_PACING_SECONDS)
            _update_state(products_done=done, products_failed=failed, products_skipped=skipped,
                          products_already=already, errors=errors, phase="ids")
            logger.warning("Neutralize: products unified=%s failed=%s skipped=%s already=%s reserved=%s",
                           done, failed, skipped, already, reserved)

        # 4) تقديم عدّاد المعرّفات (اختياري، ولا يمنع أحداً — قيمته دفاعية فقط).
        if opts["bump_ids"]:
            _update_state(phase="ids")
            bumped = 0
            for _step in range(opts["id_steps"]):
                data, error = sync_service.sync_http_call(server_url, token, "reserve_id", {}, method="POST")
                if error:
                    warnings.append(f"توقّف تقديم العدّاد عند {bumped} خطوة: {error}")
                    break
                bumped += 1
                if _step % PROGRESS_SAVE_EVERY == 0:
                    _update_state(ids_bumped=bumped)
                if NEUTRALIZE_ID_PACING_SECONDS:
                    time.sleep(NEUTRALIZE_ID_PACING_SECONDS)
            _update_state(ids_bumped=bumped)

        # 5) إيقاف المزامنة على هذا الجهاز: مسح الرابط والكود ومنع أي نداء شبكة بعده.
        if opts["lock_local"]:
            _update_state(phase="lock")
            guard = emergency_service.set_local_guard(guard_password)
            emergency_service.lock_local_sync(
                server_erased_at="",
                backup_file=load_neutralize_state().get("backup_file") or "",
                server_url=server_url,
                note="تعطيل السيرفر: توحيد البيانات واستبدال البراندات",
                guard=guard,
            )
            _update_state(locked=True)

        state = load_neutralize_state()
        final_error = ""
        if state.get("products_failed"):
            final_error = f"فشل توحيد {state['products_failed']} منتج — راجع قائمة الأخطاء."
        _update_state(running=False, phase="done", finished_at=_now(), last_error=final_error,
                      warnings=warnings, errors=errors)
        logger.warning("NEUTRALIZE finished: %s", {key: state.get(key) for key in
                       ("products_done", "products_failed", "products_already", "brands_replaced",
                        "ids_bumped", "locked")})
    except Exception as exc:
        logger.exception("Neutralize job failed: %s", exc)
        _update_state(running=False, phase="failed", finished_at=_now(),
                      last_error=f"فشل التعطيل: {exc}", errors=errors, warnings=warnings)


def neutralize_status():
    """Arabic: حالة التعطيل للوحة (وتُرفق مع حالة الإيقاف الطارئ). English: The neutralize state for the popup (also attached to the emergency status)."""
    return load_neutralize_state()
