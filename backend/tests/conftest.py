"""
Arabic: عزل ملفات المزامنة عن جهاز المطوّر أثناء الاختبارات.

سبب وجود هذا الملف: مسارات sync_config.json وsync_state.json وsync_queue.json ثوابت
تُحسب من جذر backend/ (app/core/config.py) ولا تتأثر بمتغير ALPHACODE_ROOT_DIR الذي
تضبطه اختبارات المشروع — فاختبار يعدّل إعدادات المزامنة كان يكتب فعلياً في
backend/config/sync_config.json الحقيقي ويستبدل رابط/مفتاح/اسم المستخدم للمطوّر.
صار هذا فعلاً أثناء تطوير اختبارات المزامنة التلقائية، فهذا الملف يمنعه نهائياً
لكل الاختبارات (لا لملف واحد فقط) بتحويل الملفات الثلاثة إلى مجلد مؤقت لكل اختبار.

English: Isolate the sync files from the developer's machine during tests.

Why this file exists: the sync_config.json / sync_state.json / sync_queue.json paths are
constants derived from the backend/ root (app/core/config.py) and are NOT affected by the
ALPHACODE_ROOT_DIR variable the project's tests set - so a test that changes sync settings was
really writing to backend/config/sync_config.json and replacing the developer's URL/token/user
name. That happened for real while building the automatic-sync tests, so this file prevents it
for every test (not just one file) by redirecting all three files to a per-test temporary
directory.
"""
import os
import tempfile

import pytest


@pytest.fixture(autouse=True)
def isolate_sync_files(monkeypatch):
    """
    Arabic: تحويل ملفات المزامنة الثلاثة إلى مجلد مؤقت لكل اختبار.

    English: Redirect all three sync files to a temporary directory for every test.
    """
    from app.repositories import sync_config_repository, sync_queue_repository, sync_state_repository

    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch.setattr(sync_config_repository, "SYNC_CONFIG_PATH", os.path.join(temp_dir, "sync_config.json"))
        monkeypatch.setattr(sync_state_repository, "SYNC_STATE_PATH", os.path.join(temp_dir, "sync_state.json"))
        monkeypatch.setattr(sync_queue_repository, "SYNC_QUEUE_PATH", os.path.join(temp_dir, "sync_queue.json"))
        yield temp_dir


@pytest.fixture(autouse=True)
def isolate_emergency_shutdown_files(monkeypatch):
    """
    Arabic: عزل ملفات ميزة الإيقاف الطارئ الثلاثة عن جهاز المطوّر لكل اختبار: قفل الإيقاف
            (sync_lock.json) وحالة إعادة الرفع (restore_state.json) ومجلد النسخ الاحتياطية.

    سبب وجود هذا الحاجز: نفس حادثة conftest أعلاه تكرّرت بصيغة أخطر — تشغيل الباك اند يدوياً
    (خارج pytest، بجذر منتجات مؤقت) كتب قفل إيقاف حقيقي في backend/config/sync_lock.json،
    فصار كل تشغيل لاحق لـpytest يفشل في اختبارات المزامنة لأن الجهاز "مقفول". القفل ليس ملف
    إعداد عابراً: وجوده يوقف المزامنة فعلاً، فلا يجوز أن يُكتب من أي اختبار بالخطأ.

    English: Isolate the three emergency-shutdown files from the developer's machine for every
             test: the lock (sync_lock.json), the re-upload state (restore_state.json) and the
             backup folder.

             Why: the incident the fixture above documents repeated in a worse form - running the
             backend by hand (outside pytest, with a temporary product root) wrote a real lock into
             backend/config/sync_lock.json, so every later pytest run failed the sync tests because
             the machine looked "locked". That lock is not an ordinary settings file: its presence
             really stops sync, so no test may ever write it by accident.
    """
    from app.repositories import sync_lock_repository
    from app.services import emergency_service

    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch.setattr(sync_lock_repository, "SYNC_LOCK_PATH", os.path.join(temp_dir, "sync_lock.json"))
        monkeypatch.setattr(sync_lock_repository, "RESTORE_STATE_PATH", os.path.join(temp_dir, "restore_state.json"))
        monkeypatch.setattr(emergency_service, "EMERGENCY_BACKUP_DIR", os.path.join(temp_dir, "backups"))
        monkeypatch.setattr(emergency_service, "emergency_backup_dir", lambda: os.path.join(temp_dir, "backups"))
        yield temp_dir
