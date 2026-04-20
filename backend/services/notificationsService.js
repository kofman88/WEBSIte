/**
 * In-app notifications service — writes to notifications table and
 * optionally broadcasts over websocket so a bell-icon in the UI updates
 * instantly.
 *
 * Usage:
 *   notifications.create(userId, {
 *     type: 'trade_opened',
 *     title: 'BTC/USDT LONG',
 *     body: 'Бот BTC Scalper открыл сделку',
 *     link: '/dashboard.html#trades'
 *   });
 */

const db = require('../models/database');
const logger = require('../utils/logger');

function create(userId, { type, title, body = null, link = null }) {
  if (!userId || !type || !title) throw new Error('notifications.create: missing userId/type/title');
  const info = db.prepare(`
    INSERT INTO notifications (user_id, type, title, body, link)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, title, body, link);

  // Best-effort WS broadcast — lazy-required to avoid circular dep
  try {
    const ws = require('./websocketService');
    if (ws && ws.broadcastToUser) {
      ws.broadcastToUser(userId, {
        type: 'notification',
        data: { id: info.lastInsertRowid, type, title, body, link, createdAt: new Date().toISOString() },
        ts: Date.now(),
      });
    }
  } catch (_e) { /* silent */ }

  return info.lastInsertRowid;
}

function listForUser(userId, { limit = 50, offset = 0, unreadOnly = false } = {}) {
  const where = unreadOnly ? 'WHERE user_id = ? AND read_at IS NULL' : 'WHERE user_id = ?';
  const rows = db.prepare(`
    SELECT id, type, title, body, link, read_at, created_at
    FROM notifications ${where}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
  return rows.map(hydrate);
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

function markRead(userId, id) {
  const info = db.prepare(`
    UPDATE notifications SET read_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND read_at IS NULL
  `).run(id, userId);
  return { updated: info.changes };
}

function markAllRead(userId) {
  const info = db.prepare(`
    UPDATE notifications SET read_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND read_at IS NULL
  `).run(userId);
  return { updated: info.changes };
}

function remove(userId, id) {
  const info = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(id, userId);
  return { deleted: info.changes };
}

function hydrate(r) {
  return {
    id: r.id, type: r.type, title: r.title, body: r.body, link: r.link,
    readAt: r.read_at, createdAt: r.created_at,
  };
}

module.exports = { create, listForUser, unreadCount, markRead, markAllRead, remove };
