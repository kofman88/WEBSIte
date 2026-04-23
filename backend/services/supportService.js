/**
 * Support tickets — lightweight ticketing: user opens a ticket, admin sees
 * it in the admin panel, both can reply. In-app notifications fire when
 * admin replies. Email notification is optional (respects user's
 * notification_prefs.email.security — tickets are treated like security
 * since they're rare + important).
 */

const db = require('../models/database');
const logger = require('../utils/logger');

function create(userId, { subject, body }) {
  if (!subject || !body) { const e = new Error('subject and body are required'); e.statusCode = 400; throw e; }
  const info = db.prepare(`
    INSERT INTO support_tickets (user_id, subject, body, status, priority)
    VALUES (?, ?, ?, 'open', 'normal')
  `).run(userId, String(subject).slice(0, 200), String(body).slice(0, 10000));
  const msgInfo = db.prepare(`
    INSERT INTO support_messages (ticket_id, author_id, is_admin, body)
    VALUES (?, ?, 0, ?)
  `).run(info.lastInsertRowid, userId, String(body).slice(0, 10000));

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'support.ticket.create', 'support_ticket', ?, ?)
  `).run(userId, info.lastInsertRowid, JSON.stringify({ subject }));

  logger.info('support ticket created', { userId, ticketId: info.lastInsertRowid });
  const ticket = getForUser(info.lastInsertRowid, userId);
  _broadcastNew(ticket, { userId, isAdmin: false, messageId: msgInfo.lastInsertRowid });
  return ticket;
}

function reply(ticketId, { userId, body, isAdmin = false }) {
  if (!body) { const e = new Error('body required'); e.statusCode = 400; throw e; }
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  // If not admin, must own the ticket
  if (!isAdmin && ticket.user_id !== userId) {
    const e = new Error('Not your ticket'); e.statusCode = 403; throw e;
  }

  const msgInfo = db.prepare(`
    INSERT INTO support_messages (ticket_id, author_id, is_admin, body)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, userId, isAdmin ? 1 : 0, String(body).slice(0, 10000));

  // Reopen the ticket if a new message came in and it was closed
  const newStatus = ticket.status === 'closed' ? 'open' : ticket.status;
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, ticketId);

  // Notify the other party via in-app + email (existing behavior)
  try {
    const notifier = require('./notifier');
    if (isAdmin) {
      notifier.dispatch(ticket.user_id, {
        type: 'security',
        title: '💬 Ответ на ваш тикет #' + ticketId,
        body: String(body).slice(0, 200),
        link: '/settings.html',
      });
    }
  } catch (_e) {}

  // Real-time WS push — user widget + ops inbox get the message live
  _broadcastMessage(ticketId, {
    id: msgInfo.lastInsertRowid,
    authorId: userId,
    isAdmin: Boolean(isAdmin),
    body: String(body).slice(0, 10000),
    userId: ticket.user_id,
  });

  return getForUser(ticketId, userId, isAdmin);
}

// ── WebSocket broadcast helpers ──────────────────────────────────────────
// Deliver live updates so user widget + ops inbox refresh without a page
// reload. Each event targets the ticket owner (always) and every admin
// whose socket is connected (discovered via users.is_admin=1).
function _allAdminIds() {
  try {
    return db.prepare('SELECT id FROM users WHERE is_admin = 1').all().map((r) => r.id);
  } catch { return []; }
}
function _broadcastMessage(ticketId, msg) {
  try {
    const ws = require('./websocketService');
    const payload = {
      type: 'support.message_added',
      data: { ticketId, message: msg },
      ts: Date.now(),
    };
    if (msg.userId) ws.broadcastToUser(msg.userId, payload);
    for (const adminId of _allAdminIds()) {
      if (adminId !== msg.userId) ws.broadcastToUser(adminId, payload);
    }
  } catch (e) { logger.warn('support WS broadcast failed', { err: e.message }); }
}
function _broadcastNew(ticket, ctx) {
  try {
    const ws = require('./websocketService');
    const payload = {
      type: 'support.ticket_created',
      data: { ticket, from: ctx },
      ts: Date.now(),
    };
    for (const adminId of _allAdminIds()) ws.broadcastToUser(adminId, payload);
  } catch (e) { logger.warn('support WS ticket broadcast failed', { err: e.message }); }
}

// Mark-read: records a timestamp on support_tickets so inbox can compute
// unread counts. User marks read by opening the thread; admin marks read
// by opening the drawer in ops.
function markReadByUser(ticketId, userId) {
  const ticket = db.prepare('SELECT user_id FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  if (ticket.user_id !== userId) { const e = new Error('Not your ticket'); e.statusCode = 403; throw e; }
  db.prepare('UPDATE support_tickets SET user_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticketId);
  return { ok: true };
}
function markReadByAdmin(ticketId) {
  db.prepare('UPDATE support_tickets SET admin_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticketId);
  return { ok: true };
}

function listForUser(userId, { status = null, limit = 50, offset = 0 } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (status) { where.push('status = ?'); params.push(status); }
  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS msg_count,
      (SELECT COUNT(*) FROM support_messages m
        WHERE m.ticket_id = t.id
          AND m.is_admin = 1
          AND (t.user_read_at IS NULL OR m.created_at > t.user_read_at)) AS unread_count
    FROM support_tickets t
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return rows.map((r) => ({ ...hydrateList(r), unreadCount: r.unread_count || 0 }));
}

function getForUser(ticketId, userId, isAdmin = false) {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  if (!isAdmin && ticket.user_id !== userId) {
    const e = new Error('Not your ticket'); e.statusCode = 403; throw e;
  }
  const messages = db.prepare(`
    SELECT id, author_id, is_admin, body, created_at
    FROM support_messages WHERE ticket_id = ?
    ORDER BY created_at ASC
  `).all(ticketId);
  return {
    ...hydrate(ticket),
    messages: messages.map((m) => ({
      id: m.id, authorId: m.author_id, isAdmin: Boolean(m.is_admin),
      body: m.body, createdAt: m.created_at,
    })),
  };
}

function closeTicket(ticketId, { userId, isAdmin = false }) {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  if (!isAdmin && ticket.user_id !== userId) {
    const e = new Error('Not your ticket'); e.statusCode = 403; throw e;
  }
  db.prepare(`
    UPDATE support_tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(ticketId);
  return { closed: true };
}

// Admin-only
function listAll({ status = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('t.status = ?'); params.push(status); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // unread_count = user messages posted after the admin last read (or
  // ever, if never read). Admin-authored messages never count as unread
  // for admins.
  return db.prepare(`
    SELECT t.*, u.email AS user_email,
      (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS msg_count,
      (SELECT COUNT(*) FROM support_messages m
        WHERE m.ticket_id = t.id
          AND m.is_admin = 0
          AND (t.admin_read_at IS NULL OR m.created_at > t.admin_read_at)) AS unread_count,
      (SELECT body FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
      (SELECT is_admin FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_is_admin
    FROM support_tickets t JOIN users u ON u.id = t.user_id
    ${clause}
    ORDER BY
      CASE t.status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map((r) => ({
    ...hydrateList(r),
    userEmail: r.user_email,
    unreadCount: r.unread_count || 0,
    lastBody: r.last_body || '',
    lastFromAdmin: Boolean(r.last_is_admin),
  }));
}

function hydrate(r) {
  return {
    id: r.id, userId: r.user_id, subject: r.subject, body: r.body,
    status: r.status, priority: r.priority, assignedTo: r.assigned_to,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
  };
}
function hydrateList(r) {
  return { ...hydrate(r), messageCount: r.msg_count || 0 };
}

// ── Guest (unauthenticated) one-shot messages from the support widget.
// Reply is out-of-band (email), not back through the widget.
function guestContact({ email, body, ip = null, userAgent = null }) {
  const e = String(email || '').trim().toLowerCase();
  const b = String(body || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) {
    const err = new Error('Valid email required'); err.statusCode = 400; throw err;
  }
  if (b.length < 5 || b.length > 10000) {
    const err = new Error('Message must be 5–10 000 chars'); err.statusCode = 400; throw err;
  }
  const info = db.prepare(`
    INSERT INTO support_guest_messages (email, body, ip, user_agent) VALUES (?, ?, ?, ?)
  `).run(e, b, ip, userAgent);
  logger.info('support guest message', { id: info.lastInsertRowid, email: e });
  return { id: info.lastInsertRowid, status: 'received' };
}

module.exports = {
  create, reply, listForUser, getForUser, closeTicket, listAll,
  guestContact, markReadByUser, markReadByAdmin,
};
