"""
============================================================================
WebOS — backend/api/settings.py
----------------------------------------------------------------------------
Per-user settings REST API. Mounted under /api/settings.

Endpoints (all require a valid bearer token):

    GET    /api/settings
        -> {ok, settings: {key: value, ...}, count}

    POST   /api/settings
        Body: {key, value}
        -> {ok, item: {key, value, updated_at}}

    POST   /api/settings/bulk
        Body: {settings: {key: value, ...}, replace?: bool}
        -> {ok, updated: <int>}

    GET    /api/settings/<key>
        -> {ok, key, value}

    DELETE /api/settings/<key>
        -> {ok, removed: <bool>}

    POST   /api/settings/reset
        Body: {keys?: [string]}    (omit to reset all)
        -> {ok, removed: <int>}

    GET    /api/settings/export
        -> {ok, settings: {...}, count}

    POST   /api/settings/import
        Body: {settings: {...}}
        -> {ok, imported: <int>}

Settings are stored as JSON values; any JSON-serializable value is allowed.
============================================================================
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from flask import Blueprint, request, jsonify

import database  # type: ignore
from auth import token_required  # type: ignore

log = logging.getLogger("webos.settings")

settings_bp = Blueprint("settings", __name__)


# Recognised key prefixes — for organisation/lookup, not enforcement
KNOWN_PREFIXES = (
    "appearance.",
    "display.",
    "sound.",
    "privacy.",
    "keyboard.",
    "account.",
    "system.",
    "app.",
)

# A reasonable upper bound for a single setting value (16 KiB serialised)
MAX_VALUE_BYTES = 16 * 1024


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _err(status: int, code: str, msg: str, **extra) -> Any:
    body = {"ok": False, "error": code, "message": msg}
    body.update(extra)
    return jsonify(body), status


def _ok(payload: Dict[str, Any] | None = None, **kwargs) -> Any:
    body: Dict[str, Any] = {"ok": True}
    if payload:
        body.update(payload)
    body.update(kwargs)
    return jsonify(body)


def _body() -> Dict[str, Any]:
    if not request.is_json:
        return {}
    try:
        return request.get_json(silent=True) or {}
    except Exception:
        return {}


def _validate_key(k: str) -> bool:
    if not isinstance(k, str) or not k:
        return False
    if len(k) > 128:
        return False
    for ch in k:
        if not (ch.isalnum() or ch in "._-:"):
            return False
    return True


def _validate_value(v: Any) -> bool:
    try:
        s = json.dumps(v)
    except Exception:
        return False
    return len(s) <= MAX_VALUE_BYTES


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@settings_bp.route("", methods=["GET"])
@settings_bp.route("/", methods=["GET"])
@token_required
def get_all(user):
    s = database.settings_all(user["id"])
    return _ok({"settings": s, "count": len(s)})


@settings_bp.route("", methods=["POST"])
@settings_bp.route("/", methods=["POST"])
@token_required
def set_one(user):
    body = _body()
    key = body.get("key")
    if not _validate_key(key):
        return _err(400, "VALIDATION", "invalid key (alphanumerics, '.', '-', '_', ':')")
    if "value" not in body:
        return _err(400, "VALIDATION", "value is required (use null to clear)")
    value = body.get("value")
    if not _validate_value(value):
        return _err(413, "PAYLOAD_TOO_LARGE", f"value exceeds {MAX_VALUE_BYTES} bytes")
    item = database.settings_set(user["id"], key, value)
    log.debug("settings.set user=%s key=%s", user["username"], key)
    return _ok({"item": item})


@settings_bp.route("/bulk", methods=["POST"])
@token_required
def bulk_update(user):
    body = _body()
    settings = body.get("settings")
    replace = bool(body.get("replace", False))
    if not isinstance(settings, dict):
        return _err(400, "VALIDATION", "settings must be an object")
    if len(settings) > 1000:
        return _err(413, "PAYLOAD_TOO_LARGE", "too many settings in one call")

    # Validate all keys/values up-front
    for k, v in settings.items():
        if not _validate_key(k):
            return _err(400, "VALIDATION", f"invalid key: {k}")
        if not _validate_value(v):
            return _err(413, "PAYLOAD_TOO_LARGE", f"value for '{k}' exceeds {MAX_VALUE_BYTES} bytes")

    if replace:
        n = database.settings_replace_all(user["id"], settings)
        log.info("settings.replace user=%s n=%d", user["username"], n)
        return _ok({"updated": n, "replaced": True})

    n = 0
    for k, v in settings.items():
        database.settings_set(user["id"], k, v)
        n += 1
    log.debug("settings.bulk user=%s n=%d", user["username"], n)
    return _ok({"updated": n, "replaced": False})


@settings_bp.route("/<path:key>", methods=["GET"])
@token_required
def get_one(user, key):
    if not _validate_key(key):
        return _err(400, "VALIDATION", "invalid key")
    val = database.settings_get(user["id"], key)
    if val is None:
        return _err(404, "NOT_FOUND", "setting not found", key=key)
    return _ok({"key": key, "value": val})


@settings_bp.route("/<path:key>", methods=["DELETE"])
@token_required
def delete_one(user, key):
    if not _validate_key(key):
        return _err(400, "VALIDATION", "invalid key")
    removed = database.settings_delete(user["id"], key)
    return _ok({"removed": removed, "key": key})


@settings_bp.route("/reset", methods=["POST"])
@token_required
def reset(user):
    body = _body()
    keys = body.get("keys")
    if keys is None:
        # Reset everything
        existing = database.settings_all(user["id"])
        n = 0
        for k in list(existing.keys()):
            if database.settings_delete(user["id"], k):
                n += 1
        log.info("settings.reset-all user=%s n=%d", user["username"], n)
        return _ok({"removed": n, "all": True})
    if not isinstance(keys, list):
        return _err(400, "VALIDATION", "keys must be a list")
    n = 0
    for k in keys:
        if not _validate_key(k):
            continue
        if database.settings_delete(user["id"], k):
            n += 1
    log.info("settings.reset user=%s n=%d", user["username"], n)
    return _ok({"removed": n, "all": False})


@settings_bp.route("/export", methods=["GET"])
@token_required
def export_settings(user):
    s = database.settings_all(user["id"])
    return _ok({"settings": s, "count": len(s)})


@settings_bp.route("/import", methods=["POST"])
@token_required
def import_settings(user):
    body = _body()
    s = body.get("settings")
    if not isinstance(s, dict):
        return _err(400, "VALIDATION", "settings must be an object")
    if len(s) > 5000:
        return _err(413, "PAYLOAD_TOO_LARGE", "too many settings to import")
    n = database.settings_replace_all(user["id"], s)
    log.info("settings.import user=%s n=%d", user["username"], n)
    return _ok({"imported": n})


@settings_bp.route("/categories", methods=["GET"])
@token_required
def categories(user):
    """Return settings grouped by their dotted-prefix category."""
    s = database.settings_all(user["id"])
    out: Dict[str, Dict[str, Any]] = {}
    for k, v in s.items():
        cat = k.split(".", 1)[0] if "." in k else "misc"
        out.setdefault(cat, {})[k] = v
    return _ok({"categories": out})
