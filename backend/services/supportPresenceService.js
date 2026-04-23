/**
 * Agent presence — tracks which support agents are online.
 *
 * In-memory only (Map userId → lastPingAt). Ops panel pings every 30s
 * while the tab is active; we treat agents as "online" if last ping was
 * within 90s (allows one missed ping before going offline). Zero DB
 * writes to avoid hammering SQLite for a transient state.
 *
 * On Passenger cycling the map resets, which is fine — agents will
 * re-ping within 30s and the inbox updates.
 */
const db = require('../models/database');

const pings = new Map();           // userId → ms timestamp
const ONLINE_WINDOW_MS = 90_000;   // 90s: 30s ping × 3 strikes

function ping(userId) {
  pings.set(userId, Date.now());
}

function isOnline(userId) {
  const t = pings.get(userId);
  if (!t) return false;
  return Date.now() - t < ONLINE_WINDOW_MS;
}

// Returns [{ id, email }, …] of admins currently online. Excludes admins
// who have never pinged or whose last ping expired.
function listOnlineAgents() {
  const now = Date.now();
  const ids = [];
  for (const [uid, t] of pings.entries()) {
    if (now - t < ONLINE_WINDOW_MS) ids.push(uid);
  }
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, email FROM users WHERE id IN (${placeholders}) AND is_admin = 1
  `).all(...ids);
}

// Periodic cleanup so the map doesn't grow unbounded over weeks.
setInterval(() => {
  const cutoff = Date.now() - ONLINE_WINDOW_MS * 2;
  for (const [uid, t] of pings.entries()) if (t < cutoff) pings.delete(uid);
}, 5 * 60_000).unref();

module.exports = { ping, isOnline, listOnlineAgents };
