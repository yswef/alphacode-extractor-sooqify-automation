"""
Arabic: نقطة دخول التطبيق — App Factory تُسجّل كل الـ Blueprints وتهيّئ الخادم.
English: Application entry point — App Factory that registers all Blueprints and configures the server.
"""
import logging
import os
import socket
import sys

from flask import Flask, request
from flask_cors import CORS

from app.api.routes.core_routes import core_bp
from app.api.routes.sync_routes import sync_bp
from app.api.routes.reports_routes import reports_bp
from app.api.routes.upload_routes import upload_bp
from app.services.product_helpers import configure_application_logging, load_archive, save_archive, SAVE_LOCK
from app.services.sync_service import bind_archive_runtime


def create_app():
    """Arabic: مصنع التطبيق — يُنشئ Flask app ويسجّل كل Blueprints. English: App factory — creates Flask app and registers all Blueprints."""
    app = Flask(__name__)

    app.config["MAX_CONTENT_LENGTH"] = 512 * 1024
    CORS(app)

    # Arabic: ربط sync_service بقراءة/كتابة الأرشيف - بدونه تبقى _load_archive/_save_archive/
    #         _save_lock بـsync_service.py مساوية None للأبد (bind_archive_runtime كانت
    #         تُستدعى فقط من backend/app.py القديم، غير المستخدم بنقطة التشغيل هذه).
    # English: Wire sync_service to archive read/write - without this, sync_service.py's
    #          _load_archive/_save_archive/_save_lock stay None forever (bind_archive_runtime
    #          was only ever called from the legacy backend/app.py, which this entry point
    #          does not use).
    bind_archive_runtime(load_archive, save_archive, SAVE_LOCK)

    # Register all Blueprints
    app.register_blueprint(core_bp)
    app.register_blueprint(sync_bp)
    app.register_blueprint(reports_bp)
    app.register_blueprint(upload_bp)

    @app.errorhandler(413)
    def handle_local_request_too_large(_error):
        """Arabic: إعادة خطأ 413 بصيغة تفهمها الإضافة. English: Return local HTTP 413 as extension-friendly JSON."""
        return {
            "success": False,
            "request_too_large": True,
            "error": "حجم البيانات المرسلة إلى الخادم المحلي أكبر من الحد المسموح.",
        }, 413

    @app.after_request
    def log_failed_http_responses(response):
        """Arabic: تسجيل أخطاء HTTP 5xx. English: Log 5xx HTTP errors."""
        if response.status_code >= 500:
            logging.getLogger(__name__).error(
                "HTTP %s on %s %s", response.status_code, request.method, request.path
            )
        return response

    return app


def find_available_port(start_port=5000, max_attempts=5):
    """
    Arabic: يجرّب المنفذ المفضّل أولاً، ولو مشغول يجرّب المنافذ التالية بالتسلسل. حل مؤقت
            لحين استقرار المشروع - لو تغيّر المنفذ، لازم تحديث BackendPort بـ
            extension/config.js يدوياً.
    English: Tries the preferred port first, then the next ones in sequence if busy. A
             temporary stopgap until the project stabilizes - if the port changes, update
             BackendPort in extension/config.js manually.
    """
    for offset in range(max_attempts):
        candidate = start_port + offset
        # Arabic: تعمّدنا عدم استخدام SO_REUSEADDR هنا - هذا الفحص لا يفتح أي اتصال فعلي
        #         ولا يترك بيانات معلّقة (TIME_WAIT)، فما نحتاجه أصلاً. وعلى Windows تحديداً
        #         SO_REUSEADDR يخلي bind() ينجح حتى لو المنفذ مشغول فعلياً بسوكيت آخر شغّال
        #         بالاستماع - سلوك موثّق يختلف عن Linux، اكتُشف بتحقق فعلي (تشغيل نسختين
        #         متزامنتين + netstat أظهر الاثنتين LISTENING على نفس المنفذ). حذف السطر
        #         يرجّع السلوك الحصري الصحيح على كل الأنظمة بدون أي فرع خاص بـWindows.
        # English: SO_REUSEADDR is deliberately omitted here - this probe never opens a
        #          real connection and leaves no TIME_WAIT state, so it isn't needed. On
        #          Windows specifically, SO_REUSEADDR lets bind() succeed even when the
        #          port is already held by another actively-listening socket - a
        #          documented difference from Linux, discovered via real testing (two
        #          simultaneous instances + netstat showed both LISTENING on the same
        #          port). Removing it restores correct exclusive-bind behavior on every
        #          platform with no Windows-specific branching needed.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(
        f"No available port found in range {start_port}-{start_port + max_attempts - 1}. "
        f"Close one of the applications using these ports and try again."
    )


if __name__ == "__main__":
    # Arabic: تُستدعى هنا فقط (لا داخل create_app) عشان ما تلوّث سجلات pytest عند
    #         استيراد create_app() للاختبارات - هذا نظام اللوق الحقيقي الوحيد بالمشروع
    #         (ملف + طرفية ملوّنة)؛ كان معرَّفاً بالكامل بـproduct_helpers.py لكن غير مستدعى
    #         من أي مكان إطلاقاً بنقطة التشغيل الحالية (تحقق فعلي: alphacode.log ما
    #         تغيّر بعد طلب حقيقي)، فملف السجل والطرفية الملوّنة كانا معطّلين بصمت.
    # English: Called only here (not inside create_app) so pytest imports of create_app()
    #          don't get logging side effects - this is the project's only real logging
    #          system (file + colored console); it was fully defined in product_helpers.py but
    #          never invoked anywhere in the current entry point (verified live: alphacode.log
    #          did not change after a real request), so both the file log and colored
    #          console were silently disabled.
    configure_application_logging()
    app = create_app()
    chosen_port = find_available_port(5000, 5)
    if chosen_port != 5000:
        print(
            f"[app.main] Port 5000 is busy - using port {chosen_port} instead.\n"
            f"[app.main] IMPORTANT: open extension/config.js and set BackendPort: "
            f"{chosen_port}, then reload the extension (chrome://extensions -> Reload) "
            f"or it will keep trying to reach port 5000.",
            file=sys.stderr,
        )
    app.run(port=chosen_port, debug=False)
