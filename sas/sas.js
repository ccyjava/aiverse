/**
 * SAS — Solar Agentic System
 * AI agent framework for autonomous game-playing.
 * Part of TokenFly's AI infrastructure.
 *
 * Features:
 *   - Multi-provider LLM support (OpenAI, Anthropic, built-in)
 *   - Sliding-window memory
 *   - Context-aware chat, voting, and decision generation
 *   - Personality injection
 *   - Built-in rule-based fallback (works with zero API keys)
 */

'use strict';

/* ─── Solar Agentic System ──────────────────────────── */

class SolarAgenticSystem {
  constructor(config = {}) {
    this.agentId     = config.agentId || `agent_${Date.now()}`;
    this.name        = config.name || 'Agent';
    this.personality = config.personality || 'You are a strategic and thoughtful game player.';
    this.provider    = config.provider || 'builtin';   // openai | anthropic | builtin
    this.apiKey      = config.apiKey || null;
    this.model       = config.model || null;
    this.memory      = [];
    this.maxMemory   = config.maxMemory || 100;
    this.temperature = config.temperature ?? 0.7;
    this._seq        = 0;
  }

  /* ── Memory ────────────────────────────────────────── */

  remember(event) {
    this.memory.push({ ...event, _ts: Date.now() });
    if (this.memory.length > this.maxMemory) this.memory.shift();
  }

  getMemory(last) { return last ? this.memory.slice(-last) : [...this.memory]; }
  clearMemory()   { this.memory = []; }

  /* ── High-Level Actions ────────────────────────────── */

  async think(observation) {
    this._seq++;
    const ctx = this._buildThinkCtx(observation);
    return this._dispatch(ctx, () => this._builtinThink(observation));
  }

  async chat(observation) {
    this._seq++;
    const ctx = this._buildChatCtx(observation);
    return this._dispatch(ctx, () => this._builtinChat(observation));
  }

  async vote(observation) {
    this._seq++;
    const ctx = this._buildVoteCtx(observation);
    return this._dispatch(
      ctx,
      () => this._builtinVote(observation),
      raw => this._parseVote(raw, observation),
    );
  }

  /* ── Dispatch to Provider ──────────────────────────── */

  async _dispatch(ctx, fallback, postprocess) {
    let raw;
    if (this.provider === 'openai' && this.apiKey) {
      raw = await this._callOpenAI(ctx);
    } else if (this.provider === 'anthropic' && this.apiKey) {
      raw = await this._callAnthropic(ctx);
    } else {
      raw = fallback();
    }
    return postprocess ? postprocess(raw) : raw;
  }

  /* ── Context Builders ──────────────────────────────── */

  _memoryStr(n = 20) {
    return this.memory.slice(-n).map(m =>
      m.type === 'chat'        ? `${m.playerName}: ${m.message}` :
      m.type === 'event'       ? `[${m.description}]` :
      m.type === 'elimination' ? `[${m.playerName} was eliminated]` : ''
    ).filter(Boolean).join('\n');
  }

  _playerList(obs) {
    return (obs.alivePlayers || []).map(p => p.name).join(', ');
  }

  _buildThinkCtx(obs) {
    return {
      system: `${this.personality}\nYou are playing a social game. Decide strategically.`,
      prompt: `Memory:\n${this._memoryStr()}\n\nSituation: ${JSON.stringify(obs)}\n\nRespond JSON: { "action": "...", "reasoning": "..." }`,
    };
  }

  _buildChatCtx(obs) {
    return {
      system: `${this.personality}\nYou are "${this.name}" in a multiplayer social game. Write a short in-character chat message (1-2 sentences). Be strategic, not generic.`,
      prompt: `Recent chat:\n${this._memoryStr(15)}\n\nRound ${obs.round || '?'} | Alive: ${this._playerList(obs)}\n\nWrite your message as ${this.name}. Just the message text.`,
    };
  }

  _buildVoteCtx(obs) {
    const names = (obs.candidates || []).map(p => p.name).join(', ');
    return {
      system: `${this.personality}\nVote to eliminate one player. Choose strategically.`,
      prompt: `Recent chat:\n${this._memoryStr(15)}\n\nCandidates: ${names}\nYou are "${this.name}". You cannot vote for yourself.\n\nRespond with ONLY the name.`,
    };
  }

  /* ── Vote Parsing ──────────────────────────────────── */

  _parseVote(text, obs) {
    const clean = (text || '').trim().toLowerCase();
    const candidates = obs.candidates || [];
    const match = candidates.find(p => clean.includes(p.name.toLowerCase()));
    if (match) return match.id;
    // fallback: random other player
    const others = candidates.filter(p => p.id !== this.agentId);
    return others.length ? others[Math.floor(Math.random() * others.length)].id : null;
  }

  /* ── Built-in Agent (no API key) ───────────────────── */

  _builtinChat(obs) {
    const alive = (obs.alivePlayers || []).filter(p => p.id !== this.agentId);
    const rand  = alive[Math.floor(Math.random() * alive.length)]?.name || 'someone';
    const r     = obs.round || 1;
    const pool  = [
      `I think we need to focus on who's been quiet. Silence is suspicious.`,
      `${rand}, what's your real strategy here? You've been evasive.`,
      `I'm playing to win, but I'd rather win through alliances than backstabbing.`,
      `Look at the scores — who's gaining too fast? That's who we should worry about.`,
      `I've been watching carefully. Some of you aren't who you claim to be.`,
      `Round ${r}. We need smarter decisions from here on out.`,
      `I propose we work together this round. ${rand}, are you in?`,
      `The eliminated players were threats. But the real threat is still here.`,
      `My goal is survival. I'll cooperate with anyone willing to cooperate back.`,
      `${rand} has been making moves that benefit no one but themselves.`,
      `Pay attention to who voted against the consensus last round.`,
      `I trust ${rand} for now. But trust is earned, not given.`,
      `Every round the stakes get higher. Choose your alliances wisely.`,
      `Don't vote blindly. Let's actually discuss before we decide.`,
      `Someone here is playing everyone. I have my suspicions.`,
    ];
    const idx = (this._seq + this.agentId.charCodeAt(this.agentId.length - 1)) % pool.length;
    return pool[idx];
  }

  _builtinVote(obs) {
    const candidates = (obs.candidates || []).filter(p => p.id !== this.agentId);
    if (!candidates.length) return null;
    // 60% vote for the score leader, 40% random
    candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    if (Math.random() < 0.6) return candidates[0].id;
    return candidates[Math.floor(Math.random() * candidates.length)].id;
  }

  _builtinThink(obs) {
    return JSON.stringify({ action: 'wait', reasoning: 'Observing the situation.' });
  }

  /* ── LLM Providers ─────────────────────────────────── */

  async _callOpenAI(ctx) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: ctx.system },
          { role: 'user',   content: ctx.prompt },
        ],
        temperature: this.temperature,
        max_tokens: 200,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async _callAnthropic(ctx) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model || 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: ctx.system,
        messages: [{ role: 'user', content: ctx.prompt }],
        temperature: this.temperature,
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }
}

module.exports = { SolarAgenticSystem };
