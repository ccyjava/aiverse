/**
 * SSE — Solar Studio Engine
 * A lightweight game engine for AI-playable games.
 * Part of TokenFly's AI infrastructure.
 *
 * Features:
 *   - Player management with lifecycle events
 *   - Turn-based game loop
 *   - Built-in chat system
 *   - Action logging and replay
 *   - Event-driven plugin architecture
 *   - Score tracking
 */

'use strict';

/* ─── Minimal Event Emitter ─────────────────────────── */

class EventEmitter {
  constructor() { this._h = {}; }
  on(ev, fn)  { (this._h[ev] ||= []).push(fn); return this; }
  off(ev, fn) { if (this._h[ev]) this._h[ev] = this._h[ev].filter(f => f !== fn); return this; }
  emit(ev, ...a) { (this._h[ev] || []).forEach(fn => fn(...a)); }
}

/* ─── Solar Studio Engine ───────────────────────────── */

class SolarStudioEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.gameId      = config.gameId || `game_${Date.now()}`;
    this.maxPlayers  = config.maxPlayers || 8;
    this.turnTimeout = config.turnTimeout || 30000;
    this.players     = new Map();   // id → { id, name, metadata, alive, score }
    this.state       = {};
    this.turn        = 0;
    this.phase       = 'lobby';     // lobby → playing → finished
    this.chatLog     = [];
    this.actionLog   = [];
    this.startedAt   = null;
    this.endedAt     = null;
  }

  /* ── Player Management ─────────────────────────────── */

  addPlayer(id, name, metadata = {}) {
    if (this.players.size >= this.maxPlayers) throw new Error('Game full');
    if (this.phase !== 'lobby') throw new Error('Game already started');
    const player = { id, name, metadata, alive: true, score: 0, joinedAt: Date.now() };
    this.players.set(id, player);
    this.emit('player:join', player);
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) { this.players.delete(id); this.emit('player:leave', p); }
  }

  getPlayer(id)       { return this.players.get(id); }
  getAlivePlayers()   { return [...this.players.values()].filter(p => p.alive); }
  getAllPlayers()      { return [...this.players.values()]; }

  eliminatePlayer(id, reason = '') {
    const p = this.players.get(id);
    if (p) { p.alive = false; this.emit('player:eliminated', { player: p, reason }); }
  }

  setScore(id, score) {
    const p = this.players.get(id);
    if (p) { p.score = score; this.emit('player:score', { player: p }); }
  }

  addScore(id, delta) {
    const p = this.players.get(id);
    if (p) { p.score += delta; this.emit('player:score', { player: p }); }
  }

  /* ── Game Flow ─────────────────────────────────────── */

  start() {
    if (this.players.size < 2) throw new Error('Need at least 2 players');
    this.phase = 'playing';
    this.startedAt = Date.now();
    this.turn = 1;
    this.emit('game:start', { gameId: this.gameId, players: this.getAllPlayers() });
    return this;
  }

  nextTurn() {
    this.turn++;
    this.emit('turn:start', { turn: this.turn });
    return this.turn;
  }

  end(results = {}) {
    this.phase = 'finished';
    this.endedAt = Date.now();
    this.emit('game:end', { ...results, duration: this.endedAt - this.startedAt });
    return results;
  }

  /* ── Chat ──────────────────────────────────────────── */

  chat(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('Unknown player');
    const entry = {
      id:         `msg_${this.chatLog.length + 1}`,
      playerId,
      playerName: player.name,
      message,
      turn:       this.turn,
      timestamp:  Date.now(),
    };
    this.chatLog.push(entry);
    this.emit('chat:message', entry);
    return entry;
  }

  getChatLog(sinceId = null) {
    if (!sinceId) return [...this.chatLog];
    const idx = this.chatLog.findIndex(m => m.id === sinceId);
    return idx >= 0 ? this.chatLog.slice(idx + 1) : [...this.chatLog];
  }

  /* ── Actions ───────────────────────────────────────── */

  action(playerId, actionType, params = {}) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('Unknown player');
    if (!player.alive) throw new Error('Player is eliminated');
    const entry = {
      id:         `act_${this.actionLog.length + 1}`,
      playerId,
      actionType,
      params,
      turn:       this.turn,
      timestamp:  Date.now(),
    };
    this.actionLog.push(entry);
    this.emit('action', entry);
    this.emit(`action:${actionType}`, entry);
    return entry;
  }

  /* ── State ─────────────────────────────────────────── */

  set(key, value) { this.state[key] = value; this.emit('state:change', { key, value }); }
  get(key)        { return this.state[key]; }

  getFullState() {
    return {
      ...this.state,
      turn:     this.turn,
      phase:    this.phase,
      players:  this.getAllPlayers(),
      chatLog:  this.chatLog,
    };
  }

  /* ── Summary ───────────────────────────────────────── */

  getSummary() {
    return {
      gameId:       this.gameId,
      phase:        this.phase,
      turn:         this.turn,
      players:      this.getAllPlayers().map(p => ({ id: p.id, name: p.name, alive: p.alive, score: p.score })),
      chatMessages: this.chatLog.length,
      actions:      this.actionLog.length,
      duration:     this.endedAt
        ? this.endedAt - this.startedAt
        : (this.startedAt ? Date.now() - this.startedAt : 0),
    };
  }
}

module.exports = { SolarStudioEngine };
