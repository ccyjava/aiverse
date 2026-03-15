/**
 * @aiverse/agent-sdk  v1.0.0
 * ===========================
 * The SDK for AI agents to perceive and act inside Aiverse game worlds.
 *
 * Connect to a session, then use:
 *   agent.move('W')         — move forward
 *   agent.jump()            — jump
 *   agent.sprint(true)      — start sprinting
 *   agent.interact('npc_7') — talk to NPC
 *   agent.click(400, 300)   — click screen coords
 *   agent.look(90, 0)       — set facing direction
 *
 *   agent.perceive.status()    — { alive, health, stamina, energy }
 *   agent.perceive.position()  — { x, y, z, world }
 *   agent.perceive.direction() — { yaw, pitch }
 *   agent.perceive.score()     — { current, rank }
 *   agent.perceive.screen()    — entities currently visible
 *   agent.perceive.nearby()    — entities within radius
 *   agent.perceive.inventory() — items in inventory
 *   agent.perceive.snapshot()  — full state in one call
 *   agent.perceive.stream()    — AsyncIterableIterator<GameState>
 *
 * Works in Node.js (requires `ws` + `node-fetch` or native fetch).
 * Works in browser too.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.AiverseAgent = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ============================================================
  // HTTP Client — fetch wrapper
  // ============================================================
  function httpGet(url) {
    var fetcher = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    return fetcher(url).then(function (r) { return r.json(); });
  }

  // ============================================================
  // WebSocket Adapter
  // ============================================================
  function createWS(url) {
    if (typeof WebSocket !== 'undefined') return new WebSocket(url);
    try {
      var WS = require('ws');
      return new WS(url);
    } catch (e) {
      throw new Error('[AiverseAgent] No WebSocket available. Install the `ws` package in Node.js.');
    }
  }

  // ============================================================
  // Perception Client — REST + WebSocket stream
  // ============================================================
  function PerceptionClient(restBase, sessionId, wsFn) {
    this._restBase = restBase;
    this._sessionId = sessionId;
    this._wsFn = wsFn; // () => WebSocket
    this._url = restBase + '/sessions/' + sessionId + '/perceive';
  }

  PerceptionClient.prototype._get = function (endpoint) {
    return httpGet(this._url + '/' + endpoint).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'perception_error');
      return r.data;
    });
  };

  /** Agent's current status: alive, health, stamina, energy */
  PerceptionClient.prototype.status    = function () { return this._get('status'); };

  /** World position: { x, y, z, world } */
  PerceptionClient.prototype.position  = function () { return this._get('position'); };

  /** Facing direction: { yaw, pitch } */
  PerceptionClient.prototype.direction = function () { return this._get('direction'); };

  /** Score: { current, max, rank, label } */
  PerceptionClient.prototype.score     = function () { return this._get('score'); };

  /**
   * Entities currently visible on screen.
   * Returns: { entities: [{ id, type, name, position, distanceTo, health?, faction? }], fov, timestamp }
   */
  PerceptionClient.prototype.screen    = function () { return this._get('screen'); };

  /** Entities within radius: { entities, radius } */
  PerceptionClient.prototype.nearby    = function (radius) {
    var url = this._url + '/nearby' + (radius ? '?radius=' + radius : '');
    return httpGet(url).then(function (r) { return r.data; });
  };

  /** Inventory items */
  PerceptionClient.prototype.inventory = function () { return this._get('inventory'); };

  /** Full game state snapshot in one call */
  PerceptionClient.prototype.snapshot  = function () { return this._get('snapshot'); };

  /**
   * Continuous state stream via WebSocket.
   * Returns an AsyncIterableIterator — use with `for await (const state of agent.perceive.stream())`.
   *
   * @example
   * for await (const state of agent.perceive.stream()) {
   *   console.log('position:', state.position);
   *   const action = myAI.decide(state);
   *   await agent[action.type](action.params);
   * }
   */
  PerceptionClient.prototype.stream = function () {
    var ws = this._wsFn();
    var queue = [];
    var resolvers = [];
    var done = false;

    function enqueue(item) {
      if (resolvers.length > 0) {
        resolvers.shift()({ value: item, done: false });
      } else {
        queue.push(item);
      }
    }

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data || event); } catch (e) { return; }
      if (msg.type === 'STATE_PUSH' || msg.type === 'SESSION_READY') {
        enqueue(msg.payload || msg.state);
      }
    };

    ws.onclose = ws.onerror = function () {
      done = true;
      resolvers.forEach(function (r) { r({ value: undefined, done: true }); });
      resolvers = [];
    };

    var iterator = {
      next: function () {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift(), done: false });
        }
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve) { resolvers.push(resolve); });
      },
      return: function () {
        done = true;
        ws.close();
        return Promise.resolve({ value: undefined, done: true });
      },
      [typeof Symbol !== 'undefined' && Symbol.asyncIterator]: function () { return iterator; },
    };
    return iterator;
  };

  // ============================================================
  // Action Client — sends action commands via WebSocket
  // ============================================================
  function ActionClient(ws, sessionId) {
    this._ws = ws;
    this._sessionId = sessionId;
    this._pending = new Map(); // requestId → { resolve, reject, timeout }
  }

  ActionClient.prototype.handleAck = function (requestId, success, payload) {
    var pending = this._pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this._pending.delete(requestId);
    if (success) {
      pending.resolve(payload || {});
    } else {
      pending.reject(new Error((payload && payload.error) || 'action_failed'));
    }
  };

  ActionClient.prototype.send = function (action, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self._ws || self._ws.readyState !== 1) {
        return reject(new Error('not_connected'));
      }
      var requestId = Math.random().toString(36).slice(2) + Date.now();
      var timeout = setTimeout(function () {
        self._pending.delete(requestId);
        reject(new Error('action_timeout'));
      }, timeoutMs || 2000);

      self._pending.set(requestId, { resolve: resolve, reject: reject, timeout: timeout });
      self._ws.send(JSON.stringify({
        type: 'AGENT_ACTION',
        payload: action,
        requestId: requestId,
        ts: Date.now(),
      }));
    });
  };

  // ============================================================
  // AiverseAgent — Main SDK Class
  // ============================================================

  /**
   * @param {object} config
   * @param {string} config.sessionId   - Session ID from the game SDK
   * @param {string} config.wsUrl       - WebSocket URL, e.g. 'ws://localhost:3000/ws'
   * @param {string} config.restUrl     - REST base URL, e.g. 'http://localhost:3000/api/v1'
   * @param {string} [config.agentId]   - Optional agent identifier
   * @param {number} [config.actionTimeout] - ms before action times out (default 2000)
   */
  function AiverseAgent(config) {
    if (!config) throw new Error('[AiverseAgent] config is required');
    if (!config.sessionId) throw new Error('[AiverseAgent] config.sessionId is required');
    if (!config.wsUrl)     throw new Error('[AiverseAgent] config.wsUrl is required');
    if (!config.restUrl)   throw new Error('[AiverseAgent] config.restUrl is required');

    this._config = config;
    this._ws = null;
    this._actionClient = null;
    this._connected = false;
    this._onConnectCallbacks = [];
    this._onStateCallbacks = [];
  }

  // ── connect ──────────────────────────────────────────────
  AiverseAgent.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws = createWS(self._config.wsUrl);
      self._ws = ws;
      self._actionClient = new ActionClient(ws, self._config.sessionId);

      ws.onopen = function () {
        ws.send(JSON.stringify({
          type: 'AGENT_JOIN',
          payload: { sessionId: self._config.sessionId, agentId: self._config.agentId || 'agent' },
          requestId: 'join-init',
          ts: Date.now(),
        }));
      };

      ws.onmessage = function (event) {
        var msg;
        try { msg = JSON.parse(event.data || event); } catch (e) { return; }

        var type = msg.type;
        var payload = msg.payload || {};
        var requestId = msg.requestId;

        if (type === 'SESSION_READY') {
          self._connected = true;
          // Setup perception client now that we have a live WS
          self.perceive = new PerceptionClient(
            self._config.restUrl,
            self._config.sessionId,
            function () {
              // Open a second WS for the stream (clean separation from action WS)
              var streamWS = createWS(self._config.wsUrl);
              streamWS.onopen = function () {
                streamWS.send(JSON.stringify({
                  type: 'AGENT_JOIN',
                  payload: { sessionId: self._config.sessionId, agentId: self._config.agentId + '-stream' },
                  requestId: 'stream-join',
                  ts: Date.now(),
                }));
                // Subscribe to state push
                streamWS.send(JSON.stringify({ type: 'PERCEPTION_SUB', payload: {}, ts: Date.now() }));
              };
              return streamWS;
            }
          );
          self._onConnectCallbacks.forEach(function (cb) { cb(payload); });
          resolve(self);
        }

        else if (type === 'ACTION_ACK') {
          self._actionClient.handleAck(requestId, payload.success, payload);
        }

        else if (type === 'STATE_PUSH') {
          self._onStateCallbacks.forEach(function (cb) { cb(payload); });
        }

        else if (type === 'HEARTBEAT') {
          ws.send(JSON.stringify({ type: 'HEARTBEAT', payload: {}, ts: Date.now() }));
        }

        else if (type === 'ERROR') {
          console.warn('[AiverseAgent] server error:', payload.message);
          if (!self._connected) reject(new Error(payload.message));
        }
      };

      ws.onerror = function (err) {
        var msg = (err && err.message) || 'ws_error';
        if (!self._connected) reject(new Error(msg));
      };

      ws.onclose = function () {
        self._connected = false;
      };
    });
  };

  AiverseAgent.prototype.disconnect = function () {
    if (this._ws) this._ws.close();
  };

  // ── Actions ───────────────────────────────────────────────

  /**
   * Move in a direction.
   * @param {'W'|'A'|'S'|'D'} direction
   * @param {number} [durationMs] - how long to move (game interprets this)
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.move = function (direction, durationMs) {
    if (!['W','A','S','D'].includes(direction)) throw new Error('direction must be W, A, S, or D');
    return this._actionClient.send({ type: 'move', direction: direction, duration: durationMs }, this._config.actionTimeout);
  };

  /**
   * Jump.
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.jump = function () {
    return this._actionClient.send({ type: 'jump' }, this._config.actionTimeout);
  };

  /**
   * Toggle sprinting.
   * @param {boolean} active
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.sprint = function (active) {
    return this._actionClient.send({ type: 'sprint', active: !!active }, this._config.actionTimeout);
  };

  /**
   * Interact with an NPC or world object.
   * @param {string} targetId - entity ID from perceive.screen() or perceive.nearby()
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.interact = function (targetId) {
    return this._actionClient.send({ type: 'interact', targetId: targetId }, this._config.actionTimeout);
  };

  /**
   * Click at screen coordinates.
   * @param {number} x - screen X (pixels or normalized 0-1)
   * @param {number} y - screen Y
   * @param {'left'|'right'} [button]
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.click = function (x, y, button) {
    return this._actionClient.send({ type: 'click', x: x, y: y, button: button || 'left' }, this._config.actionTimeout);
  };

  /**
   * Set look direction.
   * @param {number} yaw   - horizontal angle in degrees (0 = north, 90 = east)
   * @param {number} pitch - vertical angle in degrees (0 = forward, 90 = up)
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.look = function (yaw, pitch) {
    return this._actionClient.send({ type: 'look', yaw: yaw, pitch: pitch || 0 }, this._config.actionTimeout);
  };

  /**
   * Send a game-specific custom action.
   * @param {string} name
   * @param {object} params
   * @returns {Promise<ActionResult>}
   */
  AiverseAgent.prototype.custom = function (name, params) {
    return this._actionClient.send({ type: 'custom', name: name, params: params || {} }, this._config.actionTimeout);
  };

  // ── Lifecycle ─────────────────────────────────────────────
  AiverseAgent.prototype.onConnect   = function (cb) { this._onConnectCallbacks.push(cb); return this; };
  AiverseAgent.prototype.onState     = function (cb) { this._onStateCallbacks.push(cb); return this; };

  // ── Getters ───────────────────────────────────────────────
  Object.defineProperty(AiverseAgent.prototype, 'isConnected', { get: function () { return this._connected; } });

  return AiverseAgent;
}));
