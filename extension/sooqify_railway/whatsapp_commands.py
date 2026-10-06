"""Authorized WhatsApp command handling; archive reads remain read-only here."""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path

import whatsapp_store as store


_COMMAND_LOCK = threading.Lock()
_LAST_REPORT_REQUEST = {}

HELP_TEXT = (
    "أوامر Sooqify Audit:\n"
    "REPORT — إنشاء وإرسال تقرير CSV وXLSX (وتلخيص الموظفين).\n"
    "STATUS — حالة الربط وآخر فحص.\n"
    "DELETE <LocalID> — معاينة سجل أرشيف واحد فقط، ثم يلزم CONFIRM DELETE <CODE>.\n"
    "CANCEL <CODE> — إلغاء تأكيد الحذف المعلّق.\n"
    "RESTORE <BackupID> — طلب استرجاع سجل محذوف عبر مزامنة الأرشيف المشترك.\n"
    "لا يوجد أي أمر يحذف منتجاً من متجر Sooqify."
)


def _reply(text):
    return {"authorized": True, "reply": str(text or "")[:3900]}


def _positive_int(value):
    try:
        number = int(str(value).strip())
        return number if number > 0 else 0
    except (TypeError, ValueError):
        return 0


def _archive_record_for_local_id(archive, local_id):
    if not isinstance(archive, dict):
        return None
    found = []
    for key, record in archive.items():
        if not isinstance(record, dict):
            continue
        # AlphaCode's archive schema uses `id` as the Local ID. Do not infer it
        # from the Sooqify Store ID, product name, SKU, or dictionary key.
        if _positive_int(record.get("id")) == local_id:
            found.append((str(key), record))
    return found[0] if len(found) == 1 else None


def _start_delete(local_id, sender, archive_loader):
    active_tombstone = next((item for item in store.active_archive_tombstones() if _positive_int(item.get("local_id")) == local_id), None)
    if active_tombstone:
        return _reply(
            f"Local ID {local_id} عليه منع حذف نشط بالفعل. لا يوجد حذف جديد. "
            f"للاسترجاع استخدم: RESTORE {active_tombstone.get('backup_id', '')}"
        )
    try:
        archive = archive_loader()
    except Exception:
        return _reply("تعذر قراءة الأرشيف المشترك؛ لم يتم إنشاء طلب حذف.")
    found = _archive_record_for_local_id(archive, local_id)
    if not found:
        return _reply(
            f"لم أجد سجلاً واحداً مؤكداً بالـ Local ID {local_id} في الأرشيف المشترك. "
            "لم يُنشأ طلب حذف؛ لا أستخدم الاسم أو Store ID كبديل."
        )
    archive_key, record = found
    try:
        pending = store.create_delete_confirmation(local_id, archive_key, record, sender)
    except Exception as exc:
        return _reply(f"تعذر حفظ نسخة ما قبل الحذف؛ لم يُنشأ طلب حذف ({str(exc)[:160]}).")

    name = re.sub(r"\s+", " ", str(record.get("name_en") or record.get("name_ar") or record.get("name") or "(اسم غير متاح)")).strip()[:180]
    brand = re.sub(r"\s+", " ", str(record.get("brand_name") or "غير متاح")).strip()[:80]
    store_id = _positive_int(record.get("store_product_id"))
    store_line = f"Store ID الصريح: {store_id}" if store_id else "Store ID: غير متاح من حقل صريح في سجل الأرشيف"
    return _reply(
        "معاينة حذف سجل أرشيف محلي واحد — لا تغيير حدث بعد.\n"
        f"Local ID: {local_id}\nالاسم: {name}\nالبراند: {brand}\n{store_line}\n"
        "هذا لا يحذف المنتج من متجر Sooqify، ولا يمس صوره المحلية. سيُحفظ سجل احتياطي أولاً. "
        "للموافقة خلال 15 دقيقة أرسل بالضبط: CONFIRM DELETE "
        f"{pending['confirm_code']}\nللإلغاء: CANCEL {pending['confirm_code']}"
    )


def _request_report(sender, report_runner):
    now = time.monotonic()
    with _COMMAND_LOCK:
        previous = _LAST_REPORT_REQUEST.get(sender, 0)
        if now - previous < 45:
            return _reply("يوجد طلب تقرير حديث؛ انتظر قليلاً قبل إنشاء تقرير آخر.")
        _LAST_REPORT_REQUEST[sender] = now
    try:
        report, files = report_runner()
        names = [Path(files[key]).name for key in ("csv", "employees_csv", "xlsx") if files.get(key)]
        summary = report.get("summary", {})
        text = (
            f"تقرير تدقيق Sooqify جاهز ({report.get('generated_at', '')}، {report.get('timezone', '')}).\n"
            f"المنتجات: {report.get('snapshot_product_count', 0)}؛ المطابقات/الملاحظات: "
            f"{summary.get('issues', 0)}؛ الموظفون: {len(report.get('employees', []))}.\n"
            "المرفقات: تقرير التفاصيل CSV، ملخص الموظفين CSV، وملف XLSX."
        )
        store.enqueue_outbox("manual_audit_report", text, attachments=names, recipient=sender)
        return _reply("تم إنشاء التقرير ووضع ملفاته في طابور الإرسال. سأرسل CSV وXLSX عند اتصال WhatsApp بالخدمة.")
    except Exception as exc:
        detail = str(exc)
        if "unavailable" in detail.lower() or "shared alphacode archive" in detail.lower():
            return _reply("تعذر الوصول إلى الأرشيف المشترك؛ لم يُنشأ تقرير ناقص أو مضلل.")
        if "complete Sooqify scan" in detail:
            return _reply("لا توجد لقطة قائمة كاملة بعد؛ لم يُنشأ تقرير.")
        return _reply("فشل إنشاء التقرير؛ لم يتم إرسال ملف تقرير.")


def process_incoming_command(payload, *, archive_loader, report_runner, snapshot_loader):
    """Return a reply only to the configured primary WhatsApp number."""
    if not isinstance(payload, dict):
        return {"authorized": False}
    sender = re.sub(r"\D", "", str(payload.get("sender_number") or ""))[:20]
    primary = store.primary_number()
    if not primary or sender != primary:
        return {"authorized": False}
    if not store.reports_enabled():
        return _reply("خدمة WhatsApp غير مفعّلة أو لم يُضبط رقمها المصرّح به.")

    raw_text = str(payload.get("text") or "").strip()
    if len(raw_text) > 512:
        return _reply("الأمر أطول من الحد المسموح؛ أرسل HELP لعرض الأوامر.")
    text = re.sub(r"\s+", " ", raw_text).strip()
    if text.startswith("/"):
        text = text[1:].strip()
    upper = text.upper()

    if upper in {"HELP", "مساعدة", "الأوامر"}:
        return _reply(HELP_TEXT)
    if upper in {"STATUS", "حالة", "الحالة"}:
        state = store.runtime_status()
        snapshot = snapshot_loader()
        last_scan = "لا توجد لقطة مكتملة" if not isinstance(snapshot, dict) else (
            f"{snapshot.get('scan_id', '—')} بتاريخ {snapshot.get('captured_at', '—')} "
            f"({snapshot.get('product_count', 0)} منتج)"
        )
        connected = "متصل" if state.get("connected") else f"غير متصل ({state.get('state', 'unknown')})"
        return _reply(f"حالة WhatsApp: {connected}. آخر فحص قائمة: {last_scan}. المنطقة الزمنية: {store.APP_TZ.key}.")
    if upper in {"REPORT", "تقرير", "أرسل التقرير", "SEND REPORT"}:
        return _request_report(sender, report_runner)

    match = re.fullmatch(r"DELETE\s+(\d+)", upper)
    if match:
        local_id = _positive_int(match.group(1))
        if not local_id:
            return _reply("أرسل Local ID موجباً: DELETE <LocalID>.")
        return _start_delete(local_id, sender, archive_loader)

    match = re.fullmatch(r"CONFIRM\s+DELETE\s+([A-Z2-9]{8})", upper)
    if match:
        job = store.confirm_delete_request(match.group(1), sender)
        if not job:
            return _reply("رمز التأكيد غير صحيح أو منتهي الصلاحية؛ لم يحدث حذف.")
        return _reply(
            f"تم تسجيل تأكيدك لحذف السجل المحلي {job['local_id']} بعد نسخ بياناته الاحتياطية. "
            "ستنفّذ الإضافة الطلب عند اتصال أحد أجهزتها بالخدمة. لا يوجد أي حذف من متجر Sooqify."
        )

    match = re.fullmatch(r"CANCEL\s+([A-Z2-9]{8})", upper)
    if match:
        if store.cancel_delete_request(match.group(1), sender):
            return _reply("أُلغي طلب الحذف المعلّق. لم يحدث حذف.")
        return _reply("لم أجد طلب حذف معلقاً بهذا الرمز.")

    match = re.fullmatch(r"RESTORE\s+(BKP_\d+_[A-F0-9]{12})", upper)
    if match:
        job = store.enqueue_restore(match.group(1), sender)
        if not job:
            return _reply(
                "تعذر جدولة الاسترجاع: النسخة غير موجودة، أو لا يوجد حذف نشط مطابق، أو توجد محاولة استرجاع جارية. "
                "لا أكتب إلى الـbackend؛ الاسترجاع يعتمد على سجل الأرشيف المشترك عبر مزامنته."
            )
        return _reply(
            f"قُبل طلب استرجاع Local ID {job['local_id']}. ستطلب الإضافة مزامنة الأرشيف المشترك "
            "ثم تتحقق من ظهور السجل؛ لم يُعدّل متجر Sooqify."
        )

    return _reply("لم أتعرف على الأمر. أرسل HELP للمساعدة.")
