# RogueCord

RogueCord is a self-hosted, Discord-like platform where a community can run its own standalone server/guild instance. This repository contains both the web client and the Node.js backend.

Current implementation focus is real-time text + voice collaboration with WebSocket signaling, Mediasoup-based media transport, and SQLite-backed persistence.

## Current Feature Status

### Implemented
- Passwordless challenge/response login using public-key signatures over WebSocket.
- Realtime messaging over WebSocket.
- Channel/category loading and default channel bootstrap on first run.
- Voice channel join/leave with Mediasoup transport lifecycle (create/connect/produce/consume).
- Voice presence updates and participant state sync.
- RSS channels with background polling and message fanout into chat.
- Basic moderation enforcement paths (kick/ban flows and pending moderation action enforcement on reconnect).
- Folder channels with upload/download/delete support and extension/size restrictions.
- Server settings updates through WS handlers.

### Partial / In-progress
- Admin elevation currently uses a runtime-generated key (`server/src/admin.ts`) and is suitable for local/dev workflows, not hardened production admin auth.
- Architecture documentation describes HTTPS/static serving paths, but current server entrypoint returns a plain health text response and uses WebSocket for app behavior.
- Migration strategy exists as schema/bootstrap logic in server code; there is no dedicated standalone migration CLI yet.

## Tech Stack

- **Client:** Vue 3 (Composition API), Vite, TypeScript, Pinia, Vue Router, mediasoup-client.
- **Server:** Node.js + TypeScript, `ws`, Mediasoup, SQLite (`sqlite3`), `dotenv`.
- **Realtime:** WebSocket message/event protocol + WebRTC (SFU via Mediasoup).

## Repository Structure

```text
roguecord/
├─ client/                  # Vue 3 + Vite + TypeScript frontend
│  ├─ src/
│  ├─ package.json
│  └─ README.md
├─ server/                  # Node.js + TypeScript backend
│  ├─ src/
│  │  ├─ index.ts           # HTTP + WS bootstrap
│  │  ├─ db.ts              # SQLite setup/schema bootstrap
│  │  ├─ models/            # Data access + domain queries
│  │  ├─ ws/                # WS connection + message handlers
│  │  ├─ mediasoup.ts       # Mediasoup worker/room logic
│  │  └─ rssPolling.ts      # RSS polling service
│  ├─ data/                 # SQLite DB and data files
│  ├─ .env.example
│  └─ package.json
├─ ARCHITECTURE.md
└─ README.md
```

## Prerequisites

- Node.js 20+ recommended (Node 18+ minimum for current APIs).
- npm 9+.
- OS support for Mediasoup worker binaries (Linux recommended for deployment; local development also works on supported environments).

## Local Development Setup

Run client and server in separate terminals.

### 1) Server

```bash
cd server
npm install
copy .env.example .env
npm run start
```

Server script source: `server/package.json` (`start`: `ts-node src/index.ts`).

### 2) Client

```bash
cd client
npm install
npm run dev
```

Client scripts are defined in `client/package.json`:
- `dev` → Vite dev server
- `build` → type-check + production build
- `preview` → preview built client

## Environment Variables (Server)

Defined in `server/.env.example`:

- `LISTEN_IP` - server bind IP (default in example: `127.0.0.1`).
- `PORT` - server port (default in example: `1337`).
- `MEDIASOUP_LISTEN_IP` - Mediasoup bind IP for WebRTC traffic.
- `MEDIASOUP_ANNOUNCED_IP` - public/announced host or IP clients should use.
- `MEDIA_VIDEO_START_BITRATE_KBPS` - initial codec bitrate target.
- `MEDIA_VIDEO_MAX_BITRATE_VP8_KBPS`
- `MEDIA_VIDEO_MAX_BITRATE_H264_KBPS`
- `MEDIA_VIDEO_MAX_BITRATE_VP9_KBPS`
- `MEDIA_VIDEO_MAX_BITRATE_AV1_KBPS`
- `MEDIA_WEBRTC_MAX_INCOMING_BITRATE_BPS`
- `MEDIA_WEBRTC_INITIAL_OUTGOING_BITRATE_BPS`

Additional runtime env used by RSS polling:
- `RSS_POLL_INTERVAL_MS` (optional, validated minimum 15000 ms in code).

## Notes on WebSocket, Media, RSS, and Admin

- **WebSocket-first backend:** Core app actions are WS message types handled in `server/src/ws/handlers.ts`.
- **Media/WebRTC:** Voice/media uses Mediasoup rooms/transports and client signaling flows.
- **RSS channels:** `server/src/rssPolling.ts` polls RSS/Atom feeds, deduplicates entries, and posts feed items as bot messages.
- **Admin capability:** `server/src/admin.ts` generates an ephemeral admin key at process start; restarting the server rotates this key.

## Data Storage and Migrations

- Server data is persisted in SQLite under `server/data/`.
- Schema creation/evolution is handled in backend database bootstrap logic (`server/src/db.ts`).
- Project requirement: when changing SQLite tables/content, provide forward-safe migration logic in the server DB layer so existing server databases can be upgraded without data loss.

## License

This project is licensed under the GNU AGPL v3. See `LICENSE` for details.
