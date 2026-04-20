/**
 * Feature flags — simple key/value store on top of system_kv.
 *
 * Defaults live in DEFAULTS below. Overrides are stored in system_kv under
 * the "ff:<key>" prefix. Values are strings ("on"/"off") at the wire level
 * but the is()/set()/get() helpers convert to booleans and cache in memory.
 *
 * Cache is refreshed every 30s and on setFlag() — so a flip in /ops
 * propagates site-wide within half a minute, no deploy required.
 *
 *   if (featureFlags.is('maintenance')) return res.status(503).json(...);
 *   if (featureFlags.is('signup_disabled')) ...;
 *
 * Anything listed here is discoverable in the /ops System → Flags panel.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

// Add new flags here — the UI auto-lists anything with a default.
const DEFAULTS = {
  maintenance:        { value: false, desc: 'Maintenance mode — API returns 503 on mutating endpoints' },
  signup_disabled:    { value: false, desc: 'Stop new registrations (for incident response)' },
  live_trading:       { value: true,  desc: 'Allow live-mode bots; off forces paper only' },
  new_pricing_page:   { value: false, desc: 'Show new /pricing variant to visitors' },
  email_notifications: { value: true,  desc: 'Master switch for outbound emails' },
  telegram_notifications: { value: true, desc: 'Master switch for Telegram outbound' },
  public_leaderboard: { value: true,  desc: 'Render /leaderboard.html publicly' },
};

const CACHE_TTL_MS = 30_000;
let _cache = null;
let _cacheAt = 0;

function _load() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = DEFAULTS[key].value;
  try {
    const rows = db.prepare("SELECT key, value FROM system_kv WHERE key LIKE 'ff:%'").all();
    for (const r of rows) {
      const k = r.key.slice(3);
      if (k in out) out[k] = r.value === 'on';
    }
  } catch (e) { logger.warn('feature flags load failed', { err: e.message }); }
  return out;
}

function _refresh() {
  _cache = _load();
  _cacheAt = Date.now();
  return _cache;
}

function all() {
  if (!_cache || Date.now() - _cacheAt > CACHE_TTL_MS) _refresh();
  return Object.keys(DEFAULTS).map((key) => ({
    key,
    value: _cache[key],
    defaultValue: DEFAULTS[key].value,
    overridden: _cache[key] !== DEFAULTS[key].value,
    description: DEFAULTS[key].desc,
  }));
}

function is(key) {
  if (!(key in DEFAULTS)) return false;
  if (!_cache || Date.now() - _cacheAt > CACHE_TTL_MS) _refresh();
  return Boolean(_cache[key]);
}

function setFlag(key, value, { adminId = null } = {}) {
  if (!(key in DEFAULTS)) { const e = new Error('Unknown feature flag: ' + key); e.statusCode = 400; throw e; }
  const v = Boolean(value);
  db.prepare(`INSERT INTO system_kv (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run('ff:' + key, v ? 'on' : 'off');
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'admin.flag.set', 'feature_flag', NULL, ?)
  `).run(adminId, JSON.stringify({ key, value: v }));
  _refresh();
  logger.info('feature flag changed', { key, value: v, adminId });
  return { key, value: v };
}

// Express middleware — fails requests with 503 when maintenance is on.
// Attach on mutating routes only; reads stay accessible so users can see
// status + read-only data (analytics, leaderboard, support).
function maintenanceGuard(req, res, next) {
  if (!is('maintenance')) return next();
  // Allow admins through so they can turn it off.
  if (req.isAdmin) return next();
  return res.status(503).json({
    error: 'Service temporarily in maintenance',
    code: 'MAINTENANCE',
  });
}

module.exports = { all, is, setFlag, maintenanceGuard, DEFAULTS };
