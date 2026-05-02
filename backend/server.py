"""
============================================================================
WebOS — backend/server.py
----------------------------------------------------------------------------
Main Flask application for the WebOS backend server. The frontend continues
to work with localStorage-only persistence even when this server is offline;
when this server is running, it provides:

  * Real multi-user authentication (register/login/logout)
  * Persistent file-system storage (SQLite-backed)
  * User settings synchronisation (theme, wallpaper, preferences)
  * Snapshot-based sync for full-state push/pull
  * Real-time notifications via Socket.IO

Architecture
------------
  server.py        - Flask app factory, blueprint wiring, static serving,
                     health/info endpoints, error handlers.
  database.py      - SQLite helpers (no ORM). All DDL + CRUD functions.
  auth.py          - Register/login/logout/password/avatar handlers.
  api/filesystem.py- /api/fs/* routes for files & directories.
  api/settings.py  - /api/settings/* routes for key/value settings.
  api/sync.py      - /api/sync/* routes for snapshot push/pull.

Run
---
  pip install -r requirements.txt
  python server.py
  -> http://127.0.0.1:5050  (set WEBOS_HOST/WEBOS_PORT to override)

When the server is running it serves the frontend from "/" (the parent
directory of backend/), so opening http://127.0.0.1:5050 in the browser
launches WebOS and frontend/backend integration is automatic.
============================================================================
"""

from __future__ import annotations

import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Path / module discovery
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # WebOS frontend root

# Allow `from database import ...` etc. when run as a script
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

# ---------------------------------------------------------------------------
# Optional .env loading (dotenv is optional)
# ---------------------------------------------------------------------------
try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(HERE / ".env")
except Exception:
    pass


# ---------------------------------------------------------------------------
# Flask + extensions
# ---------------------------------------------------------------------------
try:
    from flask import (
        Flask,
        jsonify,
        request,
        send_from_directory,
        g,
        abort,
    )
    from flask_cors import CORS  # type: ignore
except Exception as e:  # pragma: no cover - early import error
    print("[WebOS-backend] Flask not installed. Run: pip install -r requirements.txt")
    raise

# Socket.IO is optional. Server still works without it.
_HAS_SOCKETIO = False
try:
    from flask_socketio import SocketIO, emit as sio_emit  # type: ignore

    _HAS_SOCKETIO = True
except Exception:
    SocketIO = None  # type: ignore
    sio_emit = None  # type: ignore


# ---------------------------------------------------------------------------
# Local modules
# ---------------------------------------------------------------------------
import database  # type: ignore
import auth  # type: ignore
from api.filesystem import filesystem_bp  # type: ignore
from api.settings import settings_bp  # type: ignore
from api.sync import sync_bp  # type: ignore


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------
APP_NAME = "WebOS Backend"
APP_VERSION = "1.0.0"
DEFAULT_HOST = os.environ.get("WEBOS_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("WEBOS_PORT", "5050"))
DEFAULT_DB = os.environ.get("WEBOS_DB", str(HERE / "webos.db"))
DEFAULT_SECRET = os.environ.get("WEBOS_SECRET", "webos-dev-secret-change-me")
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_AUTH = 20  # requests per IP within window
RATE_LIMIT_MAX_API = 240  # other API endpoints

LOG_FORMAT = "[%(asctime)s] %(levelname)-7s %(name)s :: %(message)s"
LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"


# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
def configure_logging(level: str = "INFO") -> logging.Logger:
    """
    Configure application-wide logging. Suppresses Flask's default
    werkzeug request log if WEBOS_QUIET=1 is set in the environment.
    """
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=LOG_FORMAT,
        datefmt=LOG_DATEFMT,
    )
    if os.environ.get("WEBOS_QUIET", "0") == "1":
        logging.getLogger("werkzeug").setLevel(logging.WARNING)
    return logging.getLogger("webos")


log = configure_logging(os.environ.get("WEBOS_LOGLEVEL", "INFO"))


# ---------------------------------------------------------------------------
# Rate limiter (in-memory; sufficient for single-process dev usage)
# ---------------------------------------------------------------------------
class RateLimiter:
    """Sliding-window rate limiter keyed by (bucket, ip)."""

    def __init__(self, window_sec: int = RATE_LIMIT_WINDOW) -> None:
        self.window = window_sec
        self._buckets: Dict[str, list] = {}

    def hit(self, bucket: str, ip: str, limit: int) -> bool:
        """
        Records a hit. Returns True if the request is allowed,
        False if the bucket has exceeded `limit` within the window.
        """
        key = f"{bucket}:{ip}"
        now = time.time()
        timestamps = self._buckets.get(key, [])
        # Drop entries older than the window
        timestamps = [t for t in timestamps if now - t < self.window]
        timestamps.append(now)
        self._buckets[key] = timestamps
        return len(timestamps) <= limit

    def remaining(self, bucket: str, ip: str, limit: int) -> int:
        key = f"{bucket}:{ip}"
        now = time.time()
        timestamps = [t for t in self._buckets.get(key, []) if now - t < self.window]
        return max(0, limit - len(timestamps))

    def reset(self) -> None:
        self._buckets.clear()


rate_limiter = RateLimiter()


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------
def _client_ip() -> str:
    """Return best-effort client IP (proxy aware)."""
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or "0.0.0.0"


def _json_error(status: int, code: str, message: str, **extra) -> Any:
    body = {"ok": False, "error": code, "message": message}
    body.update(extra)
    return jsonify(body), status


def _json_ok(payload: Optional[Dict[str, Any]] = None, **kwargs) -> Any:
    body = {"ok": True}
    if payload:
        body.update(payload)
    body.update(kwargs)
    return jsonify(body)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
def create_app(config: Optional[Dict[str, Any]] = None) -> Flask:
    """
    Application factory.

    Optional `config` dict overrides:
      DB_PATH        - path to sqlite database
      SECRET_KEY     - flask secret
      STATIC_ROOT    - absolute path to frontend root (defaults to ../)
    """
    config = config or {}
    static_root = Path(config.get("STATIC_ROOT", ROOT)).resolve()

    app = Flask(
        __name__,
        static_folder=None,  # we route static manually so /api/* takes priority
    )

    app.config.update(
        SECRET_KEY=config.get("SECRET_KEY", DEFAULT_SECRET),
        DB_PATH=config.get("DB_PATH", DEFAULT_DB),
        STATIC_ROOT=str(static_root),
        START_TIME=time.time(),
        VERSION=APP_VERSION,
        APP_NAME=APP_NAME,
        SESSION_COOKIE_NAME="webos_sess",
        JSON_SORT_KEYS=False,
        MAX_CONTENT_LENGTH=32 * 1024 * 1024,  # 32 MiB max request size
    )

    # CORS — allow all origins (credentials not needed; frontend uses Bearer tokens)
    CORS(
        app,
        resources={r"/api/*": {"origins": "*"}},
    )

    # Initialize database (creates tables if missing)
    database.init_db(app.config["DB_PATH"])

    # Register blueprints
    app.register_blueprint(filesystem_bp, url_prefix="/api/fs")
    app.register_blueprint(settings_bp, url_prefix="/api/settings")
    app.register_blueprint(sync_bp, url_prefix="/api/sync")
    app.register_blueprint(auth.auth_bp, url_prefix="/api/auth")

    _register_core_routes(app, static_root)
    _register_middleware(app)
    _register_error_handlers(app)

    log.info("%s v%s ready (db=%s)", APP_NAME, APP_VERSION, app.config["DB_PATH"])
    return app


# ---------------------------------------------------------------------------
# Core routes
# ---------------------------------------------------------------------------
def _register_core_routes(app: Flask, static_root: Path) -> None:
    """Register the routes that aren't part of any blueprint."""

    # --- Health -----------------------------------------------------------
    @app.route("/api/health", methods=["GET"])
    def health():
        return _json_ok(
            {
                "status": "online",
                "app": APP_NAME,
                "version": APP_VERSION,
                "uptime": int(time.time() - app.config["START_TIME"]),
                "now": datetime.now(timezone.utc).isoformat(),
                "users": database.count_users(),
                "files": database.count_files(),
            }
        )

    # --- Info -------------------------------------------------------------
    @app.route("/api/info", methods=["GET"])
    def info():
        return _json_ok(
            {
                "name": APP_NAME,
                "version": APP_VERSION,
                "python": sys.version.split()[0],
                "platform": sys.platform,
                "socketio": _HAS_SOCKETIO,
                "endpoints": _endpoint_index(app),
            }
        )

    # --- Notifications list/mark-read -------------------------------------
    @app.route("/api/notifications", methods=["GET"])
    @auth.token_required
    def list_notifications(user):
        items = database.list_notifications(user["id"])
        return _json_ok({"items": items, "count": len(items)})

    @app.route("/api/notifications/<int:nid>/read", methods=["POST"])
    @auth.token_required
    def mark_notification(user, nid):
        ok = database.mark_notification_read(user["id"], nid)
        if not ok:
            return _json_error(404, "NOT_FOUND", "notification not found")
        return _json_ok()

    @app.route("/api/notifications/clear", methods=["POST"])
    @auth.token_required
    def clear_notifications(user):
        n = database.clear_notifications(user["id"])
        return _json_ok({"removed": n})

    # --- Static frontend serving -----------------------------------------
    @app.route("/", methods=["GET"])
    def index_root():
        # Serve the WebOS index.html from the project root
        if (static_root / "index.html").exists():
            return send_from_directory(str(static_root), "index.html")
        return _json_ok(
            {
                "status": "online",
                "message": "WebOS backend (no frontend bundled)",
                "version": APP_VERSION,
            }
        )

    @app.route("/<path:filename>", methods=["GET"])
    def static_passthrough(filename):
        # Don't shadow API routes
        if filename.startswith("api/"):
            abort(404)
        candidate = (static_root / filename).resolve()
        # Path traversal guard
        try:
            candidate.relative_to(static_root)
        except ValueError:
            abort(403)
        if candidate.is_dir():
            idx = candidate / "index.html"
            if idx.exists():
                return send_from_directory(str(candidate), "index.html")
            abort(404)
        if candidate.exists():
            return send_from_directory(
                str(candidate.parent),
                candidate.name,
            )
        abort(404)


def _endpoint_index(app: Flask) -> list:
    """Return a sorted list of the registered URL rules (for /api/info)."""
    out = []
    for rule in app.url_map.iter_rules():
        if rule.endpoint == "static":
            continue
        out.append(
            {
                "endpoint": rule.endpoint,
                "rule": str(rule),
                "methods": sorted(m for m in (rule.methods or []) if m not in {"HEAD", "OPTIONS"}),
            }
        )
    out.sort(key=lambda r: r["rule"])
    return out


# ---------------------------------------------------------------------------
# Middleware (request logging, rate limiting, JSON content-type, etc.)
# ---------------------------------------------------------------------------
def _register_middleware(app: Flask) -> None:
    @app.before_request
    def _before():
        g._t0 = time.time()
        g._client_ip = _client_ip()

        path = request.path
        # Rate limit auth endpoints aggressively, others gently.
        if path.startswith("/api/auth/"):
            ok = rate_limiter.hit("auth", g._client_ip, RATE_LIMIT_MAX_AUTH)
            if not ok:
                log.warning("rate-limit auth %s", g._client_ip)
                return _json_error(
                    429, "RATE_LIMIT", "too many auth attempts; try again shortly"
                )
        elif path.startswith("/api/"):
            ok = rate_limiter.hit("api", g._client_ip, RATE_LIMIT_MAX_API)
            if not ok:
                return _json_error(429, "RATE_LIMIT", "too many requests")

    @app.after_request
    def _after(response):
        try:
            dt_ms = (time.time() - getattr(g, "_t0", time.time())) * 1000
        except Exception:
            dt_ms = 0
        if request.path.startswith("/api/"):
            log.info(
                '%s %s %s -> %d  %.1fms  ip=%s',
                request.method,
                request.path,
                request.query_string.decode() if request.query_string else "",
                response.status_code,
                dt_ms,
                getattr(g, "_client_ip", "?"),
            )
        # Standard CORS-ish headers (CORS extension covers Origin already)
        response.headers.setdefault("X-WebOS-Version", APP_VERSION)
        return response


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------
def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(400)
    def _bad_request(e):
        return _json_error(400, "BAD_REQUEST", str(getattr(e, "description", "bad request")))

    @app.errorhandler(401)
    def _unauthorized(e):
        return _json_error(401, "UNAUTHORIZED", str(getattr(e, "description", "unauthorized")))

    @app.errorhandler(403)
    def _forbidden(e):
        return _json_error(403, "FORBIDDEN", str(getattr(e, "description", "forbidden")))

    @app.errorhandler(404)
    def _not_found(e):
        if request.path.startswith("/api/"):
            return _json_error(404, "NOT_FOUND", "endpoint not found", path=request.path)
        return _json_error(404, "NOT_FOUND", "resource not found", path=request.path)

    @app.errorhandler(405)
    def _method_not_allowed(e):
        return _json_error(405, "METHOD_NOT_ALLOWED", "method not allowed for this endpoint")

    @app.errorhandler(413)
    def _too_large(e):
        return _json_error(413, "PAYLOAD_TOO_LARGE", "request body too large")

    @app.errorhandler(415)
    def _unsupported_media(e):
        return _json_error(415, "UNSUPPORTED_MEDIA_TYPE", "expected application/json")

    @app.errorhandler(429)
    def _rate_limited(e):
        return _json_error(429, "RATE_LIMIT", "too many requests")

    @app.errorhandler(500)
    def _server_error(e):
        log.exception("internal server error: %s", e)
        return _json_error(500, "SERVER_ERROR", "internal server error")

    @app.errorhandler(Exception)
    def _unhandled(e):
        log.exception("unhandled exception: %s", e)
        # Always return JSON for /api/*, otherwise re-raise for default handling
        if request.path.startswith("/api/"):
            return _json_error(500, "SERVER_ERROR", str(e) or "internal server error")
        return e  # let Flask render its default page


# ---------------------------------------------------------------------------
# Socket.IO setup (optional)
# ---------------------------------------------------------------------------
def attach_socketio(app: Flask):
    """Attach a Socket.IO server to the Flask app, if flask-socketio is
    installed. Returns the SocketIO instance, or None."""
    if not _HAS_SOCKETIO:
        log.warning("flask-socketio not installed; real-time disabled")
        return None

    sio = SocketIO(
        app,
        cors_allowed_origins="*",
        async_mode="threading",
        logger=False,
        engineio_logger=False,
    )

    @sio.on("connect")
    def _on_connect():
        sio_emit(
            "welcome",
            {"app": APP_NAME, "version": APP_VERSION, "ts": time.time()},
        )

    @sio.on("ping")
    def _on_ping(data=None):
        sio_emit("pong", {"ts": time.time(), "echo": data})

    @sio.on("subscribe_notifications")
    def _on_subscribe(data):
        token = (data or {}).get("token")
        u = auth.lookup_user_by_token(token)
        if not u:
            sio_emit("error", {"code": "UNAUTHORIZED"})
            return
        # Naive: re-emit every unread notification on subscribe
        for n in database.list_notifications(u["id"]):
            if not n["read"]:
                sio_emit("notification", n)

    log.info("Socket.IO attached")
    return sio


# ---------------------------------------------------------------------------
# Push helper (used by other modules to broadcast notifications)
# ---------------------------------------------------------------------------
def push_notification(user_id: int, title: str, body: str = "", type_: str = "info") -> Dict[str, Any]:
    """
    Save a notification to the DB and broadcast via Socket.IO if available.
    Returns the saved notification record.
    """
    n = database.create_notification(user_id, title, body, type_)
    if _HAS_SOCKETIO and sio_emit is not None:
        try:
            sio_emit("notification", n, broadcast=True, namespace="/")
        except Exception as e:  # pragma: no cover
            log.debug("notification broadcast failed: %s", e)
    return n


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------
def _print_banner(host: str, port: int) -> None:
    bar = "═" * 60
    print(bar)
    print(f"  {APP_NAME} v{APP_VERSION}")
    print(f"  Listening on http://{host}:{port}")
    print(f"  DB: {DEFAULT_DB}")
    print(f"  Socket.IO: {'enabled' if _HAS_SOCKETIO else 'disabled'}")
    print(bar)


def _ensure_dirs() -> None:
    """Make sure DB directory exists."""
    db_path = Path(DEFAULT_DB)
    if db_path.parent and not db_path.parent.exists():
        db_path.parent.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    _ensure_dirs()
    app = create_app()
    sio = attach_socketio(app)

    host = DEFAULT_HOST
    port = DEFAULT_PORT
    _print_banner(host, port)

    if sio is not None:
        # Use Socket.IO's runner if available
        sio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)
    else:
        app.run(host=host, port=port, debug=False, threaded=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
