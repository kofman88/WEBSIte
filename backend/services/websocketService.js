const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config');
const signalService = require('./signalService');

/**
 * WebSocket service for real-time signal broadcasting.
 *
 * Clients connect via ws://host:WS_PORT and optionally authenticate
 * by sending { type: 'auth', token: 'Bearer ...' } as their first message.
 *
 * Unauthenticated clients receive basic heartbeats only.
 * Authenticated clients receive real-time signal events.
 */
class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws -> { userId, authenticated, alive }
    this._pollInterval = null;
    this._lastSignalId = 0;
  }

  /**
   * Initialise the WebSocket server.
   * Can attach to an existing HTTP server or listen on a standalone port.
   *
   * @param {object} options - { server } for attachment, or falls back to config.wsPort
   */
  init(options = {}) {
    if (options.server) {
      this.wss = new WebSocket.Server({ server: options.server, path: '/ws' });
    } else {
      this.wss = new WebSocket.Server({ port: config.wsPort });
      console.log(`WebSocket server listening on port ${config.wsPort}`);
    }

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    // Detect stale connections every 30s
    this._heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const meta = this.clients.get(ws);
        if (meta && !meta.alive) {
          this.clients.delete(ws);
          return ws.terminate();
        }
        if (meta) meta.alive = false;
        try { ws.ping(); } catch (_) { /* noop */ }
      });
    }, 30000);

    // Poll for new signals every 3s and broadcast
    this._initializeLastSignalId();
    this._pollInterval = setInterval(() => {
      this._broadcastNewSignals();
    }, 3000);

    return this.wss;
  }

  /**
   * Seed lastSignalId from the DB so we only broadcast truly new signals.
   */
  _initializeLastSignalId() {
    try {
      const db = require('../models/database');
      const row = db.prepare('SELECT MAX(id) as maxId FROM signal_history').get();
      this._lastSignalId = row?.maxId || 0;
    } catch (_) {
      this._lastSignalId = 0;
    }
  }

  /**
   * Handle a new WebSocket connection.
   */
  _handleConnection(ws, req) {
    this.clients.set(ws, { userId: null, authenticated: false, alive: true });

    ws.on('pong', () => {
      const meta = this.clients.get(ws);
      if (meta) meta.alive = true;
    });

    ws.on('message', (data) => {
      this._handleMessage(ws, data);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket client error:', err.message);
      this.clients.delete(ws);
    });

    // Welcome
    this._send(ws, {
      type: 'welcome',
      message: 'Connected to CHM Finance real-time feed',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle an incoming message from a client.
   */
  _handleMessage(ws, rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (_) {
      return this._send(ws, { type: 'error', message: 'Invalid JSON' });
    }

    switch (msg.type) {
      case 'auth':
        this._authenticateClient(ws, msg.token);
        break;

      case 'ping':
        this._send(ws, { type: 'pong', timestamp: new Date().toISOString() });
        break;

      case 'subscribe':
        // Future: topic-based subscriptions
        this._send(ws, { type: 'subscribed', topic: msg.topic || 'signals' });
        break;

      default:
        this._send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  /**
   * Authenticate a WebSocket client using a JWT token.
   */
  _authenticateClient(ws, token) {
    if (!token) {
      return this._send(ws, { type: 'auth_error', message: 'Token required' });
    }

    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;

    try {
      const decoded = jwt.verify(cleanToken, config.jwtSecret);
      const meta = this.clients.get(ws);
      if (meta) {
        meta.userId = decoded.userId;
        meta.authenticated = true;
      }
      this._send(ws, {
        type: 'authenticated',
        userId: decoded.userId,
      });
    } catch (err) {
      this._send(ws, { type: 'auth_error', message: 'Invalid or expired token' });
    }
  }

  /**
   * Poll the database for new signals and broadcast to authenticated clients.
   */
  _broadcastNewSignals() {
    try {
      const newSignals = signalService.getSignalsSince(this._lastSignalId);
      if (newSignals.length === 0) return;

      for (const signal of newSignals) {
        this.broadcast({
          type: 'signal',
          data: signal,
        }, true); // only authenticated
        this._lastSignalId = signal.id;
      }
    } catch (err) {
      console.error('WebSocket broadcast error:', err.message);
    }
  }

  /**
   * Broadcast a message to all connected (optionally only authenticated) clients.
   */
  broadcast(message, authenticatedOnly = false) {
    if (!this.wss) return;

    this.wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const meta = this.clients.get(ws);
      if (authenticatedOnly && (!meta || !meta.authenticated)) return;

      this._send(ws, message);
    });
  }

  /**
   * Send a message object to a single client.
   */
  _send(ws, obj) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    } catch (err) {
      console.error('WebSocket send error:', err.message);
    }
  }

  /**
   * Get connection stats.
   */
  getStats() {
    let total = 0;
    let authenticated = 0;

    if (this.wss) {
      this.wss.clients.forEach((ws) => {
        total++;
        const meta = this.clients.get(ws);
        if (meta?.authenticated) authenticated++;
      });
    }

    return { totalConnections: total, authenticatedConnections: authenticated };
  }

  /**
   * Gracefully shut down the WebSocket server.
   */
  shutdown() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this.wss) {
      this.wss.clients.forEach((ws) => {
        try {
          ws.close(1001, 'Server shutting down');
        } catch (_) { /* noop */ }
      });
      this.wss.close();
    }
  }
}

module.exports = new WebSocketService();
