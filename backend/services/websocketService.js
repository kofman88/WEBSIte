/**
 * WebSocket service for real-time signal broadcasting.
 *
 * Connect: ws://host:WS_PORT (dev) or wss://chmup.top/ws (prod).
 * Auth: first message `{ type: 'auth', token: 'Bearer <JWT>' }`.
 *
 *   - Unauthenticated: receive public signals (user_id = NULL) + heartbeat
 *   - Authenticated:   receive public + own bot signals
 *
 * Public API:
 *   init({ server })        - attach to HTTP server or start standalone
 *   broadcastPublic(payload)- send to ALL clients
 *   broadcastToUser(uid, p) - send to all sockets owned by that user
 *   shutdown()              - graceful close
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws → { userId, authenticated, alive }
    this._heartbeatInterval = null;
  }

  init(options = {}) {
    if (this.wss) return;
    if (options.server) {
      this.wss = new WebSocket.Server({ server: options.server, path: '/ws' });
      logger.info('WebSocket attached to HTTP server on /ws');
    } else {
      this.wss = new WebSocket.Server({ port: config.wsPort });
      logger.info('WebSocket standalone on port ' + config.wsPort);
    }

    this.wss.on('connection', (ws, req) => this._onConnect(ws, req));
    this.wss.on('error', (err) => logger.error('wss error', { err: err.message }));

    // Heartbeat: kick sockets that don't respond to ping
    this._heartbeatInterval = setInterval(() => this._heartbeat(), 30_000);
  }

  _onConnect(ws, req) {
    const meta = { userId: null, authenticated: false, alive: true };
    this.clients.set(ws, meta);

    ws.on('pong', () => { const m = this.clients.get(ws); if (m) m.alive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (_e) { return; }
      if (msg.type === 'auth' && typeof msg.token === 'string') {
        const token = msg.token.replace(/^Bearer\s+/i, '');
        try {
          const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
          if (decoded && decoded.uid) {
            meta.userId = decoded.uid;
            meta.authenticated = true;
            this._send(ws, { type: 'auth_ok', userId: decoded.uid });
            return;
          }
        } catch (_e) { /* fall through */ }
        this._send(ws, { type: 'auth_fail' });
      }
    });

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));

    this._send(ws, { type: 'hello', version: '3.0.0', ts: Date.now() });
  }

  _heartbeat() {
    for (const [ws, meta] of this.clients) {
      if (!meta.alive) {
        try { ws.terminate(); } catch (_e) {}
        this.clients.delete(ws);
        continue;
      }
      meta.alive = false;
      try { ws.ping(); } catch (_e) {}
    }
  }

  _send(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch (_e) {}
  }

  broadcastPublic(payload) {
    if (!this.wss) return;
    for (const [ws] of this.clients) this._send(ws, payload);
  }

  broadcastToUser(userId, payload) {
    if (!this.wss || !userId) return;
    for (const [ws, meta] of this.clients) {
      if (meta.userId === userId) this._send(ws, payload);
    }
  }

  /**
   * Signal-specific helper: public signals go to everyone, user-scoped go
   * to that user's sockets (+ public if you pass broadcastPublic=true).
   */
  broadcastSignal(signal) {
    if (!signal) return;
    const payload = { type: 'signal', data: signal, ts: Date.now() };
    if (signal.userId) {
      this.broadcastToUser(signal.userId, payload);
    } else {
      this.broadcastPublic(payload);
    }
  }

  shutdown() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (!this.wss) return;
    for (const [ws] of this.clients) {
      try { ws.close(1001, 'server shutdown'); } catch (_e) {}
    }
    this.clients.clear();
    try { this.wss.close(); } catch (_e) {}
    this.wss = null;
    logger.info('WebSocket shutdown complete');
  }

  get clientCount() {
    return this.clients.size;
  }
}

module.exports = new WebSocketService();
