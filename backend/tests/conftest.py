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
    """Arabic: تحويل ملفات المزامنة الثلاثة إلى مجلد مؤقت لكل اختبار. English: Redirect all three sync files to a temporary directory for every test."""
    from app.repositories import sync_config_repository, sync_queue_repository, sync_state_repository

    with tempfile.TemporaryDirectory() as temp_dir:
        monkeypatch.setattr(sync_config_repository, "SYNC_CONFIG_PATH", os.path.join(temp_dir, "sync_config.json"))
        monkeypatch.setattr(sync_state_repository, "SYNC_STATE_PATH", os.path.join(temp_dir, "sync_state.json"))
        monkeypatch.setattr(sync_queue_repository, "SYNC_QUEUE_PATH", os.path.join(temp_dir, "sync_queue.json"))
        yield temp_dir
