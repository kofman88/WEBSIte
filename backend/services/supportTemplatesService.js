/**
 * Canned-response templates for support agents. Short prewritten replies
 * that agents can insert into the drawer via a shortcut menu (/welcome,
 * /kyc, /refund, etc.).
 *
 * Seed defaults live in database.js migration; CRUD is admin-only.
 */
const db = require('../models/database');

function list() {
  return db.prepare(`
    SELECT id, slug, title, body, use_count, created_by, created_at, updated_at
    FROM support_templates
    ORDER BY use_count DESC, title ASC
  `).all();
}

function get(id) {
  return db.prepare(`SELECT * FROM support_templates WHERE id = ?`).get(id);
}

function create({ slug, title, body, createdBy = null }) {
  if (!slug || !title || !body) {
    const e = new Error('slug, title, body required'); e.statusCode = 400; throw e;
  }
  const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  const dupe = db.prepare('SELECT 1 FROM support_templates WHERE slug = ?').get(cleanSlug);
  if (dupe) { const e = new Error('Slug taken'); e.statusCode = 409; throw e; }
  const info = db.prepare(`
    INSERT INTO support_templates (slug, title, body, created_by)
    VALUES (?, ?, ?, ?)
  `).run(cleanSlug, String(title).slice(0, 100), String(body).slice(0, 4000), createdBy);
  return get(info.lastInsertRowid);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) { const e = new Error('Template not found'); e.statusCode = 404; throw e; }
  const title = patch.title != null ? String(patch.title).slice(0, 100) : existing.title;
  const body  = patch.body  != null ? String(patch.body).slice(0, 4000) : existing.body;
  db.prepare(`
    UPDATE support_templates SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, body, id);
  return get(id);
}

function remove(id) {
  const info = db.prepare('DELETE FROM support_templates WHERE id = ?').run(id);
  if (!info.changes) { const e = new Error('Template not found'); e.statusCode = 404; throw e; }
  return { removed: true };
}

function bumpUseCount(id) {
  try { db.prepare('UPDATE support_templates SET use_count = use_count + 1 WHERE id = ?').run(id); }
  catch (_) {}
}

module.exports = { list, get, create, update, remove, bumpUseCount };
