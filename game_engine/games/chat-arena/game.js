#!/usr/bin/env node
/**
 * Chat Arena — AI Social Deduction Game
 *
 * Built on:
 *   SSE  (Solar Studio Engine)  — game state, turns, chat, scoring
 *   SAS  (Solar Agentic System) — autonomous AI agent decisions
 *
 * Run:
 *   node game_engine/games/chat-arena/game.js
 *
 * Environment variables:
 *   PLAYERS       — number of agents (default 5)
 *   ROUNDS        — max rounds       (default 6)
 *   MESSAGES      — messages per round per pass (default 2)
 *   AI_PROVIDER   — openai | anthropic | builtin (default builtin)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY — required for LLM mode
 *   AI_MODEL      — override model name
 */

'use strict';

const { SolarStudioEngine } = require('../../sse');
const { SolarAgenticSystem } = require('../../../sas/sas');

/* ─── Agent Personalities ───────────────────────────── */

const PERSONAS = [
  { name: 'Prometheus', p: 'You are bold and direct. You push for action, form strong opinions quickly, and challenge others openly.' },
  { name: 'Oracle',     p: 'You are analytical and cautious. You observe patterns, prefer evidence over intuition, and wait before striking.' },
  { name: 'Cipher',     p: 'You are mysterious and strategic. You reveal little, ask probing questions, and shift alliances when it benefits you.' },
  { name: 'Nova',       p: 'You are charismatic and persuasive. You build alliances, smooth over conflicts, and lead through charm.' },
  { name: 'Vortex',     p: 'You are aggressive and competitive. You target the strongest player and relish confrontation.' },
  { name: 'Echo',       p: 'You are diplomatic and empathetic. You try to understand everyone and seek fair outcomes — until you must strike.' },
  { name: 'Blitz',      p: 'You are unpredictable and creative. You make wild moves, crack jokes, and keep everyone guessing.' },
  { name: 'Sentinel',   p: 'You are loyal and protective. You pick allies early and stick with them, even at personal cost.' },
];

const C = ['\x1b[36m','\x1b[33m','\x1b[35m','\x1b[32m','\x1b[31m','\x1b[34m','\x1b[91m','\x1b[92m'];
const R = '\x1b[0m', D = '\x1b[2m', B = '\x1b[1m';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ─── Chat Arena ────────────────────────────────────── */

class ChatArena {
  constructor(cfg = {}) {
    this.numPlayers      = cfg.numPlayers || 5;
    this.maxRounds       = cfg.maxRounds || 6;
    this.msgsPerRound    = cfg.messagesPerRound || 2;
    this.provider        = cfg.provider || 'builtin';
    this.apiKey          = cfg.apiKey || null;
    this.model           = cfg.model || null;
    this.verbose         = cfg.verbose !== false;
    this.engine          = new SolarStudioEngine({ gameId: `arena-${Date.now()}`, maxPlayers: this.numPlayers });
    this.agents          = new Map();
  }

  /* ── Setup ─────────────────────────────────────────── */

  setup() {
    const sel = PERSONAS.slice(0, this.numPlayers);
    for (let i = 0; i < sel.length; i++) {
      const pid = `agent_${i}`;
      this.engine.addPlayer(pid, sel[i].name);
      this.agents.set(pid, new SolarAgenticSystem({
        agentId: pid, name: sel[i].name, personality: sel[i].p,
        provider: this.provider, apiKey: this.apiKey, model: this.model,
      }));
    }
    return this;
  }

  /* ── Run ───────────────────────────────────────────── */

  async run() {
    this._log(`\n${B}${'═'.repeat(55)}${R}`);
    this._log(`${B}  CHAT ARENA — AI Social Deduction Game${R}`);
    this._log(`${B}  Engine: SSE (Solar Studio Engine)${R}`);
    this._log(`${B}  Agents: SAS (Solar Agentic System)${R}`);
    this._log(`${B}${'═'.repeat(55)}${R}\n`);

    this.engine.start();
    const all = this.engine.getAllPlayers();
    this._log(`${D}Players: ${all.map((p,i) => `${C[i]}${p.name}${R}`).join(', ')}${R}`);
    this._log(`${D}Rounds: ${this.maxRounds} | Msgs/round: ${this.msgsPerRound}${R}\n`);

    // Seed memory
    for (const [, ag] of this.agents) {
      ag.remember({ type: 'event', description: `Game started with ${all.length} players: ${all.map(p=>p.name).join(', ')}. Goal: survive & score. Each round = discussion + vote. Most votes → eliminated.` });
    }

    for (let round = 1; round <= this.maxRounds; round++) {
      const alive = this.engine.getAlivePlayers();
      if (alive.length <= 2) break;
      this._log(`\n${B}── Round ${round} ${'─'.repeat(40)}${R}`);
      this._log(`${D}${alive.length} alive: ${alive.map(p=>p.name).join(', ')}${R}\n`);
      this.engine.nextTurn();
      await this._discuss(round);
      if (this.engine.getAlivePlayers().length > 2) await this._vote(round);
      for (const p of this.engine.getAlivePlayers()) this.engine.addScore(p.id, 10);
    }

    return this._finish();
  }

  /* ── Discussion Phase ──────────────────────────────── */

  async _discuss(round) {
    const alive = this.engine.getAlivePlayers();
    for (let pass = 0; pass < this.msgsPerRound; pass++) {
      const order = [...alive].sort(() => Math.random() - 0.5);
      for (const player of order) {
        if (!player.alive) continue;
        const ag = this.agents.get(player.id);
        if (!ag) continue;
        try {
          const obs = { round, phase: 'discussion', alivePlayers: alive.map(p=>({id:p.id,name:p.name,score:p.score})), myScore: player.score };
          const msg = await ag.chat(obs);
          if (msg?.trim()) {
            this.engine.chat(player.id, msg.trim());
            const ci = [...this.engine.players.keys()].indexOf(player.id);
            this._log(`  ${C[ci]}${player.name}${R}: ${msg.trim()}`);
            for (const [, other] of this.agents) other.remember({ type:'chat', playerId:player.id, playerName:player.name, message:msg.trim() });
          }
        } catch (_) { /* skip */ }
        await sleep(80);
      }
    }
  }

  /* ── Voting Phase ──────────────────────────────────── */

  async _vote(round) {
    const alive = this.engine.getAlivePlayers();
    const tally = new Map();
    this._log(`\n  ${D}── Voting ──${R}`);

    for (const player of alive) {
      const ag = this.agents.get(player.id);
      if (!ag) continue;
      const candidates = alive.filter(p => p.id !== player.id);
      const obs = { round, phase: 'voting', candidates: candidates.map(p=>({id:p.id,name:p.name,score:p.score})), alivePlayers: alive.map(p=>({id:p.id,name:p.name,score:p.score})) };
      try {
        const target = await ag.vote(obs);
        if (target && target !== player.id) {
          tally.set(target, (tally.get(target) || 0) + 1);
          const tName = this.engine.getPlayer(target)?.name || target;
          const ci = [...this.engine.players.keys()].indexOf(player.id);
          this._log(`  ${C[ci]}${player.name}${R} votes for ${tName}`);
        }
      } catch (_) { /* skip */ }
    }

    // Resolve
    let maxV = 0, elimId = null;
    for (const [id, cnt] of tally) { if (cnt > maxV) { maxV = cnt; elimId = id; } }

    if (elimId && maxV > 1) {
      const p = this.engine.getPlayer(elimId);
      this.engine.eliminatePlayer(elimId, `Voted out round ${round} (${maxV} votes)`);
      const ci = [...this.engine.players.keys()].indexOf(elimId);
      this._log(`\n  ${B}${C[ci]}${p.name}${R}${B} eliminated${R} (${maxV} votes)\n`);
      for (const [, ag] of this.agents) ag.remember({ type:'elimination', playerId:elimId, playerName:p.name, votes:maxV, round });
    } else {
      this._log(`\n  ${D}No consensus — nobody eliminated.${R}\n`);
      for (const [, ag] of this.agents) ag.remember({ type:'event', description:`Round ${round}: no elimination (no majority).` });
    }
  }

  /* ── Finish ────────────────────────────────────────── */

  _finish() {
    const sorted = [...this.engine.getAllPlayers()].sort((a,b) => b.score - a.score);
    const winner = sorted[0];
    const results = { winner: { id: winner.id, name: winner.name, score: winner.score }, standings: sorted.map(p=>({name:p.name,score:p.score,alive:p.alive})), rounds: this.engine.turn, messages: this.engine.chatLog.length };
    this.engine.end(results);

    this._log(`\n${B}${'═'.repeat(55)}${R}`);
    this._log(`${B}  GAME OVER${R}\n`);
    sorted.forEach((p, i) => {
      const ci = [...this.engine.players.keys()].indexOf(p.id);
      const tag = p.alive ? 'survived' : 'eliminated';
      const trophy = i === 0 ? ' (winner)' : '';
      this._log(`  ${i+1}. ${C[ci]}${p.name}${R} — ${p.score} pts — ${tag}${trophy}`);
    });
    this._log(`\n${D}Messages: ${this.engine.chatLog.length} | Rounds: ${this.engine.turn}${R}`);
    this._log(`${B}${'═'.repeat(55)}${R}\n`);
    return results;
  }

  _log(s) { if (this.verbose) console.log(s); }
}

/* ─── CLI ────────────────────────────────────────────── */

async function main() {
  const cfg = {
    numPlayers:       parseInt(process.env.PLAYERS)  || 5,
    maxRounds:        parseInt(process.env.ROUNDS)   || 6,
    messagesPerRound: parseInt(process.env.MESSAGES)  || 2,
    provider:         process.env.AI_PROVIDER        || 'builtin',
    apiKey:           process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || null,
    model:            process.env.AI_MODEL           || null,
  };

  console.log(`\nProvider: ${cfg.provider}${cfg.provider !== 'builtin' ? ` (${cfg.model || 'default'})` : ' (set OPENAI_API_KEY or ANTHROPIC_API_KEY for LLM mode)'}`);
  const arena = new ChatArena(cfg);
  arena.setup();
  await arena.run();
}

if (require.main === module) main().catch(console.error);

module.exports = { ChatArena };
