"""
============================================================================
WebOS — backend/api/sync.py
----------------------------------------------------------------------------
Snapshot-based full-state synchronization. Mounted under /api/sync.

The frontend uses these routes to mirror its localStorage state to the
server (push) and to restore the server-side state on a fresh device or
after a logout/login cycle (pull). The sync payload is opaque JSON: the
backend stores it without inspecting it, so client-side schema changes do
not require a server upgrade.

Endpoints (all require a valid bearer token):

    POST   /api/sync/push
        Body: {snapshot: {...}, label?: string}
        Stores a new snapshot row + replays filesystem/settings sections
        into the dedicated tables for fast individual access.
        -> {ok, snapshot_id, applied: {filesystem, settings}, server_time}

    GET    /api/sync/pull
        -> {ok, snapshot: {...}, snapshot_id, label, created_at, server_time}
        Returns the most-recent snapshot. If no snapshot exists yet, returns
        a synthetic snapshot built from the user's current filesystem +
        settings rows so the client can still bootstrap.

    GET    /api/sync/status
        -> {ok, last_sync, snapshot_count, server_time, files, settings}

    GET    /api/sync/history
        -> {ok, items: [...], count}
        Lists previous snapshots for the current user (no payloads).

    GET    /api/sync/history/<id>
        -> {ok, snapshot: {...}}
        Fetches a specific past snapshot by id.
============================================================================
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict

from flask import Blueprint, request, jsonify

import database  # type: ignore
from auth import token_required  # type: ignore

log = logging.getLogger("webos.sync")

sync_bp = Blueprint("sync", __name__)

# A 4 MiB upper bound on a single snapshot payload (matches Flask MAX_CONTENT_LENGTH headroom)
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024


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


def _now() -> int:
    return int(time.time())


def _approx_size(obj: Any) -> int:
    """Cheap approximation of the JSON size of `obj`."""
    try:
        import json
        return len(json.dumps(obj, ensure_ascii=False))
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@sync_bp.route("/push", methods=["POST"])
@token_required
def push(user):
    body = _body()
    snapshot = body.get("snapshot")
    label = body.get("label") or f"push-{_now()}"

    if not isinstance(snapshot, dict):
        return _err(400, "VALIDATION", "snapshot must be an object")

    sz = _approx_size(snapshot)
    if sz > MAX_SNAPSHOT_BYTES:
        return _err(413, "PAYLOAD_TOO_LARGE", f"snapshot size ~{sz} > {MAX_SNAPSHOT_BYTES}")

    # Store the raw snapshot
    saved = database.snapshot_save(user["id"], label=label, data=snapshot)

    # Best-effort replay: if the snapshot has a known structure, mirror it
    # into the dedicated tables for individual access.
    applied = {"filesystem": 0, "settings": 0}

    fs_section = snapshot.get("filesystem")
    if isinstance(fs_section, list):
        try:
            applied["filesystem"] = database.fs_replace_all(user["id"], fs_section)
        except Exception as e:
            log.warning("fs replay failed: %s", e)
    elif isinstance(fs_section, dict) and isinstance(fs_section.get("items"), list):
        try:
            applied["filesystem"] = database.fs_replace_all(user["id"], fs_section["items"])
        except Exception as e:
            log.warning("fs replay failed: %s", e)

    settings_section = snapshot.get("settings")
    if isinstance(settings_section, dict):
        try:
            applied["settings"] = database.settings_replace_all(user["id"], settings_section)
        except Exception as e:
            log.warning("settings replay failed: %s", e)

    log.info(
        "sync.push user=%s id=%s sz~%dB applied=%s",
        user["username"], saved["id"], sz, applied,
    )
    return _ok(
        {
            "snapshot_id": saved["id"],
            "label": saved["label"],
            "created_at": saved["created_at"],
            "applied": applied,
            "server_time": _now(),
        }
    )


@sync_bp.route("/pull", methods=["GET"])
@token_required
def pull(user):
    snap = database.snapshot_latest(user["id"])
    if snap:
        return _ok(
            {
                "snapshot": snap["data"],
                "snapshot_id": snap["id"],
                "label": snap.get("label", ""),
                "created_at": snap.get("created_at"),
                "server_time": _now(),
                "synthetic": False,
            }
        )

    # No snapshot yet — synthesise one from current rows so the client can
    # bootstrap from a fresh server.
    fs_items = database.fs_dump(user["id"])
    settings = database.settings_all(user["id"])
    synthetic = {
        "version": 1,
        "filesystem": fs_items,
        "settings": settings,
        "user": database.get_user_by_id(user["id"]),
        "exported_at": _now(),
    }
    return _ok(
        {
            "snapshot": synthetic,
            "snapshot_id": None,
            "label": "synthetic",
            "created_at": _now(),
            "server_time": _now(),
            "synthetic": True,
        }
    )


@sync_bp.route("/status", methods=["GET"])
@token_required
def status(user):
    snap = database.snapshot_latest(user["id"])
    history = database.snapshot_list(user["id"], limit=50)
    fs_n = len(database.fs_dump(user["id"]))
    settings_n = len(database.settings_all(user["id"]))
    return _ok(
        {
            "last_sync": snap.get("created_at") if snap else None,
            "snapshot_count": len(history),
            "files": fs_n,
            "settings": settings_n,
            "server_time": _now(),
        }
    )


@sync_bp.route("/history", methods=["GET"])
@token_required
def history(user):
    items = database.snapshot_list(user["id"], limit=50)
    return _ok({"items": items, "count": len(items)})


@sync_bp.route("/history/<int:snapshot_id>", methods=["GET"])
@token_required
def history_one(user, snapshot_id):
    snap = database.snapshot_get(user["id"], snapshot_id)
    if not snap:
        return _err(404, "NOT_FOUND", "snapshot not found")
    return _ok({"snapshot": snap})


@sync_bp.route("/restore/<int:snapshot_id>", methods=["POST"])
@token_required
def restore(user, snapshot_id):
    """Replay a previous snapshot into the active filesystem/settings tables.
    Useful for users who want to roll back to an older state without leaving
    the browser."""
    snap = database.snapshot_get(user["id"], snapshot_id)
    if not snap:
        return _err(404, "NOT_FOUND", "snapshot not found")
    data = snap.get("data") or {}
    applied = {"filesystem": 0, "settings": 0}

    fs_section = data.get("filesystem")
    if isinstance(fs_section, list):
        try:
            applied["filesystem"] = database.fs_replace_all(user["id"], fs_section)
        except Exception as e:
            return _err(500, "RESTORE_FAILED", f"filesystem restore failed: {e}")
    settings_section = data.get("settings")
    if isinstance(settings_section, dict):
        try:
            applied["settings"] = database.settings_replace_all(user["id"], settings_section)
        except Exception as e:
            return _err(500, "RESTORE_FAILED", f"settings restore failed: {e}")

    log.info(
        "sync.restore user=%s snapshot_id=%s applied=%s",
        user["username"], snapshot_id, applied,
    )
    return _ok(
        {
            "snapshot_id": snapshot_id,
            "applied": applied,
            "server_time": _now(),
        }
    )
