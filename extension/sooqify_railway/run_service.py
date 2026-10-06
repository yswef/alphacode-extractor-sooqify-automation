"""Run the single Gunicorn web process and optional WhatsApp worker together."""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STOPPING = False


def _enabled(name):
    return os.getenv(name, "false").lower() in {"1", "true", "yes", "on"}


def _signal_handler(signum, _frame):
    global STOPPING
    STOPPING = True


def _terminate(process, wait_seconds=10):
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=wait_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _start_xvfb(service_env):
    if not _enabled("REMOTE_BROWSER_ENABLED"):
        return None
    xvfb_path = shutil.which("Xvfb")
    if not xvfb_path:
        print("REMOTE_BROWSER_ENABLED=true but Xvfb is not installed. Deploy with the included Dockerfile.", file=sys.stderr, flush=True)
        return False
    display = os.getenv("REMOTE_BROWSER_DISPLAY", ":99")
    if not re.fullmatch(r":\d+(?:\.\d+)?", display):
        print("REMOTE_BROWSER_DISPLAY must look like :99.", file=sys.stderr, flush=True)
        return False
    service_env["DISPLAY"] = display
    screen_number = display[1:].split(".", 1)[0]
    command = [xvfb_path, display, "-screen", "0", "1024x680x24", "-nolisten", "tcp", "-noreset"]
    process = subprocess.Popen(command, env=service_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    socket_path = Path("/tmp/.X11-unix") / f"X{screen_number}"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print("Xvfb exited during startup; inspect the service image/runtime dependencies.", file=sys.stderr, flush=True)
            return False
        if socket_path.exists():
            print(f"Remote browser display ready on {display}.", flush=True)
            return process
        time.sleep(0.1)
    _terminate(process, wait_seconds=2)
    print("Xvfb did not create its display socket in time.", file=sys.stderr, flush=True)
    return False


def main():
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    port = str(os.getenv("PORT", "8080"))
    web_command = [
        sys.executable, "-m", "gunicorn",
        "--bind", f"0.0.0.0:{port}",
        "--workers", "1",
        "--threads", "4",
        "--timeout", "120",
        "--access-logfile", "-",
        "--error-logfile", "-",
        "app:app",
    ]
    worker_command = [shutil.which("node") or "node", str(ROOT / "whatsapp_worker" / "index.js")]
    worker_enabled = _enabled("WHATSAPP_ENABLED")
    if worker_enabled and not shutil.which("node"):
        print("WHATSAPP_ENABLED=true but Node.js was not installed by the Railway builder.", file=sys.stderr, flush=True)
        return 2

    service_env = os.environ.copy()
    xvfb = _start_xvfb(service_env)
    if xvfb is False:
        return 2
    web = subprocess.Popen(web_command, cwd=ROOT, env=service_env)
    worker = None
    next_worker_restart = 0.0
    restart_delay = 5.0
    try:
        while not STOPPING:
            if web.poll() is not None:
                return int(web.returncode or 0)
            if worker_enabled and worker is not None and worker.poll() is not None:
                exited_code = worker.returncode
                _terminate(worker, wait_seconds=2)
                worker = None
                next_worker_restart = time.monotonic() + restart_delay
                print(f"WhatsApp worker exited with code {exited_code}; restarting in {restart_delay:.0f}s.", flush=True)
                restart_delay = min(60.0, restart_delay * 2)
            if worker_enabled and worker is None and time.monotonic() >= next_worker_restart:
                worker = subprocess.Popen(worker_command, cwd=ROOT, env=service_env)
            time.sleep(1)
    finally:
        _terminate(worker)
        _terminate(web)
        _terminate(xvfb)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
