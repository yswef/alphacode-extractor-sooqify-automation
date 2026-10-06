"""Authenticated, persistent Playwright browser controller for Railway-hosted scans.

All Playwright objects stay on one dedicated thread. The remote UI receives compressed
screenshots and sends a small allowlist of pointer/keyboard actions over the existing
AUDIT_API_TOKEN-protected API; it never uploads a local browser profile or cookie jar.
"""

from __future__ import annotations

import concurrent.futures
import logging
import math
import os
import queue
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from store_scan import LIST_PATH, SOOQIFY_ORIGIN, ScanCancelled, scan_list_pages

logger = logging.getLogger("sooqify_audit.remote_browser")


class RemoteBrowserError(RuntimeError):
    """A safe-to-display remote-browser operation error."""


class RemoteBrowser:
    VIEWPORT = {"width": 1024, "height": 680}
    ALLOWED_KEYS = {
        "Enter", "Tab", "Backspace", "Delete", "Escape", "Space", "ArrowUp",
        "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp",
        "PageDown", "Shift", "Control", "Alt", "CapsLock", "F5",
    }

    def __init__(
        self,
        data_dir: str | Path,
        *,
        enabled: bool = False,
        on_scan_start=None,
        on_scan_page=None,
        on_scan_complete=None,
        on_scan_end=None,
    ):
        self.enabled = bool(enabled)
        self.profile_dir = Path(data_dir).resolve() / "sooqify_browser" / "profile"
        self._on_scan_start = on_scan_start
        self._on_scan_page = on_scan_page
        self._on_scan_complete = on_scan_complete
        self._on_scan_end = on_scan_end
        self._lock = threading.RLock()
        self._commands: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._startup_error = ""
        self._playwright = None
        self._context = None
        self._page = None
        self._cancel_scan = threading.Event()
        self._last_frame: bytes | None = None
        self._last_frame_at = 0.0
        self._last_scan_frame_at = 0.0
        self._status = {
            "enabled": self.enabled,
            "browser_state": "stopped" if self.enabled else "disabled",
            "authenticated": False,
            "scan_state": "idle",
            "scan_id": "",
            "current_page": 0,
            "total_pages": 0,
            "product_count": 0,
            "message": "جاهز عند تفعيل REMOTE_BROWSER_ENABLED." if not self.enabled else "المتصفح متوقف.",
            "error": "",
            "updated_at": "",
        }

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    def _set_status(self, **values) -> None:
        with self._lock:
            self._status.update(values)
            self._status["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")

    def _safe_message(self, error: object) -> str:
        text = re.sub(r"[\x00-\x1f\x7f]", " ", str(error or ""))
        text = re.sub(r"https?://\S+", "رابط", text)
        return " ".join(text.split())[:320] or "تعذر تنفيذ العملية."

    def _ensure_thread(self) -> None:
        if not self.enabled:
            raise RemoteBrowserError("المتصفح البعيد غير مفعّل؛ اضبط REMOTE_BROWSER_ENABLED=true بعد تجهيز الخدمة.")
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._ready = threading.Event()
            self._startup_error = ""
            self._thread = threading.Thread(target=self._worker_main, name="sooqify-playwright", daemon=True)
            self._thread.start()
        if not self._ready.wait(timeout=30):
            raise RemoteBrowserError("تأخر تشغيل عامل Playwright؛ راجع سجل نشر Railway.")
        if self._startup_error:
            raise RemoteBrowserError(self._startup_error)

    def _call(self, command: str, payload: dict | None = None, *, timeout: float = 20) -> object:
        self._ensure_thread()
        future: concurrent.futures.Future = concurrent.futures.Future()
        self._commands.put((command, payload or {}, future))
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError as exc:
            raise RemoteBrowserError("انتهت مهلة المتصفح البعيد؛ جرّب تحديث الحالة أو أعد تشغيل الجلسة.") from exc
        except RemoteBrowserError:
            raise
        except Exception as exc:
            raise RemoteBrowserError(self._safe_message(exc)) from exc

    def _worker_main(self) -> None:
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as playwright:
                self._playwright = playwright
                self._ready.set()
                while True:
                    command, payload, future = self._commands.get()
                    if command == "shutdown":
                        self._close_context()
                        if future and not future.done():
                            future.set_result({"success": True})
                        return
                    try:
                        result = self._dispatch(command, payload)
                        if future and not future.done():
                            future.set_result(result)
                    except Exception as exc:
                        safe_message = self._safe_message(exc)
                        if command == "start":
                            self._set_status(browser_state="error", authenticated=False, error=safe_message, message=safe_message)
                        if future and not future.done():
                            future.set_exception(RemoteBrowserError(safe_message))
                        elif command == "scan":
                            logger.exception("Remote scan worker command failed.")
        except Exception as exc:
            message = self._safe_message(exc)
            with self._lock:
                self._startup_error = "تعذر تشغيل Playwright/Chromium؛ تحقق من Dockerfile وسجل Railway."
                self._status.update(browser_state="error", error=self._startup_error, message=self._startup_error)
            logger.error("Remote browser worker failed to start: %s", message)
            self._ready.set()
        finally:
            self._playwright = None

    def _dispatch(self, command: str, payload: dict) -> object:
        if command == "start":
            return self._start_context()
        if command == "open-list":
            return self._open_list()
        if command == "screenshot":
            return self._capture_frame(force=True)
        if command == "input":
            self._send_input(payload)
            self._capture_frame(force=True)
            return {"success": True}
        if command == "close":
            self._close_context()
            return self.status()
        if command == "scan":
            self._run_scan(payload["scan_id"])
            return {"success": True}
        raise RemoteBrowserError("أمر متصفح غير معروف.")

    def _start_context(self) -> dict:
        if self._context is not None and self._page is not None and not self._page.is_closed():
            return self._open_list()
        if not os.getenv("DISPLAY"):
            raise RemoteBrowserError("DISPLAY غير مضبوط؛ تأكد من تشغيل Xvfb في خدمة Railway.")
        self.profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.profile_dir.parent, 0o700)
            os.chmod(self.profile_dir, 0o700)
        except OSError:
            pass
        self._set_status(browser_state="starting", authenticated=False, message="جارٍ فتح Chromium على Railway…", error="")
        self._context = self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            headless=False,
            viewport=self.VIEWPORT,
            device_scale_factor=1,
            locale="en-US",
            accept_downloads=False,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-default-apps",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        self._context.route("**/*", self._route_policy)
        pages = self._context.pages
        self._page = pages[0] if pages else self._context.new_page()
        self._page.on("framenavigated", self._on_main_navigation)
        self._page.goto(f"{SOOQIFY_ORIGIN}{LIST_PATH}", wait_until="domcontentloaded", timeout=60_000)
        result = self._inspect_session()
        self._capture_frame(force=True)
        return result

    def _route_policy(self, route) -> None:
        request = route.request
        try:
            parsed = urlsplit(request.url)
            path = parsed.path or "/"
        except ValueError:
            route.abort()
            return

        # Explicitly forbid product details, edits, and deletes, including subresources.
        if re.search(r"/admin/item/(?:view|edit|delete)(?:/|$)", path, re.IGNORECASE):
            route.abort()
            return

        try:
            is_main_navigation = request.is_navigation_request() and request.frame.parent_frame is None
        except Exception:
            is_main_navigation = False
        if is_main_navigation:
            host = (parsed.hostname or "").lower()
            safe_host = host == "admin.sooqifyonline.com"
            safe_path = (
                path.rstrip("/") in {"", "/admin", "/admin/dashboard", LIST_PATH}
                or bool(re.search(r"/(?:login|auth|captcha|verify|otp|two[-_]?factor)(?:/|$)", path, re.IGNORECASE))
            )
            if parsed.scheme != "https" or not safe_host or not safe_path:
                route.abort()
                return
        route.continue_()

    def _on_main_navigation(self, frame) -> None:
        if self._page is None or frame != self._page.main_frame:
            return
        try:
            parsed = urlsplit(frame.url)
        except ValueError:
            return
        path = parsed.path or "/"
        is_login = bool(re.search(r"/(?:login|auth|captcha|verify|otp)(?:/|$)", path, re.IGNORECASE))
        with self._lock:
            if self._status.get("scan_state") in {"queued", "running", "cancelling"}:
                return
            if is_login:
                self._status.update(browser_state="login_required", authenticated=False, message="سجّل الدخول وحل CAPTCHA يدوياً في نافذة المتصفح.")
            elif parsed.hostname == "admin.sooqifyonline.com" and path.rstrip("/") in {"/admin/item/list", "/admin", "/admin/dashboard"}:
                self._status.update(browser_state="ready", authenticated=path.rstrip("/") == "/admin/item/list", message="المتصفح مفتوح؛ تحقق من صفحة قائمة المنتجات قبل بدء الفحص.")
            self._status["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")

    def _inspect_session(self) -> dict:
        if self._page is None or self._page.is_closed():
            raise RemoteBrowserError("نافذة Chromium ليست مفتوحة.")
        parsed = urlsplit(self._page.url)
        password_visible = self._page.locator('input[type="password"]').count() > 0
        authenticated = (
            parsed.hostname == "admin.sooqifyonline.com"
            and parsed.path.rstrip("/") == LIST_PATH
            and not password_visible
        )
        needs_login = password_visible or bool(re.search(r"/(?:login|auth|captcha|verify|otp)(?:/|$)", parsed.path, re.IGNORECASE))
        if authenticated:
            self._set_status(browser_state="ready", authenticated=True, message="جلسة Sooqify جاهزة على صفحة القائمة.", error="")
        elif needs_login:
            self._set_status(browser_state="login_required", authenticated=False, message="سجّل الدخول وحل CAPTCHA يدوياً في نافذة المتصفح.", error="")
        else:
            self._set_status(browser_state="login_required", authenticated=False, message="افتح/تحقق من صفحة قائمة المنتجات بعد إكمال تسجيل الدخول.", error="")
        return self.status()

    def _open_list(self) -> dict:
        if self._context is None or self._page is None or self._page.is_closed():
            raise RemoteBrowserError("ابدأ المتصفح البعيد أولاً.")
        self._page.goto(f"{SOOQIFY_ORIGIN}{LIST_PATH}", wait_until="domcontentloaded", timeout=60_000)
        result = self._inspect_session()
        self._capture_frame(force=True)
        return result

    def _capture_frame(self, *, force: bool = False) -> bytes:
        if self._page is None or self._page.is_closed():
            raise RemoteBrowserError("ابدأ المتصفح البعيد أولاً.")
        now = time.monotonic()
        with self._lock:
            cached = self._last_frame
            cached_at = self._last_frame_at
        if not force and cached and now - cached_at < 1.0:
            return cached
        frame = self._page.screenshot(type="jpeg", quality=48, animations="disabled")
        with self._lock:
            self._last_frame = frame
            self._last_frame_at = now
        return frame

    def screenshot(self) -> bytes:
        if not self.enabled:
            raise RemoteBrowserError("المتصفح البعيد غير مفعّل.")
        with self._lock:
            if self._status.get("browser_state") == "stopped":
                raise RemoteBrowserError("ابدأ المتصفح البعيد أولاً.")
            is_scanning = self._status.get("scan_state") in {"queued", "running", "cancelling"}
            cached = self._last_frame
        if is_scanning and cached:
            return cached
        return self._call("screenshot", timeout=10)

    def _send_input(self, payload: dict) -> None:
        if self._page is None or self._page.is_closed():
            raise RemoteBrowserError("ابدأ المتصفح البعيد أولاً.")
        if self.status().get("scan_state") in {"queued", "running", "cancelling"}:
            raise RemoteBrowserError("لا يمكن التحكم بالصفحة أثناء فحص القائمة؛ انتظر أو ألغِ الفحص.")

        kind = payload.get("type")
        if kind == "mouse":
            action = str(payload.get("action") or "")
            if action not in {"move", "down", "up", "wheel"}:
                raise RemoteBrowserError("حركة الماوس غير مسموحة.")
            try:
                x = float(payload.get("x", 0))
                y = float(payload.get("y", 0))
            except (TypeError, ValueError) as exc:
                raise RemoteBrowserError("إحداثيات الماوس غير صالحة.") from exc
            if not (math.isfinite(x) and math.isfinite(y) and 0 <= x <= self.VIEWPORT["width"] and 0 <= y <= self.VIEWPORT["height"]):
                raise RemoteBrowserError("إحداثيات الماوس خارج مساحة العرض.")
            if action == "move":
                self._page.mouse.move(x, y)
            elif action == "down":
                button = str(payload.get("button") or "left")
                if button not in {"left", "middle", "right"}:
                    raise RemoteBrowserError("زر الماوس غير مسموح.")
                self._page.mouse.move(x, y)
                self._page.mouse.down(button=button)
            elif action == "up":
                button = str(payload.get("button") or "left")
                if button not in {"left", "middle", "right"}:
                    raise RemoteBrowserError("زر الماوس غير مسموح.")
                self._page.mouse.move(x, y)
                self._page.mouse.up(button=button)
            else:
                delta_y = float(payload.get("delta_y", 0))
                if not math.isfinite(delta_y):
                    raise RemoteBrowserError("قيمة تمرير الماوس غير صالحة.")
                delta_y = max(-1200, min(1200, delta_y))
                self._page.mouse.move(x, y)
                self._page.mouse.wheel(0, delta_y)
            return

        if kind == "text":
            text = str(payload.get("text") or "")
            if not text or len(text) > 1000 or "\x00" in text:
                raise RemoteBrowserError("النص فارغ أو أطول من الحد المسموح.")
            self._page.keyboard.insert_text(text)
            return

        if kind == "key":
            key = str(payload.get("key") or "")
            if key not in self.ALLOWED_KEYS and not re.fullmatch(r"[A-Za-z0-9]", key):
                raise RemoteBrowserError("مفتاح لوحة المفاتيح غير مسموح.")
            self._page.keyboard.press(key)
            return
        raise RemoteBrowserError("نوع إدخال غير معروف.")

    def input(self, payload: dict) -> dict:
        if not self.enabled:
            raise RemoteBrowserError("المتصفح البعيد غير مفعّل.")
        with self._lock:
            if self._status.get("browser_state") in {"stopped", "disabled", "error"}:
                raise RemoteBrowserError("ابدأ المتصفح البعيد أولاً.")
        result = self._call("input", payload, timeout=10)
        return result if isinstance(result, dict) else {"success": True}

    def start(self) -> dict:
        if not self.enabled:
            raise RemoteBrowserError("المتصفح البعيد غير مفعّل؛ اضبط REMOTE_BROWSER_ENABLED=true بعد تجهيز الخدمة.")
        with self._lock:
            if (
                self._thread and self._thread.is_alive()
                and self._status.get("browser_state") in {"starting", "ready", "login_required", "scanning"}
            ):
                return dict(self._status)
            self._status.update(browser_state="starting", message="جارٍ تشغيل Chromium على Railway…", error="")
        result = self._call("start", timeout=90)
        return result if isinstance(result, dict) else self.status()

    def open_list(self) -> dict:
        return self._call("open-list", timeout=70)

    def begin_scan(self) -> dict:
        if not self.enabled:
            raise RemoteBrowserError("المتصفح البعيد غير مفعّل.")
        with self._lock:
            if self._context is None or self._page is None or self._status.get("browser_state") == "stopped":
                raise RemoteBrowserError("ابدأ المتصفح البعيد وسجّل الدخول أولاً.")
            if not self._status.get("authenticated"):
                raise RemoteBrowserError("أكمل تسجيل الدخول اليدوي ثم اضغط «فتح قائمة المنتجات / التحقق» أولاً.")
            if self._status.get("scan_state") in {"queued", "running", "cancelling"}:
                raise RemoteBrowserError("يوجد فحص جارٍ بالفعل.")
            scan_id = f"remote_{uuid.uuid4().hex}"
            self._cancel_scan.clear()
            self._status.update(
                browser_state="scanning",
                scan_state="queued",
                scan_id=scan_id,
                current_page=0,
                total_pages=0,
                product_count=0,
                message="وُضع فحص القائمة في طابور Railway.",
                error="",
            )
            self._status["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            self._ensure_thread()
        except RemoteBrowserError as exc:
            self._set_status(browser_state="error", scan_state="failed", authenticated=False, error=str(exc), message=str(exc))
            raise
        self._commands.put(("scan", {"scan_id": scan_id}, None))
        return self.status()

    def cancel_scan(self) -> dict:
        with self._lock:
            if self._status.get("scan_state") not in {"queued", "running", "cancelling"}:
                raise RemoteBrowserError("لا يوجد فحص جارٍ لإلغائه.")
            self._cancel_scan.set()
            self._status.update(scan_state="cancelling", message="جارٍ إيقاف الفحص عند نهاية طلب القائمة الحالي.")
            self._status["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        return self.status()

    def close(self) -> dict:
        with self._lock:
            if self._status.get("browser_state") in {"stopped", "disabled"}:
                return self.status()
            if self._status.get("scan_state") in {"queued", "running", "cancelling"}:
                self._cancel_scan.set()
                self._status.update(scan_state="cancelling", message="جارٍ إيقاف الفحص قبل إغلاق المتصفح.")
        result = self._call("close", timeout=90)
        return result if isinstance(result, dict) else self.status()

    def shutdown(self) -> None:
        with self._lock:
            thread = self._thread
            if self._status.get("scan_state") in {"queued", "running", "cancelling"}:
                self._cancel_scan.set()
        if not thread or not thread.is_alive():
            return
        future: concurrent.futures.Future = concurrent.futures.Future()
        self._commands.put(("shutdown", {}, future))
        try:
            future.result(timeout=15)
        except Exception:
            pass

    def _run_scan(self, scan_id: str) -> None:
        started_at = datetime.now().astimezone().isoformat(timespec="seconds")
        self._set_status(browser_state="scanning", scan_state="running", message="يقرأ الخادم صفحات قائمة Sooqify فقط…", error="")
        try:
            if self._page is None or self._page.is_closed():
                raise RemoteBrowserError("نافذة Chromium مغلقة.")
            # Keep captcha/login visible and interactive before the scan. During scanning,
            # prevent thumbnail/media downloads; the table values and action links remain.
            def block_heavy_resources(route):
                if route.request.resource_type in {"image", "media", "font"}:
                    route.abort()
                else:
                    self._route_policy(route)
            self._page.route("**/*", block_heavy_resources)
            if self._on_scan_start:
                self._on_scan_start(scan_id, started_at)

            def progress(page_number, total_pages, product_count):
                self._set_status(
                    current_page=page_number,
                    total_pages=total_pages or 0,
                    product_count=product_count,
                    message=f"فحص Railway: صفحة القائمة {page_number}" + (f" من {total_pages}" if total_pages else ""),
                )
                now = time.monotonic()
                if now - self._last_scan_frame_at >= 2.0:
                    try:
                        self._capture_frame(force=True)
                    except Exception:
                        pass
                    self._last_scan_frame_at = now

            def on_page(page_number, products):
                if self._on_scan_page:
                    self._on_scan_page(scan_id, page_number, products)
                self._set_status(
                    current_page=page_number,
                    product_count=self.status().get("product_count", 0) + len(products),
                )

            summary = scan_list_pages(
                self._page,
                on_progress=progress,
                on_page=on_page,
                cancelled=self._cancel_scan,
            )
            captured_at = datetime.now().astimezone().isoformat(timespec="seconds")
            if self._on_scan_complete:
                self._on_scan_complete(scan_id, summary["pages_scanned"], captured_at)
            self._set_status(
                browser_state="ready",
                scan_state="complete",
                current_page=summary["pages_scanned"],
                total_pages=summary["pages_scanned"],
                product_count=summary["product_count"],
                message=f"اكتمل فحص Railway: {summary['product_count']} منتجاً في {summary['pages_scanned']} صفحة.",
                error="",
            )
            self._notify_scan_end({"success": True, "scan_id": scan_id, **summary, "captured_at": captured_at})
        except ScanCancelled as exc:
            self._set_status(browser_state="ready", scan_state="cancelled", message=self._safe_message(exc), error="")
            self._notify_scan_end({"success": False, "cancelled": True, "scan_id": scan_id, "error": self._safe_message(exc)})
        except Exception as exc:
            message = self._safe_message(exc)
            login_required = "سجّل الدخول" in message or "الجلسة غير مسجلة" in message
            self._set_status(
                browser_state="login_required" if login_required else "ready",
                authenticated=not login_required,
                scan_state="failed",
                message="فشل الفحص؛ لم تُستبدل آخر لقطة مكتملة.",
                error=message,
            )
            logger.warning("Railway list scan failed safely: %s", message)
            self._notify_scan_end({"success": False, "scan_id": scan_id, "error": message})
        finally:
            try:
                self._page.unroute("**/*", handler=None)
            except Exception:
                pass
            try:
                self._capture_frame(force=True)
            except Exception:
                pass

    def _notify_scan_end(self, result: dict) -> None:
        if not self._on_scan_end:
            return
        try:
            self._on_scan_end(result)
        except Exception:
            logger.exception("Could not queue remote-scan completion notification.")

    def _close_context(self) -> None:
        if self._context is not None:
            try:
                self._context.close()
            except Exception:
                pass
        self._context = None
        self._page = None
        with self._lock:
            self._last_frame = None
            self._status.update(
                browser_state="stopped",
                authenticated=False,
                message="أُغلقت نافذة المتصفح؛ ملف الجلسة المحفوظ على Volume لم يُحذف.",
                error="",
            )
            self._status["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
