"""
Arabic: نقطة دخول التطبيق — App Factory تُسجّل كل الـ Blueprints وتهيّئ الخادم.
English: Application entry point — App Factory that registers all Blueprints and configures the server.
"""
import logging
import os

from flask import Flask, request
from flask_cors import CORS

from app.api.routes.core_routes import core_bp
from app.api.routes.sync_routes import sync_bp
from app.api.routes.reports_routes import reports_bp
from app.api.routes.upload_routes import upload_bp


def create_app():
    """Arabic: مصنع التطبيق — يُنشئ Flask app ويسجّل كل Blueprints. English: App factory — creates Flask app and registers all Blueprints."""
    app = Flask(__name__)

    app.config["MAX_CONTENT_LENGTH"] = 512 * 1024
    CORS(app)

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


if __name__ == "__main__":
    app = create_app()
    app.run(port=5000, debug=False)
