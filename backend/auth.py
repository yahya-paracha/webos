"""
============================================================================
WebOS — backend/auth.py
----------------------------------------------------------------------------
Authentication blueprint and helpers.

Endpoints (registered under /api/auth/*):

    POST /api/auth/register
        Body: {username, password, displayName?, avatar?}
        ->   {ok, user, token}

    POST /api/auth/login
        Body: {username, password}
        ->   {ok, user, token}

    POST /api/auth/logout
        Header: Authorization: Bearer <token>
        ->   {ok}

    GET  /api/auth/me
        Header: Authorization: Bearer <token>
        ->   {ok, user}

    POST /api/auth/change-password
        Header: Authorization: Bearer <token>
        Body: {oldPassword, newPassword}
        ->   {ok}

    POST /api/auth/avatar
        Header: Authorization: Bearer <token>
        Body: {avatar}      (string, may be emoji or data: URL)
        ->   {ok, user}

    POST /api/auth/profile
        Header: Authorization: Bearer <token>
        Body: {displayName?, username?}
        ->   {ok, user}

    POST /api/auth/sessions/revoke-all
        Revokes every session except the current one.

The `token_required` decorator can be applied to any other Flask route to
require a valid bearer token; the wrapped view receives `user` as its
first argument.
============================================================================
"""

from __future__ import annotations

import logging
import time
from functools import wraps
from typing import Any, Callable, Dict, Optional

from flask import Blueprint, request, jsonify, g

import database  # type: ignore

log = logging.getLogger("webos.auth")

auth_bp = Blueprint("auth", __name__)

# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

def _extract_token(req) -> Optional[str]:
    """
    Pull bearer token out of the request.
    Accepts:
        Authorization: Bearer <token>
        Authorization: <token>
        ?token=<token>
        cookie webos_token
        JSON body field "token"
    """
    h = req.headers.get("Authorization", "")
    if h:
        if h.lower().startswith("bearer "):
            return h[7:].strip()
        return h.strip()
    qt = req.args.get("token")
    if qt:
        return qt
    ct = req.cookies.get("webos_token")
    if ct:
        return ct
    if req.is_json:
        try:
            data = req.get_json(silent=True) or {}
            if isinstance(data, dict) and data.get("token"):
                return str(data["token"])
        except Exception:
            return None
    return None


def lookup_user_by_token(token: Optional[str]) -> Optional[Dict[str, Any]]:
    """Resolve a token -> user dict. Returns None on miss/expiry."""
    if not token:
        return None
    sess = database.find_session_by_token(token)
    if not sess:
        return None
    user = database.get_user_by_id(sess["user_id"])
    if user is None:
        return None
    user["_session_id"] = sess["id"]
    return user


def token_required(fn: Callable) -> Callable:
    """
    Decorator: requires a valid bearer token. The wrapped view receives the
    authenticated user dict as its first positional argument.
    """

    @wraps(fn)
    def wrapped(*args, **kwargs):
        token = _extract_token(request)
        user = lookup_user_by_token(token)
        if not user:
            return jsonify(
                ok=False, error="UNAUTHORIZED", message="missing or invalid token"
            ), 401
        # Stash on flask.g for handlers that prefer that style
        g.current_user = user
        g.current_token = token
        try:
            database.touch_user_activity(user["id"])
        except Exception:
            pass
        return fn(user, *args, **kwargs)

    return wrapped


# ---------------------------------------------------------------------------
# JSON body helpers
# ---------------------------------------------------------------------------

def _json_body() -> Dict[str, Any]:
    if not request.is_json:
        return {}
    try:
        return request.get_json(silent=True) or {}
    except Exception:
        return {}


def _err(status: int, code: str, msg: str, **extra) -> Any:
    body = {"ok": False, "error": code, "message": msg}
    body.update(extra)
    return jsonify(body), status


def _ok(payload: Optional[Dict[str, Any]] = None, **kwargs) -> Any:
    body: Dict[str, Any] = {"ok": True}
    if payload:
        body.update(payload)
    body.update(kwargs)
    return jsonify(body)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@auth_bp.route("/register", methods=["POST"])
def register():
    """Create a new user account and return an active session token."""
    body = _json_body()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    display = body.get("displayName") or None
    avatar = body.get("avatar") or None

    if not username:
        return _err(400, "VALIDATION", "username is required")
    if not password:
        return _err(400, "VALIDATION", "password is required")

    try:
        user = database.create_user(
            username, password, display_name=display, avatar=avatar
        )
    except ValueError as e:
        return _err(400, "VALIDATION", str(e))
    except Exception as e:  # pragma: no cover
        log.exception("register failed")
        return _err(500, "SERVER_ERROR", "registration failed")

    sess = database.create_session(
        user["id"],
        user_agent=request.headers.get("User-Agent", "")[:256],
        ip=getattr(g, "_client_ip", None) or request.remote_addr or "",
    )
    database.touch_user_login(user["id"])
    log.info("user registered: %s (id=%s)", user["username"], user["id"])
    return _ok({"user": user, "token": sess["token"], "expires_at": sess["expires_at"]})


@auth_bp.route("/login", methods=["POST"])
def login():
    """Authenticate using username + password, return a new session token."""
    body = _json_body()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    if not username or not password:
        return _err(400, "VALIDATION", "username and password are required")

    user = database.get_user_by_username(username)
    if not user:
        # Avoid telling attackers which field was wrong
        return _err(401, "INVALID_CREDENTIALS", "invalid username or password")

    full = _full_user_with_password(username)
    if not full or not database.verify_password(password, full["password_hash"]):
        return _err(401, "INVALID_CREDENTIALS", "invalid username or password")

    sess = database.create_session(
        user["id"],
        user_agent=request.headers.get("User-Agent", "")[:256],
        ip=getattr(g, "_client_ip", None) or request.remote_addr or "",
    )
    database.touch_user_login(user["id"])
    user = database.get_user_by_id(user["id"])  # refresh last_login
    log.info("user logged in: %s (id=%s)", user["username"], user["id"])
    return _ok({"user": user, "token": sess["token"], "expires_at": sess["expires_at"]})


@auth_bp.route("/logout", methods=["POST"])
@token_required
def logout(user):
    """Invalidate the current session token."""
    token = getattr(g, "current_token", None)
    if token:
        database.revoke_session_by_token(token)
    log.info("user logged out: %s", user["username"])
    return _ok()


@auth_bp.route("/me", methods=["GET"])
@token_required
def me(user):
    """Return the currently authenticated user."""
    fresh = database.get_user_by_id(user["id"])
    return _ok({"user": fresh})


@auth_bp.route("/change-password", methods=["POST"])
@token_required
def change_password(user):
    """Change the authenticated user's password."""
    body = _json_body()
    old_pw = body.get("oldPassword") or ""
    new_pw = body.get("newPassword") or ""

    if not old_pw or not new_pw:
        return _err(400, "VALIDATION", "oldPassword and newPassword required")

    full = _full_user_with_password(user["username"])
    if not full or not database.verify_password(old_pw, full["password_hash"]):
        return _err(401, "INVALID_CREDENTIALS", "current password is incorrect")

    try:
        database.update_user_password(user["id"], new_pw)
    except ValueError as e:
        return _err(400, "VALIDATION", str(e))

    # Optional: revoke all other sessions to force re-login elsewhere
    revoked = database.revoke_user_sessions(user["id"])

    # Issue a fresh session for the user that just changed password
    sess = database.create_session(
        user["id"],
        user_agent=request.headers.get("User-Agent", "")[:256],
        ip=getattr(g, "_client_ip", None) or request.remote_addr or "",
    )
    log.info("password changed: %s (revoked=%d)", user["username"], revoked)
    return _ok({"token": sess["token"], "revoked_sessions": revoked})


@auth_bp.route("/avatar", methods=["POST"])
@token_required
def update_avatar(user):
    """Update the authenticated user's avatar (emoji or base64 data URL)."""
    body = _json_body()
    avatar = body.get("avatar")
    if not isinstance(avatar, str) or not avatar:
        return _err(400, "VALIDATION", "avatar is required")
    if len(avatar) > 200_000:
        return _err(413, "PAYLOAD_TOO_LARGE", "avatar payload exceeds 200KB")
    database.update_user_avatar(user["id"], avatar)
    fresh = database.get_user_by_id(user["id"])
    return _ok({"user": fresh})


@auth_bp.route("/profile", methods=["POST"])
@token_required
def update_profile(user):
    """Update display name and/or username."""
    body = _json_body()
    changed = False
    new_user: Dict[str, Any] = {}
    if "displayName" in body:
        dn = (body.get("displayName") or "").strip()
        if dn:
            database.update_user_display_name(user["id"], dn)
            changed = True
            new_user["display_name"] = dn
    if "username" in body and body["username"] != user["username"]:
        try:
            database.update_user_username(user["id"], body["username"])
            changed = True
            new_user["username"] = body["username"]
        except ValueError as e:
            return _err(400, "VALIDATION", str(e))
    if not changed:
        return _err(400, "VALIDATION", "no fields to update")
    fresh = database.get_user_by_id(user["id"])
    return _ok({"user": fresh})


@auth_bp.route("/sessions", methods=["GET"])
@token_required
def list_sessions(user):
    """List the user's active sessions (without exposing their tokens)."""
    # We don't have a list-by-user helper, but the field count is small.
    import sqlite3 as _sqlite3  # local: only needed here
    from database import _conn  # type: ignore[attr-defined]

    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            """SELECT id, user_agent, ip, created_at, expires_at
                 FROM sessions WHERE user_id = ?
                ORDER BY created_at DESC""",
            (user["id"],),
        )
        rows = [dict(r) for r in cur.fetchall()]
    # Mark current
    cur_sid = user.get("_session_id")
    for r in rows:
        r["current"] = r["id"] == cur_sid
    return _ok({"items": rows, "count": len(rows)})


@auth_bp.route("/sessions/revoke-all", methods=["POST"])
@token_required
def revoke_all_sessions(user):
    """Revoke every session for the user except the current one."""
    cur_token = getattr(g, "current_token", None)
    n_total = database.revoke_user_sessions(user["id"])
    # Re-create the active session so the caller stays logged in
    sess = database.create_session(
        user["id"],
        user_agent=request.headers.get("User-Agent", "")[:256],
        ip=getattr(g, "_client_ip", None) or request.remote_addr or "",
    )
    log.info("revoked all sessions: %s (n=%d)", user["username"], n_total)
    return _ok({"revoked": max(0, n_total - 0), "token": sess["token"]})


@auth_bp.route("/check", methods=["GET"])
def check_token():
    """
    Light-weight token-validity probe. Returns {ok: bool, valid: bool}.
    Used by the frontend on boot to decide whether the cached token still
    works without exposing token-required behaviour.
    """
    token = _extract_token(request)
    user = lookup_user_by_token(token) if token else None
    if not user:
        return jsonify(ok=True, valid=False), 200
    return jsonify(ok=True, valid=True, user=user), 200


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _full_user_with_password(username: str) -> Optional[Dict[str, Any]]:
    """Look up a user including the password_hash (NOT exposed via API)."""
    from database import _conn  # type: ignore[attr-defined]

    with _conn() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = cur.fetchone()
    if not row:
        return None
    return dict(row)


# ---------------------------------------------------------------------------
# Periodic cleanup hook (called from server.py on a timer if available)
# ---------------------------------------------------------------------------

def cleanup_loop_step() -> Dict[str, int]:
    """Single step of background cleanup. Safe to call from a scheduler."""
    n_expired = database.cleanup_expired_sessions()
    return {"expired_sessions": n_expired}
