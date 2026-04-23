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
  db.prepare(`
    INSERT INTO support_messages (ticket_id, author_id, is_admin, body)
    VALUES (?, ?, 0, ?)
  `).run(info.lastInsertRowid, userId, String(body).slice(0, 10000));

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'support.ticket.create', 'support_ticket', ?, ?)
  `).run(userId, info.lastInsertRowid, JSON.stringify({ subject }));

  logger.info('support ticket created', { userId, ticketId: info.lastInsertRowid });
  return getForUser(info.lastInsertRowid, userId);
}

function reply(ticketId, { userId, body, isAdmin = false }) {
  if (!body) { const e = new Error('body required'); e.statusCode = 400; throw e; }
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  // If not admin, must own the ticket
  if (!isAdmin && ticket.user_id !== userId) {
    const e = new Error('Not your ticket'); e.statusCode = 403; throw e;
  }

  db.prepare(`
    INSERT INTO support_messages (ticket_id, author_id, is_admin, body)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, userId, isAdmin ? 1 : 0, String(body).slice(0, 10000));

  // Reopen the ticket if a new message came in and it was closed
  const newStatus = ticket.status === 'closed' ? 'open' : ticket.status;
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, ticketId);

  // Notify the other party
  try {
    const notifier = require('./notifier');
    if (isAdmin) {
      // Admin wrote → notify user
      notifier.dispatch(ticket.user_id, {
        type: 'security',
        title: '💬 Ответ на ваш тикет #' + ticketId,
        body: String(body).slice(0, 200),
        link: '/settings.html',
      });
    }
  } catch (_e) {}

  return getForUser(ticketId, userId, isAdmin);
}

function listForUser(userId, { status = null, limit = 50, offset = 0 } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (status) { where.push('status = ?'); params.push(status); }
  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS msg_count
    FROM support_tickets t
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return rows.map(hydrateList);
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
  return db.prepare(`
    SELECT t.*, u.email AS user_email,
      (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS msg_count
    FROM support_tickets t JOIN users u ON u.id = t.user_id
    ${clause}
    ORDER BY
      CASE t.status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map((r) => ({ ...hydrateList(r), userEmail: r.user_email }));
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
  guestContact,
};
