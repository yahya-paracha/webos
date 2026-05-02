"""
============================================================================
WebOS — backend/database.py
----------------------------------------------------------------------------
SQLite helpers (no ORM). Provides DDL initialization plus CRUD helpers for:

    users           - account records
    sessions        - server-side session tokens
    filesystem      - server-side persisted files (1 row = 1 file/dir)
    settings        - per-user key/value preferences
    notifications   - per-user push notifications

All helpers accept either explicit connection objects or rely on the global
default DB path set via init_db(). Connections are short-lived (one per
request via _conn()) to avoid threading issues on the same Connection object.

Password storage:
    PBKDF2-HMAC-SHA256, 200_000 iterations, 16-byte random salt.
    Stored as "pbkdf2$200000$<salt-hex>$<digest-hex>".

Session tokens:
    32-byte url-safe base64 strings; 30-day default expiry.
============================================================================
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------
_DB_PATH: Optional[str] = None
_INIT_LOCK = threading.Lock()
_INITIALIZED = False

PBKDF2_ITER = 200_000
PBKDF2_KEYLEN = 32
SALT_BYTES = 16
TOKEN_BYTES = 32
SESSION_DEFAULT_TTL = 30 * 24 * 60 * 60  # 30 days


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------
def init_db(path: str) -> None:
    """Set the global DB path and create tables / indices if missing."""
    global _DB_PATH, _INITIALIZED
    with _INIT_LOCK:
        _DB_PATH = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with _conn() as con:
            _create_schema(con)
            _seed_default_user_if_empty(con)
        _INITIALIZED = True


def _conn() -> sqlite3.Connection:
    """Create a new short-lived connection (sqlite3 row dicts)."""
    if not _DB_PATH:
        raise RuntimeError("database not initialized; call init_db() first")
    con = sqlite3.connect(
        _DB_PATH,
        detect_types=sqlite3.PARSE_DECLTYPES,
        isolation_level=None,  # autocommit
        timeout=15.0,
    )
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
DDL_USERS = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT UNIQUE NOT NULL,
    display_name    TEXT,
    password_hash   TEXT NOT NULL,
    avatar          TEXT,
    role            TEXT DEFAULT 'user',
    created_at      INTEGER NOT NULL,
    last_login      INTEGER,
    last_active     INTEGER,
    metadata        TEXT
);
"""

DDL_SESSIONS = """
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    token       TEXT UNIQUE NOT NULL,
    user_agent  TEXT,
    ip          TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

DDL_FILESYSTEM = """
CREATE TABLE IF NOT EXISTS filesystem (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    path        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'file',
    content     BLOB,
    metadata    TEXT,
    size        INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(user_id, path),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

DDL_SETTINGS = """
CREATE TABLE IF NOT EXISTS settings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  INTEGER NOT NULL,
    UNIQUE(user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

DDL_NOTIFICATIONS = """
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    type        TEXT DEFAULT 'info',
    read        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

DDL_SNAPSHOTS = """
CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    label       TEXT,
    data        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);",
    "CREATE INDEX IF NOT EXISTS idx_sessions_userid  ON sessions(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_fs_userpath      ON filesystem(user_id, path);",
    "CREATE INDEX IF NOT EXISTS idx_fs_user_type     ON filesystem(user_id, type);",
    "CREATE INDEX IF NOT EXISTS idx_settings_user    ON settings(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_notif_user       ON notifications(user_id, read);",
    "CREATE INDEX IF NOT EXISTS idx_snapshots_user   ON snapshots(user_id);",
]


def _create_schema(con: sqlite3.Connection) -> None:
    cur = con.cursor()
    cur.execute(DDL_USERS)
    cur.execute(DDL_SESSIONS)
    cur.execute(DDL_FILESYSTEM)
    cur.execute(DDL_SETTINGS)
    cur.execute(DDL_NOTIFICATIONS)
    cur.execute(DDL_SNAPSHOTS)
    for sql in INDICES:
        cur.execute(sql)


def _seed_default_user_if_empty(con: sqlite3.Connection) -> None:
    """Create a guest 'webos' / 'webos' account on a brand-new database
    so the frontend can connect immediately."""
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM users")
    if cur.fetchone()[0] > 0:
        return
    now = int(time.time())
    pw = hash_password("webos")
    cur.execute(
        """INSERT INTO users
            (username, display_name, password_hash, avatar, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("webos", "WebOS Guest", pw, "🐧", "user", now),
    )


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    """PBKDF2-SHA256 password hash. Returns 'pbkdf2$<iter>$<salt-hex>$<digest-hex>'."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITER, PBKDF2_KEYLEN
    )
    return f"pbkdf2${PBKDF2_ITER}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison against a previously hashed password."""
    if not stored or not stored.startswith("pbkdf2$"):
        return False
    try:
        _, iter_s, salt_hex, digest_hex = stored.split("$", 3)
        iters = int(iter_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except Exception:
        return False
    actual = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iters, len(expected)
    )
    return hmac.compare_digest(actual, expected)


def generate_token() -> str:
    """Generate a url-safe random token used as a session bearer."""
    return secrets.token_urlsafe(TOKEN_BYTES)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
def create_user(
    username: str,
    password: str,
    display_name: Optional[str] = None,
    avatar: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a new user. Raises ValueError if the username exists."""
    username = (username or "").strip()
    if not _valid_username(username):
        raise ValueError("invalid username (use 3-32 chars: letters, digits, _, -, .)")
    if not password or len(password) < 4:
        raise ValueError("password must be at least 4 characters")

    now = int(time.time())
    pw = hash_password(password)
    with _conn() as con:
        cur = con.cursor()
        cur.execute("SELECT id FROM users WHERE username = ?", (username,))
        if cur.fetchone():
            raise ValueError("username already taken")
        cur.execute(
            """INSERT INTO users
                  (username, display_name, password_hash, avatar, role, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (username, display_name or username, pw, avatar or "🙂", "user", now),
        )
        uid = cur.lastrowid
        return _user_row(con, uid)


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        return _user_row(con, user_id)


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = cur.fetchone()
        return _user_dict(row) if row else None


def list_users() -> List[Dict[str, Any]]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("SELECT * FROM users ORDER BY id ASC")
        return [_user_dict(r) for r in cur.fetchall()]


def count_users() -> int:
    try:
        with _conn() as con:
            cur = con.cursor()
            cur.execute("SELECT COUNT(*) FROM users")
            return int(cur.fetchone()[0])
    except Exception:
        return 0


def update_user_password(user_id: int, new_password: str) -> bool:
    if not new_password or len(new_password) < 4:
        raise ValueError("password must be at least 4 characters")
    pw = hash_password(new_password)
    with _conn() as con:
        cur = con.cursor()
        cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (pw, user_id))
        return cur.rowcount > 0


def update_user_avatar(user_id: int, avatar: str) -> bool:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("UPDATE users SET avatar = ? WHERE id = ?", (avatar, user_id))
        return cur.rowcount > 0


def update_user_display_name(user_id: int, display_name: str) -> bool:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, user_id))
        return cur.rowcount > 0


def update_user_username(user_id: int, new_username: str) -> bool:
    new_username = (new_username or "").strip()
    if not _valid_username(new_username):
        raise ValueError("invalid username")
    with _conn() as con:
        cur = con.cursor()
        cur.execute("SELECT id FROM users WHERE username = ? AND id != ?", (new_username, user_id))
        if cur.fetchone():
            raise ValueError("username already taken")
        cur.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user_id))
        return cur.rowcount > 0


def touch_user_login(user_id: int) -> None:
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "UPDATE users SET last_login = ?, last_active = ? WHERE id = ?",
            (now, now, user_id),
        )


def touch_user_activity(user_id: int) -> None:
    now = int(time.time())
    with _conn() as con:
        con.execute("UPDATE users SET last_active = ? WHERE id = ?", (now, user_id))


def delete_user(user_id: int) -> bool:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
        return cur.rowcount > 0


def _user_row(con: sqlite3.Connection, uid: int) -> Optional[Dict[str, Any]]:
    cur = con.cursor()
    cur.execute("SELECT * FROM users WHERE id = ?", (uid,))
    row = cur.fetchone()
    return _user_dict(row) if row else None


def _user_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    # Don't ever leak the password hash
    d.pop("password_hash", None)
    if d.get("metadata"):
        try:
            d["metadata"] = json.loads(d["metadata"])
        except Exception:
            d["metadata"] = {}
    return d


def _valid_username(name: str) -> bool:
    if not name or not (3 <= len(name) <= 32):
        return False
    for ch in name:
        if not (ch.isalnum() or ch in ("_", "-", ".")):
            return False
    return True


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
def create_session(
    user_id: int,
    user_agent: Optional[str] = None,
    ip: Optional[str] = None,
    ttl: int = SESSION_DEFAULT_TTL,
) -> Dict[str, Any]:
    """Create a new session token for the user. Returns the new session row."""
    now = int(time.time())
    expires = now + ttl
    token = generate_token()
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            """INSERT INTO sessions
                 (user_id, token, user_agent, ip, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user_id, token, user_agent or "", ip or "", now, expires),
        )
        sid = cur.lastrowid
    return {
        "id": sid,
        "user_id": user_id,
        "token": token,
        "created_at": now,
        "expires_at": expires,
    }


def find_session_by_token(token: str) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM sessions WHERE token = ? LIMIT 1",
            (token,),
        )
        row = cur.fetchone()
    if not row:
        return None
    if int(row["expires_at"]) < int(time.time()):
        # expired - clean up lazily
        revoke_session_by_token(token)
        return None
    return dict(row)


def revoke_session_by_token(token: str) -> bool:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
        return cur.rowcount > 0


def revoke_user_sessions(user_id: int) -> int:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        return cur.rowcount


def cleanup_expired_sessions() -> int:
    now = int(time.time())
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        return cur.rowcount


# ---------------------------------------------------------------------------
# Filesystem
# ---------------------------------------------------------------------------
def fs_upsert(
    user_id: int,
    path: str,
    type_: str = "file",
    content: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create or update an FS row. Content may be None for directories."""
    path = _normalize_fs_path(path)
    now = int(time.time())
    blob = content.encode("utf-8") if isinstance(content, str) else (content or b"")
    size = len(blob) if isinstance(blob, (bytes, bytearray)) else 0
    meta_json = json.dumps(metadata or {}, ensure_ascii=False)

    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT id FROM filesystem WHERE user_id = ? AND path = ?",
            (user_id, path),
        )
        row = cur.fetchone()
        if row:
            cur.execute(
                """UPDATE filesystem
                      SET type = ?, content = ?, metadata = ?, size = ?, updated_at = ?
                    WHERE id = ?""",
                (type_, blob, meta_json, size, now, row["id"]),
            )
            fid = row["id"]
        else:
            cur.execute(
                """INSERT INTO filesystem
                     (user_id, path, type, content, metadata, size, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id, path, type_, blob, meta_json, size, now, now),
            )
            fid = cur.lastrowid
    return fs_get(user_id, path)  # type: ignore


def fs_get(user_id: int, path: str) -> Optional[Dict[str, Any]]:
    path = _normalize_fs_path(path)
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM filesystem WHERE user_id = ? AND path = ?",
            (user_id, path),
        )
        row = cur.fetchone()
        return _fs_dict(row) if row else None


def fs_list(user_id: int, path: str = "/") -> List[Dict[str, Any]]:
    """List immediate children of a given directory path."""
    parent = _normalize_fs_path(path).rstrip("/")
    if parent == "":
        parent = "/"
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM filesystem WHERE user_id = ? AND path LIKE ? ORDER BY type DESC, path ASC",
            (user_id, (parent.rstrip("/") + "/%") if parent != "/" else "/%"),
        )
        rows = cur.fetchall()
    out = []
    pref = "/" if parent == "/" else parent.rstrip("/") + "/"
    for row in rows:
        rel = row["path"][len(pref):]
        if "/" in rel:
            continue  # not an immediate child
        out.append(_fs_dict(row))
    return out


def fs_delete(user_id: int, path: str, recursive: bool = False) -> int:
    path = _normalize_fs_path(path)
    with _conn() as con:
        cur = con.cursor()
        if recursive:
            cur.execute(
                "DELETE FROM filesystem WHERE user_id = ? AND (path = ? OR path LIKE ?)",
                (user_id, path, path.rstrip("/") + "/%"),
            )
        else:
            cur.execute(
                "DELETE FROM filesystem WHERE user_id = ? AND path = ?",
                (user_id, path),
            )
        return cur.rowcount


def fs_move(user_id: int, src: str, dst: str) -> int:
    src = _normalize_fs_path(src)
    dst = _normalize_fs_path(dst)
    now = int(time.time())
    with _conn() as con:
        cur = con.cursor()
        # Move the node itself
        cur.execute(
            "UPDATE filesystem SET path = ?, updated_at = ? WHERE user_id = ? AND path = ?",
            (dst, now, user_id, src),
        )
        moved = cur.rowcount
        # Move children, if any
        prefix_old = src.rstrip("/") + "/"
        prefix_new = dst.rstrip("/") + "/"
        cur.execute(
            "SELECT id, path FROM filesystem WHERE user_id = ? AND path LIKE ?",
            (user_id, prefix_old + "%"),
        )
        rows = cur.fetchall()
        for r in rows:
            new_path = prefix_new + r["path"][len(prefix_old):]
            cur.execute(
                "UPDATE filesystem SET path = ?, updated_at = ? WHERE id = ?",
                (new_path, now, r["id"]),
            )
            moved += 1
        return moved


def fs_search(user_id: int, query: str, limit: int = 200) -> List[Dict[str, Any]]:
    q = f"%{query}%"
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM filesystem WHERE user_id = ? AND path LIKE ? LIMIT ?",
            (user_id, q, limit),
        )
        return [_fs_dict(r) for r in cur.fetchall()]


def fs_dump(user_id: int) -> List[Dict[str, Any]]:
    """Return every FS row for a user (used by sync push/pull)."""
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM filesystem WHERE user_id = ? ORDER BY path ASC",
            (user_id,),
        )
        return [_fs_dict(r) for r in cur.fetchall()]


def fs_replace_all(user_id: int, items: Iterable[Dict[str, Any]]) -> int:
    """Replace the user's entire FS with the supplied items list. Used by
    POST /api/sync/push to mirror localStorage state to the server."""
    now = int(time.time())
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM filesystem WHERE user_id = ?", (user_id,))
        n = 0
        for it in items:
            path = _normalize_fs_path(it.get("path", ""))
            if not path:
                continue
            type_ = it.get("type", "file")
            content = it.get("content", "")
            blob = content.encode("utf-8") if isinstance(content, str) else (content or b"")
            meta = it.get("metadata") or {}
            cur.execute(
                """INSERT INTO filesystem
                     (user_id, path, type, content, metadata, size, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id, path, type_, blob, json.dumps(meta), len(blob), now, now),
            )
            n += 1
        return n


def count_files() -> int:
    try:
        with _conn() as con:
            cur = con.cursor()
            cur.execute("SELECT COUNT(*) FROM filesystem")
            return int(cur.fetchone()[0])
    except Exception:
        return 0


def _fs_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    if "content" in d and d["content"] is not None:
        try:
            d["content"] = bytes(d["content"]).decode("utf-8")
        except Exception:
            d["content"] = base64.b64encode(bytes(d["content"])).decode("ascii")
    if "metadata" in d and d["metadata"]:
        try:
            d["metadata"] = json.loads(d["metadata"])
        except Exception:
            d["metadata"] = {}
    return d


def _normalize_fs_path(path: str) -> str:
    if not path:
        return "/"
    path = "/" + path.replace("\\", "/").lstrip("/")
    # collapse repeated slashes
    while "//" in path:
        path = path.replace("//", "/")
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return path


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
def settings_set(user_id: int, key: str, value: Any) -> Dict[str, Any]:
    if not key:
        raise ValueError("setting key required")
    now = int(time.time())
    val_json = json.dumps(value, ensure_ascii=False)
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT id FROM settings WHERE user_id = ? AND key = ?",
            (user_id, key),
        )
        row = cur.fetchone()
        if row:
            cur.execute(
                "UPDATE settings SET value = ?, updated_at = ? WHERE id = ?",
                (val_json, now, row["id"]),
            )
        else:
            cur.execute(
                "INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
                (user_id, key, val_json, now),
            )
    return {"key": key, "value": value, "updated_at": now}


def settings_get(user_id: int, key: str) -> Any:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT value FROM settings WHERE user_id = ? AND key = ?",
            (user_id, key),
        )
        row = cur.fetchone()
    if not row:
        return None
    try:
        return json.loads(row["value"])
    except Exception:
        return row["value"]


def settings_all(user_id: int) -> Dict[str, Any]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT key, value, updated_at FROM settings WHERE user_id = ? ORDER BY key",
            (user_id,),
        )
        rows = cur.fetchall()
    out: Dict[str, Any] = {}
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except Exception:
            out[r["key"]] = r["value"]
    return out


def settings_delete(user_id: int, key: str) -> bool:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM settings WHERE user_id = ? AND key = ?", (user_id, key))
        return cur.rowcount > 0


def settings_replace_all(user_id: int, mapping: Dict[str, Any]) -> int:
    now = int(time.time())
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM settings WHERE user_id = ?", (user_id,))
        n = 0
        for k, v in (mapping or {}).items():
            cur.execute(
                "INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
                (user_id, k, json.dumps(v, ensure_ascii=False), now),
            )
            n += 1
        return n


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------
def create_notification(
    user_id: int,
    title: str,
    body: str = "",
    type_: str = "info",
) -> Dict[str, Any]:
    now = int(time.time())
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            """INSERT INTO notifications
                  (user_id, title, body, type, read, created_at)
               VALUES (?, ?, ?, ?, 0, ?)""",
            (user_id, title, body or "", type_ or "info", now),
        )
        nid = cur.lastrowid
    return {
        "id": nid,
        "user_id": user_id,
        "title": title,
        "body": body,
        "type": type_,
        "read": False,
        "created_at": now,
    }


def list_notifications(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            """SELECT * FROM notifications
                WHERE user_id = ?
                ORDER BY created_at DESC LIMIT ?""",
            (user_id, limit),
        )
        out = []
        for r in cur.fetchall():
            d = dict(r)
            d["read"] = bool(d["read"])
            out.append(d)
        return out


def mark_notification_read(user_id: int, nid: int) -> bool:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?",
            (nid, user_id),
        )
        return cur.rowcount > 0


def mark_all_notifications_read(user_id: int) -> int:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("UPDATE notifications SET read = 1 WHERE user_id = ?", (user_id,))
        return cur.rowcount


def clear_notifications(user_id: int) -> int:
    with _conn() as con:
        cur = con.cursor()
        cur.execute("DELETE FROM notifications WHERE user_id = ?", (user_id,))
        return cur.rowcount


# ---------------------------------------------------------------------------
# Snapshots (full state push/pull)
# ---------------------------------------------------------------------------
def snapshot_save(user_id: int, label: str, data: Dict[str, Any]) -> Dict[str, Any]:
    now = int(time.time())
    payload = json.dumps(data, ensure_ascii=False)
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "INSERT INTO snapshots (user_id, label, data, created_at) VALUES (?, ?, ?, ?)",
            (user_id, label or "", payload, now),
        )
        sid = cur.lastrowid
    return {"id": sid, "label": label, "created_at": now}


def snapshot_latest(user_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            """SELECT * FROM snapshots WHERE user_id = ?
               ORDER BY created_at DESC LIMIT 1""",
            (user_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["data"] = json.loads(d["data"])
    except Exception:
        d["data"] = {}
    return d


def snapshot_list(user_id: int, limit: int = 20) -> List[Dict[str, Any]]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            """SELECT id, label, created_at, length(data) AS bytes
                 FROM snapshots WHERE user_id = ?
                ORDER BY created_at DESC LIMIT ?""",
            (user_id, limit),
        )
        return [dict(r) for r in cur.fetchall()]


def snapshot_get(user_id: int, snapshot_id: int) -> Optional[Dict[str, Any]]:
    with _conn() as con:
        cur = con.cursor()
        cur.execute(
            "SELECT * FROM snapshots WHERE user_id = ? AND id = ?",
            (user_id, snapshot_id),
        )
        row = cur.fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["data"] = json.loads(d["data"])
    except Exception:
        d["data"] = {}
    return d


# ---------------------------------------------------------------------------
# Convenience: full export / import (for diagnostics)
# ---------------------------------------------------------------------------
def export_user_state(user_id: int) -> Dict[str, Any]:
    return {
        "user": get_user_by_id(user_id),
        "filesystem": fs_dump(user_id),
        "settings": settings_all(user_id),
        "notifications": list_notifications(user_id, limit=200),
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }


def import_user_state(user_id: int, state: Dict[str, Any]) -> Dict[str, Any]:
    fs_n = fs_replace_all(user_id, state.get("filesystem") or [])
    set_n = settings_replace_all(user_id, state.get("settings") or {})
    return {"filesystem_rows": fs_n, "settings_rows": set_n}


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
def db_stats() -> Dict[str, Any]:
    """Return aggregate counts for /api/health and admin tooling."""
    out: Dict[str, Any] = {}
    try:
        with _conn() as con:
            cur = con.cursor()
            for table in ("users", "sessions", "filesystem", "settings", "notifications", "snapshots"):
                cur.execute(f"SELECT COUNT(*) FROM {table}")
                out[table] = int(cur.fetchone()[0])
    except Exception as e:
        out["error"] = str(e)
    return out


def vacuum() -> None:
    """Compact the database. Should be called sparingly."""
    with _conn() as con:
        con.execute("VACUUM")


# End of module
