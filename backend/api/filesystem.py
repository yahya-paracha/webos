"""
============================================================================
WebOS — backend/api/filesystem.py
----------------------------------------------------------------------------
Filesystem REST API. Mounted under /api/fs.

All endpoints require a valid bearer token (handled by `token_required`).

Endpoints
---------
    GET    /api/fs/read?path=...
        -> {ok, item: {path, type, content, metadata, ...}}

    POST   /api/fs/write
        Body: {path, content, metadata?}
        -> {ok, item}

    DELETE /api/fs/delete
        Body: {path, recursive?: bool}
        -> {ok, removed: <int>}

    POST   /api/fs/mkdir
        Body: {path}
        -> {ok, item}

    GET    /api/fs/list?path=/
        -> {ok, items: [...], path}

    POST   /api/fs/move
        Body: {src, dst}
        -> {ok, moved: <int>}

    GET    /api/fs/search?q=text
        -> {ok, items: [...]}

    GET    /api/fs/dump
        Returns the entire FS for the current user. Used by sync pull.

    POST   /api/fs/import
        Replaces the entire user FS with the supplied items. Used by sync
        push during first-time login. Body: {items: [...]}.

    GET    /api/fs/stat?path=...
        Returns metadata only (no content). Cheap probe.

Note: A "file" row may carry text content; binary content is encoded as
base64 inside the JSON `content` field, with `metadata.encoding == "base64"`.
============================================================================
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from flask import Blueprint, request, jsonify, g

import database  # type: ignore
from auth import token_required  # type: ignore

log = logging.getLogger("webos.fs")

filesystem_bp = Blueprint("filesystem", __name__)


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


def _need_path(path: str | None) -> tuple[bool, Any]:
    if not path or not isinstance(path, str):
        return False, _err(400, "VALIDATION", "path is required")
    return True, None


def _safe_user_path(path: str) -> str:
    """Normalize and reject any '..' traversal attempts."""
    p = (path or "").replace("\\", "/")
    if not p.startswith("/"):
        p = "/" + p
    parts = []
    for seg in p.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            # silently strip — anything jumping above root is invalid
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return "/" + "/".join(parts)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@filesystem_bp.route("/read", methods=["GET"])
@token_required
def read_file(user):
    path = request.args.get("path", "")
    ok, err = _need_path(path)
    if not ok:
        return err
    safe = _safe_user_path(path)
    item = database.fs_get(user["id"], safe)
    if not item:
        return _err(404, "NOT_FOUND", "no such file or folder", path=safe)
    if item.get("type") == "folder":
        return _err(400, "EISDIR", "cannot read a folder; use list", path=safe)
    return _ok({"item": item, "path": safe})


@filesystem_bp.route("/write", methods=["POST"])
@token_required
def write_file(user):
    body = _body()
    path = body.get("path")
    content = body.get("content", "")
    metadata = body.get("metadata") or {}

    ok, err = _need_path(path)
    if not ok:
        return err

    safe = _safe_user_path(path)

    # Don't accidentally overwrite a folder with a file
    existing = database.fs_get(user["id"], safe)
    if existing and existing.get("type") == "folder":
        return _err(400, "EISDIR", "path is a folder", path=safe)

    # Limit content size — JSON body already capped by Flask MAX_CONTENT_LENGTH
    if isinstance(content, str) and len(content) > 16 * 1024 * 1024:
        return _err(413, "PAYLOAD_TOO_LARGE", "file content > 16MB")

    item = database.fs_upsert(
        user["id"], safe, type_="file", content=content, metadata=metadata
    )
    log.info("fs.write user=%s path=%s bytes=%d", user["username"], safe, item.get("size", 0) if item else 0)
    return _ok({"item": item})


@filesystem_bp.route("/delete", methods=["DELETE", "POST"])
@token_required
def delete_path(user):
    body = _body()
    # also accept ?path= for DELETE convenience
    path = body.get("path") or request.args.get("path")
    recursive = bool(body.get("recursive", False)) or request.args.get("recursive") == "1"
    ok, err = _need_path(path)
    if not ok:
        return err
    safe = _safe_user_path(path)
    if safe == "/":
        return _err(400, "VALIDATION", "cannot delete root")
    existing = database.fs_get(user["id"], safe)
    if not existing:
        return _err(404, "NOT_FOUND", "no such file or folder", path=safe)
    if existing.get("type") == "folder" and not recursive:
        # Look for children
        children = database.fs_list(user["id"], safe)
        if children:
            return _err(400, "ENOTEMPTY", "folder not empty (set recursive=true)")
    n = database.fs_delete(user["id"], safe, recursive=recursive)
    log.info("fs.delete user=%s path=%s recursive=%s removed=%d", user["username"], safe, recursive, n)
    return _ok({"removed": n})


@filesystem_bp.route("/mkdir", methods=["POST"])
@token_required
def mkdir(user):
    body = _body()
    path = body.get("path")
    ok, err = _need_path(path)
    if not ok:
        return err
    safe = _safe_user_path(path)
    if safe == "/":
        return _err(400, "VALIDATION", "cannot create root")
    existing = database.fs_get(user["id"], safe)
    if existing:
        if existing.get("type") == "folder":
            return _ok({"item": existing})
        return _err(400, "EEXIST", "a file already exists at that path", path=safe)
    item = database.fs_upsert(user["id"], safe, type_="folder", content="", metadata={})
    log.info("fs.mkdir user=%s path=%s", user["username"], safe)
    return _ok({"item": item})


@filesystem_bp.route("/list", methods=["GET"])
@token_required
def list_dir(user):
    path = request.args.get("path", "/")
    safe = _safe_user_path(path)
    items = database.fs_list(user["id"], safe)
    # Strip large content fields from the listing for efficiency
    summary = []
    for it in items:
        d = dict(it)
        if d.get("type") == "file":
            d["preview"] = (d.get("content") or "")[:200]
        d.pop("content", None)
        summary.append(d)
    return _ok({"items": summary, "path": safe, "count": len(summary)})


@filesystem_bp.route("/move", methods=["POST"])
@token_required
def move(user):
    body = _body()
    src = body.get("src")
    dst = body.get("dst")
    if not src or not dst:
        return _err(400, "VALIDATION", "src and dst are required")
    src_safe = _safe_user_path(src)
    dst_safe = _safe_user_path(dst)
    if src_safe == "/" or dst_safe == "/":
        return _err(400, "VALIDATION", "cannot move root")

    if not database.fs_get(user["id"], src_safe):
        return _err(404, "NOT_FOUND", "src does not exist", src=src_safe)
    if database.fs_get(user["id"], dst_safe):
        return _err(400, "EEXIST", "dst already exists", dst=dst_safe)

    n = database.fs_move(user["id"], src_safe, dst_safe)
    log.info("fs.move user=%s %s -> %s (n=%d)", user["username"], src_safe, dst_safe, n)
    return _ok({"moved": n, "src": src_safe, "dst": dst_safe})


@filesystem_bp.route("/search", methods=["GET"])
@token_required
def search(user):
    q = request.args.get("q", "")
    if not q or len(q) < 1:
        return _err(400, "VALIDATION", "q is required")
    if len(q) > 200:
        return _err(400, "VALIDATION", "q too long")
    items = database.fs_search(user["id"], q)
    summary = []
    for it in items:
        d = dict(it)
        if d.get("type") == "file":
            d["preview"] = (d.get("content") or "")[:160]
        d.pop("content", None)
        summary.append(d)
    return _ok({"items": summary, "q": q, "count": len(summary)})


@filesystem_bp.route("/stat", methods=["GET"])
@token_required
def stat(user):
    path = request.args.get("path", "")
    ok, err = _need_path(path)
    if not ok:
        return err
    safe = _safe_user_path(path)
    item = database.fs_get(user["id"], safe)
    if not item:
        return _err(404, "NOT_FOUND", "no such file or folder", path=safe)
    item.pop("content", None)
    return _ok({"item": item, "path": safe})


@filesystem_bp.route("/dump", methods=["GET"])
@token_required
def dump(user):
    """Return the user's entire filesystem (used by sync.pull)."""
    items = database.fs_dump(user["id"])
    return _ok({"items": items, "count": len(items)})


@filesystem_bp.route("/import", methods=["POST"])
@token_required
def import_fs(user):
    """Replace the entire user FS with `items` from the request body.
    Used during the first-login bootstrap to mirror localStorage state."""
    body = _body()
    items = body.get("items")
    if not isinstance(items, list):
        return _err(400, "VALIDATION", "items must be a list")
    # Optional safety limit
    if len(items) > 50_000:
        return _err(413, "PAYLOAD_TOO_LARGE", "too many items")
    n = database.fs_replace_all(user["id"], items)
    log.info("fs.import user=%s rows=%d", user["username"], n)
    return _ok({"imported": n})


@filesystem_bp.route("/touch", methods=["POST"])
@token_required
def touch(user):
    body = _body()
    path = body.get("path")
    ok, err = _need_path(path)
    if not ok:
        return err
    safe = _safe_user_path(path)
    existing = database.fs_get(user["id"], safe)
    if existing:
        # Update mtime via re-upsert
        item = database.fs_upsert(
            user["id"], safe, type_=existing["type"], content=existing.get("content", ""), metadata=existing.get("metadata") or {}
        )
        return _ok({"item": item, "created": False})
    item = database.fs_upsert(user["id"], safe, type_="file", content="", metadata={})
    return _ok({"item": item, "created": True})


@filesystem_bp.route("/copy", methods=["POST"])
@token_required
def copy(user):
    body = _body()
    src = body.get("src")
    dst = body.get("dst")
    if not src or not dst:
        return _err(400, "VALIDATION", "src and dst are required")
    src_safe = _safe_user_path(src)
    dst_safe = _safe_user_path(dst)
    if database.fs_get(user["id"], dst_safe):
        return _err(400, "EEXIST", "dst already exists", dst=dst_safe)
    src_item = database.fs_get(user["id"], src_safe)
    if not src_item:
        return _err(404, "NOT_FOUND", "src does not exist")
    if src_item.get("type") == "folder":
        # Copy folder + descendants
        items = database.fs_dump(user["id"])
        prefix = src_safe.rstrip("/") + "/"
        copied = 0
        # Copy the folder itself first
        database.fs_upsert(user["id"], dst_safe, type_="folder", content="", metadata=src_item.get("metadata") or {})
        copied += 1
        for it in items:
            p = it["path"]
            if p == src_safe:
                continue
            if p.startswith(prefix):
                new_path = dst_safe.rstrip("/") + "/" + p[len(prefix):]
                database.fs_upsert(user["id"], new_path, type_=it["type"], content=it.get("content", ""), metadata=it.get("metadata") or {})
                copied += 1
        return _ok({"copied": copied})
    else:
        item = database.fs_upsert(user["id"], dst_safe, type_="file", content=src_item.get("content", ""), metadata=src_item.get("metadata") or {})
        return _ok({"item": item, "copied": 1})


# End of module
