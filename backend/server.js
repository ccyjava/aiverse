/**
 * Aiverse Backend Server
 * ======================
 * Bridges AI agents ↔ game worlds via REST API + WebSocket.
 *
 * Three parties:
 *  1. Game SDK  — embedded in any game (web/mobile/metaverse). Pushes world state, receives actions.
 *  2. Agent SDK — used by AI agents. Reads world state, sends actions.
 *  3. This server — routes between them, stores snapshots, serves REST.
 *
 * Flow:
 *   Game SDK → GAME_REGISTER → server creates session
 *   Agent SDK → AGENT_JOIN(sessionId) → server links agent to session
 *   Agent SDK → ACTION → server → FORWARD_ACTION → Game SDK → ACTION_ACK → agent
 *   Game SDK → STATE_UPDATE → server stores snapshot → pushed to subscribed agents
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { randomUUID } = require('crypto');
const cors = require('cors');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, '..');

// ============================================================
// STATE STORE
// Per-session game state cache. Game SDK is the source of truth.
// ============================================================
const sessions = new Map(); // sessionId → Session

function createSession(gameId, metadata) {
  const id = randomUUID();
  const session = {
    id,
    gameId,
    metadata: metadata || {},
    gameWS: null,          // WebSocket from game SDK
    agentWSs: new Set(),   // WebSocket(s) from agent SDK(s) watching this session
    pendingAcks: new Map(),// requestId → { resolve, reject, timeout }
    state: {
      // Standard game state schema — all fields optional, game SDK fills what it has
      position:   { x: 0, y: 0, z: 0, world: 'default' },
      direction:  { yaw: 0, pitch: 0 },
      status:     { alive: true, health: 1.0, stamina: 1.0, energy: 1.0 },
      score:      { current: 0, max: null, rank: null, label: '' },
      inventory:  { items: [] },
      screen:     { entities: [], fov: 90, timestamp: Date.now() },
      nearby:     { entities: [], radius: 50 },
      custom:     {},
      tick:       0,
      updatedAt:  Date.now(),
    },
    createdAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  sessions.set(id, session);
  console.log(`[session] created ${id} for game=${gameId}`);
  return session;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function deleteSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearAllAcks(s, 'session_closed');
  sessions.delete(id);
  console.log(`[session] deleted ${id}`);
}

// Deep merge partial state into session state
function mergeState(session, partial) {
  function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  deepMerge(session.state, partial);
  session.state.updatedAt = Date.now();
  session.state.tick = (session.state.tick || 0) + 1;
}

function clearAllAcks(session, reason) {
  for (const [, pending] of session.pendingAcks) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  session.pendingAcks.clear();
}

// ============================================================
// WEBSOCKET MESSAGE PROTOCOL
// All messages: { type, sessionId, requestId?, payload, ts }
// ============================================================
const MessageType = {
  // Game SDK → Server
  GAME_REGISTER:   'GAME_REGISTER',
  STATE_UPDATE:    'STATE_UPDATE',
  ACTION_ACK:      'ACTION_ACK',

  // Agent SDK → Server
  AGENT_JOIN:      'AGENT_JOIN',
  AGENT_ACTION:    'AGENT_ACTION',
  PERCEPTION_SUB:  'PERCEPTION_SUB',
  PERCEPTION_UNSUB:'PERCEPTION_UNSUB',

  // Server → Game SDK
  FORWARD_ACTION:  'FORWARD_ACTION',

  // Server → Agent SDK
  STATE_PUSH:      'STATE_PUSH',
  SESSION_READY:   'SESSION_READY',

  // Bidirectional
  HEARTBEAT:       'HEARTBEAT',
  ERROR:           'ERROR',
  OK:              'OK',
};

function send(ws, type, payload, requestId) {
  if (!ws || ws.readyState !== 1 /* OPEN */) return;
  ws.send(JSON.stringify({ type, payload, requestId, ts: Date.now() }));
}

function sendError(ws, message, requestId) {
  send(ws, MessageType.ERROR, { message }, requestId);
}

// Push state snapshot to all subscribed agent WebSockets
function broadcastState(session) {
  const snapshot = session.state;
  for (const agentWS of session.agentWSs) {
    if (agentWS.readyState === 1) {
      send(agentWS, MessageType.STATE_PUSH, snapshot);
    }
  }
}

// Forward an action from agent to game, wait for ACK
function forwardAction(session, action, requestId) {
  return new Promise((resolve, reject) => {
    if (!session.gameWS || session.gameWS.readyState !== 1) {
      return reject(new Error('game_not_connected'));
    }
    const timeout = setTimeout(() => {
      session.pendingAcks.delete(requestId);
      reject(new Error('action_timeout'));
    }, 2000);

    session.pendingAcks.set(requestId, { resolve, reject, timeout });
    send(session.gameWS, MessageType.FORWARD_ACTION, action, requestId);
  });
}

// ============================================================
// WEBSOCKET SERVER
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());

// Serve the static website (index.html, css/, js/, sdk/)
app.use(express.static(STATIC_DIR, { index: 'index.html' }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws._type = null; // 'game' | 'agent'
  ws._sessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return sendError(ws, 'invalid_json'); }

    const { type, payload = {}, requestId } = msg;

    // ── GAME_REGISTER: game SDK announces itself ──────────────
    if (type === MessageType.GAME_REGISTER) {
      const { gameId, metadata } = payload;
      if (!gameId) return sendError(ws, 'gameId required', requestId);

      const session = createSession(gameId, metadata);
      session.gameWS = ws;
      ws._type = 'game';
      ws._sessionId = session.id;

      send(ws, MessageType.OK, { sessionId: session.id }, requestId);
      console.log(`[ws] game registered: sessionId=${session.id}`);
      return;
    }

    // ── STATE_UPDATE: game SDK pushes world state ─────────────
    if (type === MessageType.STATE_UPDATE) {
      const session = getSession(ws._sessionId);
      if (!session) return sendError(ws, 'session_not_found', requestId);

      mergeState(session, payload);
      broadcastState(session);
      return;
    }

    // ── ACTION_ACK: game SDK confirms action executed ─────────
    if (type === MessageType.ACTION_ACK) {
      const session = getSession(ws._sessionId);
      if (!session) return;

      const pending = session.pendingAcks.get(requestId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      session.pendingAcks.delete(requestId);

      if (payload.success) {
        pending.resolve(payload);
      } else {
        pending.reject(new Error(payload.error || 'action_failed'));
      }
      return;
    }

    // ── AGENT_JOIN: AI agent connects to a session ────────────
    if (type === MessageType.AGENT_JOIN) {
      const { sessionId, agentId } = payload;
      const session = getSession(sessionId);
      if (!session) return sendError(ws, 'session_not_found', requestId);

      ws._type = 'agent';
      ws._sessionId = sessionId;
      session.agentWSs.add(ws);

      // Send current state immediately
      send(ws, MessageType.SESSION_READY, {
        sessionId,
        gameId: session.gameId,
        state: session.state,
      }, requestId);

      console.log(`[ws] agent joined: agentId=${agentId} session=${sessionId}`);
      return;
    }

    // ── AGENT_ACTION: AI agent sends a game action ────────────
    if (type === MessageType.AGENT_ACTION) {
      const session = getSession(ws._sessionId);
      if (!session) return sendError(ws, 'session_not_found', requestId);

      forwardAction(session, payload, requestId)
        .then(result => send(ws, MessageType.ACTION_ACK, { success: true, ...result }, requestId))
        .catch(err  => send(ws, MessageType.ACTION_ACK, { success: false, error: err.message }, requestId));
      return;
    }

    // ── PERCEPTION_SUB: subscribe to state push stream ────────
    if (type === MessageType.PERCEPTION_SUB) {
      const session = getSession(ws._sessionId);
      if (!session) return sendError(ws, 'session_not_found', requestId);
      session.agentWSs.add(ws);
      send(ws, MessageType.OK, { subscribed: true }, requestId);
      return;
    }

    // ── HEARTBEAT ─────────────────────────────────────────────
    if (type === MessageType.HEARTBEAT) {
      const session = getSession(ws._sessionId);
      if (session) session.lastHeartbeat = Date.now();
      send(ws, MessageType.HEARTBEAT, { pong: true });
      return;
    }

    sendError(ws, `unknown message type: ${type}`, requestId);
  });

  ws.on('close', () => {
    if (!ws._sessionId) return;
    const session = getSession(ws._sessionId);
    if (!session) return;

    if (ws._type === 'game') {
      console.log(`[ws] game disconnected: session=${ws._sessionId}`);
      // Notify all agents the game disconnected
      for (const agentWS of session.agentWSs) {
        sendError(agentWS, 'game_disconnected');
      }
      deleteSession(ws._sessionId);
    } else if (ws._type === 'agent') {
      session.agentWSs.delete(ws);
    }
  });
});

// Cleanup stale sessions every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastHeartbeat > 60_000) {
      console.log(`[session] pruning stale session ${id}`);
      deleteSession(id);
    }
  }
}, 30_000);

// ============================================================
// REST API — PERCEPTION (Read)
// ============================================================
const router = express.Router();

// Middleware: validate session exists
router.use('/sessions/:sessionId', (req, res, next) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  req.session = session;
  next();
});

// GET /api/v1/sessions/:id/perceive/status
router.get('/sessions/:sessionId/perceive/status', (req, res) => {
  res.json({ ok: true, data: req.session.state.status });
});

// GET /api/v1/sessions/:id/perceive/position
router.get('/sessions/:sessionId/perceive/position', (req, res) => {
  res.json({ ok: true, data: req.session.state.position });
});

// GET /api/v1/sessions/:id/perceive/direction
router.get('/sessions/:sessionId/perceive/direction', (req, res) => {
  res.json({ ok: true, data: req.session.state.direction });
});

// GET /api/v1/sessions/:id/perceive/score
router.get('/sessions/:sessionId/perceive/score', (req, res) => {
  res.json({ ok: true, data: req.session.state.score });
});

// GET /api/v1/sessions/:id/perceive/screen
// Returns entities currently visible on screen (populated by game SDK)
router.get('/sessions/:sessionId/perceive/screen', (req, res) => {
  res.json({ ok: true, data: req.session.state.screen });
});

// GET /api/v1/sessions/:id/perceive/nearby
router.get('/sessions/:sessionId/perceive/nearby', (req, res) => {
  const radius = parseFloat(req.query.radius) || 50;
  const data = { ...req.session.state.nearby, radius };
  res.json({ ok: true, data });
});

// GET /api/v1/sessions/:id/perceive/inventory
router.get('/sessions/:sessionId/perceive/inventory', (req, res) => {
  res.json({ ok: true, data: req.session.state.inventory });
});

// GET /api/v1/sessions/:id/perceive/snapshot  — full state in one call
router.get('/sessions/:sessionId/perceive/snapshot', (req, res) => {
  res.json({ ok: true, data: req.session.state });
});

// ============================================================
// REST API — ACTIONS (Write)
// Each action POSTs to game SDK and waits for ACK
// ============================================================

function actionHandler(actionType) {
  return async (req, res) => {
    const session = req.session;
    const requestId = randomUUID();
    const action = { type: actionType, ...req.body };

    try {
      const result = await forwardAction(session, action, requestId);
      res.json({ ok: true, action: actionType, result });
    } catch (err) {
      const status = err.message === 'game_not_connected' ? 503 : 504;
      res.status(status).json({ ok: false, error: err.message });
    }
  };
}

// POST /api/v1/sessions/:id/action/move     body: { direction: 'W'|'A'|'S'|'D', duration?: ms }
router.post('/sessions/:sessionId/action/move',     actionHandler('move'));

// POST /api/v1/sessions/:id/action/jump
router.post('/sessions/:sessionId/action/jump',     actionHandler('jump'));

// POST /api/v1/sessions/:id/action/sprint   body: { active: boolean }
router.post('/sessions/:sessionId/action/sprint',   actionHandler('sprint'));

// POST /api/v1/sessions/:id/action/interact body: { targetId: string }
router.post('/sessions/:sessionId/action/interact', actionHandler('interact'));

// POST /api/v1/sessions/:id/action/click    body: { x, y, button?: 'left'|'right' }
router.post('/sessions/:sessionId/action/click',    actionHandler('click'));

// POST /api/v1/sessions/:id/action/look     body: { yaw, pitch }
router.post('/sessions/:sessionId/action/look',     actionHandler('look'));

// POST /api/v1/sessions/:id/action/custom   body: { name, params }
router.post('/sessions/:sessionId/action/custom',   actionHandler('custom'));

// ============================================================
// SESSION MANAGEMENT
// ============================================================

// GET /api/v1/sessions  — list active sessions (for debugging/dashboard)
router.get('/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      gameId: session.gameId,
      metadata: session.metadata,
      agentCount: session.agentWSs.size,
      gameConnected: !!(session.gameWS && session.gameWS.readyState === 1),
      tick: session.state.tick,
      createdAt: session.createdAt,
    });
  }
  res.json({ ok: true, sessions: list });
});

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    sessions: sessions.size,
    uptime: process.uptime(),
    ts: Date.now(),
  });
});

app.use('/api/v1', router);

// Fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ============================================================
// OPENAPI-STYLE DOCS (served as JSON for SDK auto-discovery)
// ============================================================
app.get('/api/v1/openapi', (req, res) => {
  res.json({
    version: '1.0.0',
    base: '/api/v1',
    ws: '/ws',
    endpoints: {
      perception: [
        { method: 'GET',  path: '/sessions/:id/perceive/status',    description: 'Agent alive status, health, stamina, energy' },
        { method: 'GET',  path: '/sessions/:id/perceive/position',  description: 'World coordinates x, y, z and world name' },
        { method: 'GET',  path: '/sessions/:id/perceive/direction', description: 'Facing direction — yaw and pitch' },
        { method: 'GET',  path: '/sessions/:id/perceive/score',     description: 'Current score, rank, and label' },
        { method: 'GET',  path: '/sessions/:id/perceive/screen',    description: 'Entities currently visible on screen' },
        { method: 'GET',  path: '/sessions/:id/perceive/nearby',    description: 'Entities within radius (default 50 units)' },
        { method: 'GET',  path: '/sessions/:id/perceive/inventory', description: 'Inventory items and quantities' },
        { method: 'GET',  path: '/sessions/:id/perceive/snapshot',  description: 'Full game state snapshot in one call' },
      ],
      actions: [
        { method: 'POST', path: '/sessions/:id/action/move',     body: '{ direction: "W"|"A"|"S"|"D", duration?: number }',   description: 'Move in a direction' },
        { method: 'POST', path: '/sessions/:id/action/jump',     body: '{}',                                                   description: 'Jump' },
        { method: 'POST', path: '/sessions/:id/action/sprint',   body: '{ active: boolean }',                                 description: 'Toggle sprinting' },
        { method: 'POST', path: '/sessions/:id/action/interact', body: '{ targetId: string }',                                description: 'Interact with an NPC or object' },
        { method: 'POST', path: '/sessions/:id/action/click',    body: '{ x: number, y: number, button?: "left"|"right" }',  description: 'Click at screen coordinates' },
        { method: 'POST', path: '/sessions/:id/action/look',     body: '{ yaw: number, pitch: number }',                     description: 'Set look direction' },
        { method: 'POST', path: '/sessions/:id/action/custom',   body: '{ name: string, params: object }',                   description: 'Game-specific custom action' },
      ],
      websocket: {
        url: 'ws://host/ws',
        messages: [
          { type: 'GAME_REGISTER',   direction: '→ server', payload: '{ gameId, metadata }' },
          { type: 'STATE_UPDATE',    direction: '→ server', payload: 'Partial<GameState>' },
          { type: 'ACTION_ACK',      direction: '→ server', payload: '{ requestId, success, error? }' },
          { type: 'AGENT_JOIN',      direction: '→ server', payload: '{ sessionId, agentId }' },
          { type: 'AGENT_ACTION',    direction: '→ server', payload: '{ type, ...actionParams }' },
          { type: 'PERCEPTION_SUB',  direction: '→ server', payload: '{}' },
          { type: 'FORWARD_ACTION',  direction: 'server →', payload: 'action object' },
          { type: 'STATE_PUSH',      direction: 'server →', payload: 'GameState snapshot' },
          { type: 'SESSION_READY',   direction: 'server →', payload: '{ sessionId, gameId, state }' },
        ],
      },
    },
  });
});

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         AIVERSE BACKEND SERVER           ║
║  AI-Native Metaverse Infrastructure      ║
╠══════════════════════════════════════════╣
║  REST  →  http://localhost:${PORT}/api/v1  ║
║  WS    →  ws://localhost:${PORT}/ws        ║
║  Health→  http://localhost:${PORT}/health  ║
╚══════════════════════════════════════════╝
`);
});

module.exports = { app, httpServer };
