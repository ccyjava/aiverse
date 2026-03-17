# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AIverse** — the marketing site and Node.js backend for TokenFly. This repo is one of four:

| Repo | What it owns |
|------|-------------|
| `ccyjava/aiverse` (this repo) | Marketing site (`index.html`, `css/`, `js/`) + Node.js bridge server (`backend/`) |
| `ccyjava/tokenfly` | Monorepo — Python server (`server.py`) + submodules for the 3 repos below |
| `ccyjava/game_engine` | SSE — Python ECS game engine (submodule in tokenfly) |
| `ccyjava/agentic_system` | SAS — Python agentic framework (submodule in tokenfly) |

**Preferred workflow:** Work in the `tokenfly` checkout. This repo appears as `tokenfly/aiverse/` submodule.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev server with --watch (localhost:3000)
npm start            # Production start (node backend/server.js)
```

No test suite, linter, or type checker configured. Vanilla JS throughout.

## Architecture

**Single Express server** (`backend/server.js`) serves everything: static website, REST API, and WebSocket bridge.

**Three-party communication pattern:**
- Games connect via WebSocket using game-sdk → publish state updates
- AI agents connect via REST + WebSocket using agent-sdk → perceive world & issue actions
- Server acts as dumb router — never interprets game logic, just routes and stores

**Key modules:**
- `backend/server.js` — Express + ws server, in-memory session store, REST API (`/api/v1/sessions/:id/*`), WebSocket protocol
- `sdk/game-sdk/` — UMD SDK for games to broadcast state (batched at 20Hz)
- `sdk/agent-sdk/` — UMD SDK for agents to perceive & act (REST + WS stream)
- `index.html` — Single-page marketing website (no build tool, no framework)
- `css/style.css` — Dark theme design system using CSS variables
- `js/main.js` — Canvas particle animation + scroll-reveal

**WebSocket message types:** `GAME_REGISTER`, `STATE_UPDATE`, `AGENT_JOIN`, `AGENT_ACTION`, `ACTION_ACK`, `FORWARD_ACTION`, `STATE_PUSH`, `HEARTBEAT`

**State:** All in-memory (`Map`). Sessions pruned after 60s without heartbeat. Data lost on restart.

## Deployment

Push to `main` → Render auto-deploys via tokenfly monorepo. Cloudflare proxy must stay ON (DNS orange cloud). Port 10000 on Render, 3000 locally.

## Conventions

- All JavaScript is vanilla ES6+ (no TypeScript, no build step)
- SDKs use UMD format (browser + Node.js + CommonJS)
- Frontend uses no libraries — native DOM, Canvas, Intersection Observer
- Fonts: Inter (body), JetBrains Mono (code)
