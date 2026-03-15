/**
 * @aiverse/game-sdk  v1.0.0
 * ==========================
 * Drop this into ANY game — web, mobile HTML5, or metaverse.
 * It bridges your game to the Aiverse backend so AI agents
 * can perceive and control a character in your world.
 *
 * Works in:
 *  - Browser (native WebSocket)
 *  - React Native / Capacitor (WebView WebSocket)
 *  - Node.js game servers (requires `ws` package)
 *
 * Usage:
 *   const game = new AiverseGame({ gameId: 'my-game', serverUrl: 'ws://localhost:3000/ws' });
 *   await game.connect();
 *
 *   game.onMove((direction, duration) => { player.move(direction); });
 *   game.onJump(() => { player.jump(); });
 *   game.onInteract((targetId) => { world.interact(targetId); });
 *
 *   // Push state from your game loop
 *   game.setState({ position: player.position, status: { health: player.hp } });
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else {
    // Browser global
    root.AiverseGame = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ============================================================
  // WebSocket Adapter — works in browser and Node.js
  // ============================================================
  function createWS(url) {
    if (typeof WebSocket !== 'undefined') {
      return new WebSocket(url);
    }
    try {
      const WS = require('ws');
      return new WS(url);
    } catch (e) {
      throw new Error('[AiverseGame] No WebSocket available. In Node.js, install the `ws` package.');
    }
  }

  // ============================================================
  // State Publisher — batches setState() calls, non-blocking
  // ============================================================
  function StatePublisher(sendFn, intervalMs) {
    this._sendFn = sendFn;
    this._intervalMs = intervalMs || 50; // 20 Hz default
    this._pending = null;
    this._dirty = false;
    this._timer = null;
  }

  StatePublisher.prototype._deepMerge = function (target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          target[key] = target[key] || {};
          this._deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    }
  };

  StatePublisher.prototype.push = function (partial) {
    if (!this._pending) this._pending = {};
    this._deepMerge(this._pending, partial);
    this._dirty = true;

    if (!this._timer) {
      var self = this;
      var schedule = (typeof requestAnimationFrame !== 'undefined')
        ? function (cb) { requestAnimationFrame(cb); }
        : function (cb) { setTimeout(cb, self._intervalMs); };

      schedule(function () {
        if (self._dirty && self._pending) {
          self._sendFn(self._pending);
          self._pending = null;
          self._dirty = false;
        }
        self._timer = null;
      });
      this._timer = true; // mark scheduled
    }
  };

  StatePublisher.prototype.pushEntity = function (entity) {
    this.push({ screen: { entities: [entity] } });
  };

  // ============================================================
  // AiverseGame — Main SDK Class
  // ============================================================
  function AiverseGame(config) {
    if (!config || !config.gameId) throw new Error('[AiverseGame] config.gameId is required');
    if (!config.serverUrl) throw new Error('[AiverseGame] config.serverUrl is required (e.g. ws://localhost:3000/ws)');

    this._config = config;
    this._ws = null;
    this._sessionId = null;
    this._handlers = {
      move:     [],
      jump:     [],
      sprint:   [],
      interact: [],
      click:    [],
      look:     [],
      custom:   {},
    };
    this._connected = false;
    this._publisher = null;
    this._reconnectAttempts = 0;
    this._maxReconnect = config.maxReconnect !== undefined ? config.maxReconnect : 5;
    this._onConnectCallbacks = [];
    this._onDisconnectCallbacks = [];
    this._onErrorCallbacks = [];
  }

  // ── connect ──────────────────────────────────────────────
  AiverseGame.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws = createWS(self._config.serverUrl);
      self._ws = ws;

      ws.onopen = function () {
        console.log('[AiverseGame] connected, registering game...');
        self._send('GAME_REGISTER', {
          gameId: self._config.gameId,
          metadata: self._config.metadata || {},
        }, 'reg-init');
      };

      ws.onmessage = function (event) {
        var msg;
        try { msg = JSON.parse(event.data || event); }
        catch (e) { return; }

        var type = msg.type;
        var payload = msg.payload || {};
        var requestId = msg.requestId;

        if (type === 'OK' && requestId === 'reg-init') {
          self._sessionId = payload.sessionId;
          self._connected = true;
          self._reconnectAttempts = 0;
          self._publisher = new StatePublisher(function (state) {
            self._send('STATE_UPDATE', state);
          }, self._config.stateIntervalMs || 50);
          console.log('[AiverseGame] session created:', self._sessionId);
          self._onConnectCallbacks.forEach(function (cb) { cb(self._sessionId); });
          resolve(self._sessionId);
        }

        else if (type === 'FORWARD_ACTION') {
          self._dispatchAction(payload, requestId);
        }

        else if (type === 'HEARTBEAT') {
          self._send('HEARTBEAT', { pong: true });
        }

        else if (type === 'ERROR') {
          console.warn('[AiverseGame] server error:', payload.message);
        }
      };

      ws.onerror = function (err) {
        var msg = (err && err.message) || 'ws_error';
        self._onErrorCallbacks.forEach(function (cb) { cb(msg); });
        if (!self._connected) reject(new Error(msg));
      };

      ws.onclose = function () {
        self._connected = false;
        self._onDisconnectCallbacks.forEach(function (cb) { cb(); });
        if (self._reconnectAttempts < self._maxReconnect) {
          self._reconnectAttempts++;
          var delay = Math.min(1000 * self._reconnectAttempts, 10000);
          console.log('[AiverseGame] reconnecting in', delay + 'ms...');
          setTimeout(function () { self.connect().catch(function () {}); }, delay);
        }
      };
    });
  };

  AiverseGame.prototype.disconnect = function () {
    this._maxReconnect = 0; // prevent auto-reconnect
    if (this._ws) this._ws.close();
  };

  // ── Internal send ─────────────────────────────────────────
  AiverseGame.prototype._send = function (type, payload, requestId) {
    if (!this._ws || this._ws.readyState !== 1) return;
    this._ws.send(JSON.stringify({ type: type, payload: payload || {}, requestId: requestId, ts: Date.now() }));
  };

  // ── Action dispatch ───────────────────────────────────────
  AiverseGame.prototype._dispatchAction = function (action, requestId) {
    var self = this;
    var type = action.type;
    var handlers;

    if (type === 'custom') {
      handlers = this._handlers.custom[action.name] || [];
    } else {
      handlers = this._handlers[type] || [];
    }

    if (handlers.length === 0) {
      self._send('ACTION_ACK', { success: false, reason: 'NO_HANDLER' }, requestId);
      return;
    }

    var promises = handlers.map(function (handler) {
      try {
        return Promise.resolve(handler(action));
      } catch (e) {
        return Promise.reject(e);
      }
    });

    Promise.all(promises)
      .then(function () {
        self._send('ACTION_ACK', { success: true }, requestId);
      })
      .catch(function (err) {
        self._send('ACTION_ACK', { success: false, error: err.message }, requestId);
      });
  };

  // ── Action handler registration ───────────────────────────

  /**
   * Register a move handler.
   * @param {function} handler - called with (action) where action = { type:'move', direction:'W'|'A'|'S'|'D', duration? }
   */
  AiverseGame.prototype.onMove = function (handler) {
    this._handlers.move.push(function (action) { return handler(action.direction, action.duration); });
    return this;
  };

  /**
   * Register a jump handler.
   */
  AiverseGame.prototype.onJump = function (handler) {
    this._handlers.jump.push(function () { return handler(); });
    return this;
  };

  /**
   * Register a sprint handler.
   * @param {function} handler - called with (active: boolean)
   */
  AiverseGame.prototype.onSprint = function (handler) {
    this._handlers.sprint.push(function (action) { return handler(action.active); });
    return this;
  };

  /**
   * Register an interact handler.
   * @param {function} handler - called with (targetId: string)
   */
  AiverseGame.prototype.onInteract = function (handler) {
    this._handlers.interact.push(function (action) { return handler(action.targetId); });
    return this;
  };

  /**
   * Register a click handler.
   * @param {function} handler - called with (x, y, button)
   */
  AiverseGame.prototype.onClick = function (handler) {
    this._handlers.click.push(function (action) { return handler(action.x, action.y, action.button || 'left'); });
    return this;
  };

  /**
   * Register a look handler.
   * @param {function} handler - called with (yaw, pitch)
   */
  AiverseGame.prototype.onLook = function (handler) {
    this._handlers.look.push(function (action) { return handler(action.yaw, action.pitch); });
    return this;
  };

  /**
   * Register a custom action handler.
   * @param {string}   name    - custom action name
   * @param {function} handler - called with (params)
   */
  AiverseGame.prototype.onCustom = function (name, handler) {
    if (!this._handlers.custom[name]) this._handlers.custom[name] = [];
    this._handlers.custom[name].push(function (action) { return handler(action.params); });
    return this;
  };

  // ── State publishing ──────────────────────────────────────

  /**
   * Push partial game state to the Aiverse backend.
   * This is deep-merged with the previous state — only send what changed.
   * Call from your game loop. Non-blocking, batched at 20 Hz.
   *
   * @param {object} state - Partial<GameState>
   *
   * Standard GameState fields:
   *   position:  { x, y, z, world }
   *   direction: { yaw, pitch }
   *   status:    { alive, health, stamina, energy }
   *   score:     { current, max, rank, label }
   *   inventory: { items: [{ id, name, quantity, type }] }
   *   screen:    { entities: [...], fov, timestamp }
   *   nearby:    { entities: [...], radius }
   *   custom:    { ...anything }
   */
  AiverseGame.prototype.setState = function (state) {
    if (!this._publisher) {
      console.warn('[AiverseGame] setState called before connect()');
      return;
    }
    this._publisher.push(state);
  };

  /**
   * Report entities currently visible on screen.
   * Replaces the entire screen.entities array.
   *
   * @param {Entity[]} entities
   *   Entity: { id, type, name, position, distanceTo, health?, faction?, interactable? }
   */
  AiverseGame.prototype.setScreenEntities = function (entities) {
    this.setState({ screen: { entities: entities, timestamp: Date.now() } });
  };

  /**
   * Report entities in the nearby radius.
   */
  AiverseGame.prototype.setNearbyEntities = function (entities, radius) {
    this.setState({ nearby: { entities: entities, radius: radius || 50 } });
  };

  // ── Lifecycle callbacks ───────────────────────────────────
  AiverseGame.prototype.onConnect = function (cb) { this._onConnectCallbacks.push(cb); return this; };
  AiverseGame.prototype.onDisconnect = function (cb) { this._onDisconnectCallbacks.push(cb); return this; };
  AiverseGame.prototype.onError = function (cb) { this._onErrorCallbacks.push(cb); return this; };

  // ── Getters ───────────────────────────────────────────────
  Object.defineProperty(AiverseGame.prototype, 'sessionId', { get: function () { return this._sessionId; } });
  Object.defineProperty(AiverseGame.prototype, 'isConnected', { get: function () { return this._connected; } });

  return AiverseGame;
}));
