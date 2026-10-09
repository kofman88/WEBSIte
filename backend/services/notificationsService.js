/**
 * In-app notifications service — writes to notifications table and
 * (the bell icon polls /api/notifications; live push arrives with SSE in M10)
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

// ── buttons (M12b) ─────────────────────────────────────────────────────────
// The engine's keyboards come in two shapes: rows of {label, action, kind: 'url' | 'callback',
// api?} (services/engine/cards/keyboards.js, services/retention) and the flat [{text, url,
// action?}] of reports / the entry advisor. Stored is one shape — rows of
// {label, kind: 'url', url} | {label, kind: 'callback', action, api: {method, path}} — and only
// what the inbox may act on: a site path or an https link, and the callbacks that have a route
// of their own outside the trade buttons (those stay on the signal card, decision D16).
const INBOX_ROUTES = [/^engagement\/optout$/, /^entry-advice\/(?:on|keep)$/];
const MAX_BUTTONS = 8;
const MAX_LABEL = 64;

function safeUrl(u) {
  if (typeof u !== 'string' || !u || u.length > 512) return null;
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(u)) return u;
  // a page of the site: no API path, no dot segments (a link is a navigation, never a request)
  if (u.charAt(0) === '/' && u.charAt(1) !== '/' && !/[\s"'<>\\]/.test(u)
      && !/^\/api(?:\/|$)/i.test(u) && !/(?:^|\/)\.\.?(?:[/?#]|$)/.test(u.split(/[?#]/)[0] + '/')) return u;
  return null;
}

function apiRoute(api, url) {
  let path = null;
  if (api && typeof api === 'object' && typeof api.path === 'string') path = api.path;
  else if (typeof url === 'string' && url.startsWith('/api/app/')) path = url.slice('/api/app/'.length);
  if (path === null || !INBOX_ROUTES.some((re) => re.test(path))) return null;
  return { method: 'POST', path };
}

function normButton(b) {
  if (!b || typeof b !== 'object') return null;
  const label = String(b.label !== undefined ? b.label : (b.text !== undefined ? b.text : '')).slice(0, MAX_LABEL);
  if (!label) return null;
  const api = apiRoute(b.api, b.url);
  if (api) return { label, kind: 'callback', action: typeof b.action === 'string' ? b.action.slice(0, 128) : '', api };
  // a link: {kind: 'url', action} of the engine rows, {kind: 'url', url} as stored, {text, url} flat
  let target = null;
  if (b.kind === 'url') target = typeof b.url === 'string' ? b.url : b.action;
  else if (b.kind === undefined && b.action === undefined) target = b.url;
  const url = safeUrl(target);
  return url ? { label, kind: 'url', url } : null;
}

/** The buttons of a notification as stored rows, or null when none is usable. */
function normalizeActions(actions) {
  if (!Array.isArray(actions)) return null;
  const rows = [];
  let n = 0;
  for (const r of actions) {
    const row = [];
    for (const b of (Array.isArray(r) ? r : [r])) {
      if (n >= MAX_BUTTONS) break;
      const nb = normButton(b);
      if (nb) { row.push(nb); n += 1; }
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? rows : null;
}

function create(userId, { type, title, body = null, link = null, actions = null }) {
  if (!userId || !type || !title) throw new Error('notifications.create: missing userId/type/title');
  const rows = normalizeActions(actions);
  const info = db.prepare(`
    INSERT INTO notifications (user_id, type, title, body, link, actions)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, body, link, rows ? JSON.stringify(rows) : null);

  return info.lastInsertRowid;
}

function listForUser(userId, { limit = 50, offset = 0, unreadOnly = false } = {}) {
  const where = unreadOnly ? 'WHERE user_id = ? AND read_at IS NULL' : 'WHERE user_id = ?';
  const rows = db.prepare(`
    SELECT id, type, title, body, link, actions, read_at, created_at
    FROM notifications ${where}
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
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

/** The buttons are gone after a press that removes the keyboard (reply_markup=None in the bot). */
function clearActions(userId, id) {
  const info = db.prepare('UPDATE notifications SET actions = NULL WHERE id = ? AND user_id = ?').run(id, userId);
  return { updated: info.changes };
}

function remove(userId, id) {
  const info = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(id, userId);
  return { deleted: info.changes };
}

function parseActions(raw) {
  if (!raw) return null;
  try {
    return normalizeActions(JSON.parse(raw));
  } catch (_e) {
    return null;
  }
}

function hydrate(r) {
  return {
    id: r.id, type: r.type, title: r.title, body: r.body, link: r.link,
    actions: parseActions(r.actions), readAt: r.read_at, createdAt: r.created_at,
  };
}

module.exports = { create, listForUser, unreadCount, markRead, markAllRead, remove, clearActions, normalizeActions, INBOX_ROUTES };
