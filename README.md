# tmux-web

**English** · [简体中文](README.zh-CN.md)

A self-hosted web console for tmux. It connects to your machines over SSH and turns their
tmux sessions into session cards, live terminals and resource gauges in the browser —
including attach checks, one-click fixes for `linger` / `tmux.conf`, and an operation log.

## Features

- **Session overview** — grouped by host. Each card carries a live preview of the pane,
  the window count, the identity used to connect, and recent activity.
- **Live terminal** — xterm with the WebGL renderer (falls back to the DOM renderer),
  streamed over a WebSocket as binary frames. Attach / read-only / exclusive modes,
  multiple tabs and a 2×2 split layout, tmux window switching, a shortcut key bar and a
  batch-send box.
- **Terminal interactions** — URLs printed in the output are clickable; **dragging selects
  text** even when tmux has `mouse on`; right-click opens the app's own menu
  (copy / paste / select all / clear / reconnect / close).
- **Server management** — SSH credentials encrypted with AES-256-GCM, host-key TOFU,
  attach checks and one-click remediation.
- **Settings** — polling intervals, SSH / WebSocket tuning, terminal scrollback behaviour,
  saved command snippets.
- **Zero native dependencies** — Node's built-in `node:sqlite` plus a compile-free `ssh2`.
  `npm ci` never invokes node-gyp and needs no Python, make or g++.

## Tech stack

| Layer | Stack |
| --- | --- |
| Backend | Fastify 5 · @fastify/websocket · ssh2 · **node:sqlite** (built into Node) · bcryptjs |
| Frontend | React 18 · Vite 6 · TypeScript (strict) · @xterm/xterm 5 (+ fit / webgl addons) · hand-written CSS |
| Runtime | Node **24+** (`node:sqlite` needs `--experimental-sqlite` on 22) |
| Deployment | One process — Fastify serves both the API and the built frontend |

## Quick start

### From source

```bash
# 1. Frontend: build the static assets
cd web && npm ci && npm run build

# 2. Backend: install and start (listens on 9301)
cd ../server && npm ci && npm start
```

Open <http://localhost:9301>. An admin account is created on the first start — only when
the user table is still empty.

### Docker

```bash
docker pull docker.cnb.cool/blueteam0715/web-tmux:latest

docker run -d --name tmux-web -p 9301:9301 \
  -v /opt/tmux-web/data:/app/data \
  docker.cnb.cool/blueteam0715/web-tmux:latest
```

> The volume **must** be mounted at `/app/data`: it holds the credential master key
> (`.secret`) and the SQLite database. If `.secret` is lost, previously saved SSH
> passwords can never be decrypted again — back that directory up.

The image is built by the CNB pipeline (pushing `main` produces `latest` plus a short SHA;
pushing a `v*` tag produces a matching version tag). Never run `docker build` on the host.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | Admin username |
| `ADMIN_PASSWORD` | `admin123` | Admin password — **change this before exposing the service** |
| `PORT` | `9301` | Listen port |
| `DATA_DIR` | `<cwd>/data` | Data directory (SQLite database + credential master key) |
| `WEB_DIST` | `server/../web/dist` | Built frontend assets |

> `ADMIN_USER` / `ADMIN_PASSWORD` are honoured **only when the database is created**.
> Changing them afterwards has no effect — change the password from *Settings* instead
> (minimum 6 characters).

## How it works

- A single Node process. Fastify serves `/api/*`, `/ws/terminal` and the SPA; anything
  outside those prefixes falls back to `index.html` so hash routing works.
- Each terminal tab is one WebSocket. Output is coalesced (~16 ms) and sent as binary
  frames; older clients that omit `?bin=1` still receive base64 text frames.
- Every host operation goes through a pooled SSH connection. Credentials are decrypted
  per use and never sent to the browser.
- State lives in one SQLite file plus a master key — there is no external service to run.

## Project layout

```
tmux-web/
├── server/                  # Backend — plain ESM JavaScript, no build step
│   └── src/
│       ├── index.js         # Entry: plugins, static hosting, listen, heartbeat
│       ├── routes.js        # All HTTP routes + auth guards
│       ├── ws.js            # /ws/terminal protocol
│       ├── sshpool.js       # SSH pool, host-key TOFU, status heartbeat
│       ├── tmux.js          # tmux command wrappers and attach checks
│       ├── crypto.js        # AES-256-GCM credential encryption
│       └── db.js            # Schema, settings, accounts and session tokens
├── web/                     # Frontend
│   ├── public/fonts/        # Self-hosted variable fonts (copied into dist)
│   ├── scripts/             # Colour-palette and contrast self-checks
│   └── src/
│       ├── App.tsx          # Shell: left rail, status bar, routing
│       ├── api.ts           # The only place that talks to the backend
│       ├── styles.css       # The single stylesheet
│       └── views/           # Login / Overview / Terminal / Servers / Settings / Dialog / SessionAdmin
├── AGENTS.md                # Hard project constraints (written in Chinese) — read before changing code
└── Dockerfile / .cnb.yml    # Image build and CI pipeline
```

## Development

```bash
cd web && npx tsc -b                      # type-check only
cd web && npm run build                   # type-check + build

# The backend is plain JS, so a syntax check is enough
for f in server/src/*.js; do node --check "$f" || exit 1; done

# Self-checks (required after touching colours or design tokens)
node web/scripts/check-ansi-palette.mjs   # terminal palette stays identical in three places
node web/scripts/check-contrast.mjs       # foreground colours meet WCAG AA
```

> Read [`AGENTS.md`](./AGENTS.md) before changing code. It is written in Chinese and holds
> the repo's hard constraints: directory boundaries, the design-token table, the deployment
> flow, and a list of traps worth knowing about (the terminal palette must stay in sync in
> three places, tmux renders CJK as `_` under a non-UTF-8 locale, and so on).

## Security

This console can **SSH into other machines and run commands** on them. Treat it like the
sensitive system it is:

- **Never expose it directly to the internet.** Keep it on a private network, or put at
  least a Basic Auth layer / IP allow-list / VPN in front of it.
- Set a strong password through `ADMIN_PASSWORD` on the first deployment.
- SSH credentials are stored encrypted with AES-256-GCM; the master key is the `.secret`
  file in the data directory — **keep it out of version control**.
- The frontend can write credentials but never read them back.
- Deleting a server removes only the console's record and credentials; it does **not**
  touch the tmux sessions still running on the target host.
