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

function reply(ticketId, { userId, body, isAdmin = false, isInternal = false, attachments = null }) {
  if (!body) { const e = new Error('body required'); e.statusCode = 400; throw e; }
  // Internal notes are an admin-only concept — silently ignore the flag
  // from non-admin callers so a user can't leak admin-only messages.
  const internal = Boolean(isAdmin && isInternal);
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  if (!isAdmin && ticket.user_id !== userId) {
    const e = new Error('Not your ticket'); e.statusCode = 403; throw e;
  }

  const msgInfo = db.prepare(`
    INSERT INTO support_messages (ticket_id, author_id, is_admin, is_internal, body, attachments)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ticketId, userId, isAdmin ? 1 : 0, internal ? 1 : 0,
    String(body).slice(0, 10000),
    attachments ? JSON.stringify(attachments).slice(0, 4000) : null,
  );

  // Internal notes don't reopen the ticket and don't bump updated_at —
  // user doesn't see them, shouldn't change "last activity" for them.
  if (!internal) {
    const newStatus = ticket.status === 'closed' ? 'open' : ticket.status;
    db.prepare('UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newStatus, ticketId);
  }

  // Notify the user only for non-internal admin replies
  try {
    const notifier = require('./notifier');
    if (isAdmin && !internal) {
      notifier.dispatch(ticket.user_id, {
        type: 'security',
        title: '💬 Ответ на ваш тикет #' + ticketId,
        body: String(body).slice(0, 200),
        link: '/settings.html',
      });
    }
  } catch (_e) {}

  // WS push — internal notes go only to admins, public messages to both sides
  _broadcastMessage(ticketId, {
    id: msgInfo.lastInsertRowid,
    authorId: userId,
    isAdmin: Boolean(isAdmin),
    isInternal: internal,
    body: String(body).slice(0, 10000),
    attachments: attachments || null,
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
    // Internal notes — admins only. Public messages — both sides.
    if (!msg.isInternal && msg.userId) ws.broadcastToUser(msg.userId, payload);
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

// ── Assignment ────────────────────────────────────────────────────────
// When an agent "takes" a ticket, we stamp assigned_to + broadcast so
// other agents see it's claimed in their inbox.
function assign(ticketId, adminId, { targetAdminId = null } = {}) {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  const assignee = targetAdminId || adminId;
  db.prepare('UPDATE support_tickets SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(assignee, ticketId);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'support.assign', 'support_ticket', ?, ?)
  `).run(adminId, ticketId, JSON.stringify({ assignedTo: assignee }));
  _broadcastAssign(ticketId, assignee);
  return { assignedTo: assignee };
}
function unassign(ticketId, adminId) {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
  if (!ticket) { const e = new Error('Ticket not found'); e.statusCode = 404; throw e; }
  db.prepare('UPDATE support_tickets SET assigned_to = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticketId);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'support.unassign', 'support_ticket', ?, '{}')
  `).run(adminId, ticketId);
  _broadcastAssign(ticketId, null);
  return { assignedTo: null };
}
function _broadcastAssign(ticketId, assignedTo) {
  try {
    const ws = require('./websocketService');
    const payload = {
      type: 'support.assignment_changed',
      data: { ticketId, assignedTo },
      ts: Date.now(),
    };
    for (const adminId of _allAdminIds()) ws.broadcastToUser(adminId, payload);
  } catch (_) {}
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
  // Non-admins never see is_internal=1 rows (agent-to-agent notes).
  const internalClause = isAdmin ? '' : ' AND is_internal = 0';
  const messages = db.prepare(`
    SELECT id, author_id, is_admin, is_internal, body, attachments, created_at
    FROM support_messages WHERE ticket_id = ? ${internalClause}
    ORDER BY created_at ASC
  `).all(ticketId);
  // Enrich with assignee info for the ops drawer
  let assignedToEmail = null;
  if (ticket.assigned_to) {
    try {
      const a = db.prepare('SELECT email FROM users WHERE id = ?').get(ticket.assigned_to);
      if (a) assignedToEmail = a.email;
    } catch (_) {}
  }
  return {
    ...hydrate(ticket),
    assignedToEmail,
    messages: messages.map((m) => ({
      id: m.id, authorId: m.author_id,
      isAdmin: Boolean(m.is_admin),
      isInternal: Boolean(m.is_internal),
      body: m.body,
      attachments: (() => { try { return m.attachments ? JSON.parse(m.attachments) : null; } catch { return null; } })(),
      createdAt: m.created_at,
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
  const rows = db.prepare(`
    SELECT t.*, u.email AS user_email,
      asg.email AS assigned_to_email,
      (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS msg_count,
      (SELECT COUNT(*) FROM support_messages m
        WHERE m.ticket_id = t.id
          AND m.is_admin = 0
          AND (t.admin_read_at IS NULL OR m.created_at > t.admin_read_at)) AS unread_count,
      (SELECT body FROM support_messages m
        WHERE m.ticket_id = t.id AND m.is_internal = 0
        ORDER BY m.created_at DESC LIMIT 1) AS last_body,
      (SELECT is_admin FROM support_messages m
        WHERE m.ticket_id = t.id AND m.is_internal = 0
        ORDER BY m.created_at DESC LIMIT 1) AS last_is_admin,
      (SELECT created_at FROM support_messages m
        WHERE m.ticket_id = t.id AND m.is_admin = 0 AND m.is_internal = 0
        ORDER BY m.created_at DESC LIMIT 1) AS last_user_at
    FROM support_tickets t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN users asg ON asg.id = t.assigned_to
    ${clause}
    ORDER BY
      CASE t.status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const now = Date.now();
  return rows.map((r) => {
    // SLA level based on how long the last UNANSWERED user message has
    // been sitting. If the last activity on the ticket was admin's,
    // SLA is "idle" (waiting on user). Level 0=fresh, 1=warn >3min,
    // 2=urgent >15min, 3=overdue >60min.
    let slaLevel = 0;
    if (r.last_user_at && r.last_is_admin === 0) {
      const ageMs = now - new Date(r.last_user_at).getTime();
      if (ageMs > 60 * 60_000) slaLevel = 3;
      else if (ageMs > 15 * 60_000) slaLevel = 2;
      else if (ageMs > 3 * 60_000) slaLevel = 1;
    }
    return {
      ...hydrateList(r),
      userEmail: r.user_email,
      assignedToEmail: r.assigned_to_email || null,
      unreadCount: r.unread_count || 0,
      lastBody: r.last_body || '',
      lastFromAdmin: Boolean(r.last_is_admin),
      slaLevel,
    };
  });
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
  assign, unassign,
};
