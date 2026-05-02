# WebOS Backend

A Flask-based Python backend that adds **real persistence**, **multi-user
authentication**, and **real-time notifications** to WebOS. The frontend
continues to work without it (graceful fallback to localStorage); when this
server is running, WebOS automatically detects it and seamlessly upgrades to
server-backed mode.

---

## Features

* **Authentication** — register / login / logout with PBKDF2-SHA256 hashed
  passwords (200 000 iterations, 16-byte random salt).
* **Sessions** — server-side bearer tokens, 30-day default TTL, lazy
  expiration cleanup, multi-session per user.
* **Filesystem persistence** — every file/folder a user creates can be
  mirrored to a dedicated SQLite table.
* **Settings sync** — per-user JSON key/value settings.
* **Snapshot sync** — full state push/pull for cross-device continuity.
* **Notifications** — server-side notification queue with optional Socket.IO
  push to the active browser window.
* **Static frontend serving** — the backend serves the WebOS frontend at
  `/`, so opening `http://127.0.0.1:5050` launches the OS *and* connects to
  the backend in a single hop.
* **Rate-limited auth endpoints** to mitigate brute force.

---

## Installation

```bash
cd backend
pip install -r requirements.txt
```

Python 3.9+ is required. (Tested with 3.10–3.13.)

---

## Running

```bash
python server.py
```

Then open <http://127.0.0.1:5050> in your browser.

The first launch automatically:

1. Creates `webos.db` (SQLite) in `backend/`.
2. Runs DDL to set up tables (`users`, `sessions`, `filesystem`, `settings`,
   `notifications`, `snapshots`).
3. Seeds a default `webos / webos` account so you can log in immediately.

### Environment variables

| Variable           | Default                  | Description                                  |
|--------------------|--------------------------|----------------------------------------------|
| `WEBOS_HOST`       | `127.0.0.1`              | Bind host                                    |
| `WEBOS_PORT`       | `5050`                   | Listen port                                  |
| `WEBOS_DB`         | `backend/webos.db`       | SQLite database path                         |
| `WEBOS_SECRET`     | `webos-dev-secret-...`   | Flask `SECRET_KEY` — **change for prod**     |
| `WEBOS_LOGLEVEL`   | `INFO`                   | `DEBUG`, `INFO`, `WARNING`, `ERROR`          |
| `WEBOS_QUIET`      | `0`                      | Set to `1` to suppress per-request log lines |

You can also drop a `.env` file next to `server.py`; if `python-dotenv` is
installed it will be loaded automatically.

---

## Authentication

All `/api/*` endpoints (except `/api/health`, `/api/info`, `/api/auth/*`)
require a bearer token. The token is returned by `POST /api/auth/login` and
`POST /api/auth/register`.

```bash
# Register a new user
curl -X POST http://127.0.0.1:5050/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret"}'

# Login
curl -X POST http://127.0.0.1:5050/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"webos","password":"webos"}'
# -> {"ok":true,"user":{...},"token":"..."}

# Use the token
curl http://127.0.0.1:5050/api/fs/list?path=/ \
  -H 'Authorization: Bearer <token>'
```

The token may also be supplied via the `?token=…` query parameter or the
`webos_token` cookie.

---

## Endpoint reference

### Health & info

| Method | Path                | Description                            |
|--------|---------------------|----------------------------------------|
| GET    | `/api/health`       | Liveness probe + uptime + counts       |
| GET    | `/api/info`         | Server metadata + endpoint index       |

### Auth (`/api/auth/*`)

| Method | Path                          | Description                   |
|--------|-------------------------------|-------------------------------|
| POST   | `/register`                   | Create account, return token  |
| POST   | `/login`                      | Authenticate, return token    |
| POST   | `/logout`                     | Invalidate the current token  |
| GET    | `/me`                         | Current user                  |
| POST   | `/change-password`            | `{oldPassword,newPassword}`   |
| POST   | `/avatar`                     | `{avatar}` emoji or data-URL  |
| POST   | `/profile`                    | `{displayName?, username?}`   |
| GET    | `/sessions`                   | List user sessions            |
| POST   | `/sessions/revoke-all`        | Revoke all but current        |
| GET    | `/check`                      | Probe token validity          |

### Filesystem (`/api/fs/*`)

| Method | Path                | Description                                    |
|--------|---------------------|------------------------------------------------|
| GET    | `/read?path=`       | Read a file                                    |
| POST   | `/write`            | `{path, content, metadata?}`                   |
| DELETE | `/delete`           | `{path, recursive?}` (also accepts POST)       |
| POST   | `/mkdir`            | `{path}`                                       |
| GET    | `/list?path=/`      | List a folder                                  |
| POST   | `/move`             | `{src, dst}`                                   |
| POST   | `/copy`             | `{src, dst}` (folder copy is recursive)        |
| POST   | `/touch`            | `{path}`                                       |
| GET    | `/search?q=`        | Search by path substring                       |
| GET    | `/stat?path=`       | Metadata only                                  |
| GET    | `/dump`             | Full FS for the user                           |
| POST   | `/import`           | `{items: [...]}` — replaces user FS            |

### Settings (`/api/settings/*`)

| Method | Path                | Description                                    |
|--------|---------------------|------------------------------------------------|
| GET    | `/`                 | All settings as `{key: value}`                 |
| POST   | `/`                 | `{key, value}`                                 |
| POST   | `/bulk`             | `{settings: {...}, replace?: bool}`            |
| GET    | `/<key>`            | One value                                      |
| DELETE | `/<key>`            | Remove one                                     |
| POST   | `/reset`            | `{keys?: [string]}`                            |
| GET    | `/export`           | Export all                                     |
| POST   | `/import`           | `{settings: {...}}` — replaces all settings    |
| GET    | `/categories`       | Group settings by `prefix.`                    |

### Sync (`/api/sync/*`)

| Method | Path                  | Description                                  |
|--------|-----------------------|----------------------------------------------|
| POST   | `/push`               | `{snapshot, label?}` — store full snapshot   |
| GET    | `/pull`               | Latest snapshot (synthetic if none yet)      |
| GET    | `/status`             | Last sync time, counts                       |
| GET    | `/history`            | Snapshot history (no payloads)               |
| GET    | `/history/<id>`       | Specific snapshot                            |
| POST   | `/restore/<id>`       | Replay a snapshot into FS/settings tables    |

### Notifications

| Method | Path                          | Description                           |
|--------|-------------------------------|---------------------------------------|
| GET    | `/api/notifications`          | List notifications                    |
| POST   | `/api/notifications/<id>/read`| Mark as read                          |
| POST   | `/api/notifications/clear`    | Delete all                            |

---

## How the frontend connects

`js/backendSync.js` runs on boot and probes `GET /api/health` with a 2 s
timeout. If it succeeds, the taskbar shows a green status dot ("Backend
Connected"); otherwise it shows grey ("Offline Mode"). Once connected:

* `Backend.login(user, pass)` / `Backend.register(user, pass)` log you in
  and stash the token in `localStorage` (`webos.backend.token`).
* On login, settings are pulled from the server and applied (theme,
  wallpaper, etc.).
* The frontend pushes a snapshot to `/api/sync/push` automatically every
  60 seconds (when online) and on logout.
* `Backend.isOnline()` is exposed globally for any other app that wants to
  branch on connectivity.

---

## Architecture overview

```
backend/
├── server.py             # Flask app factory, blueprints, error handlers
├── database.py           # SQLite helpers (users, sessions, fs, settings,
│                         #   notifications, snapshots) + DDL
├── auth.py               # Auth blueprint + token_required decorator
├── api/
│   ├── filesystem.py     # /api/fs/*
│   ├── settings.py       # /api/settings/*
│   └── sync.py           # /api/sync/*
├── webos.db              # SQLite database (auto-created)
├── requirements.txt
└── README.md             # this file
```

---

## Security notes

* **Change `WEBOS_SECRET` in production.** The default is meant for
  development only.
* The default seeded `webos` / `webos` account should be deleted (or its
  password changed) before deploying.
* The server is intended for development / personal use and listens only on
  `127.0.0.1` by default. To expose it on a LAN, set `WEBOS_HOST=0.0.0.0`,
  use HTTPS in front of it, and configure a strong `WEBOS_SECRET`.

---

## Troubleshooting

| Symptom                                    | Likely cause / fix                                 |
|--------------------------------------------|----------------------------------------------------|
| Frontend taskbar shows grey "Offline" dot  | Backend not running, wrong port, or CORS blocked   |
| `RATE_LIMIT` 429 on login                  | Slow down — limiter is 20 attempts / 60 s / IP     |
| `webos.db is locked` during heavy writes   | Use a single process; SQLite WAL is enabled        |
| `flask-socketio` import errors             | Optional; remove from requirements if not needed   |
| Database schema changes                    | Delete `webos.db` to recreate, or run `vacuum()`   |

---

Built as part of the WebOS project, Day 5.
