/**
 * Strategy marketplace MVP.
 *
 * Authors publish a bot configuration (strategy + timeframe + direction +
 * config + risk) under a unique slug. Other users browse, pick one, and
 * "install" — the handler clones the config into a new paper bot on
 * their account, increments install count, and records the relationship
 * so they can rate it later.
 *
 * Security properties:
 *   • Only author or admin can edit/delete
 *   • Only paying plans can publish (prevents spam)
 *   • Installs are paper-only by default (live mirror stubbed out)
 *   • Ratings are 1–5, one per user per strategy
 */

const db = require('../models/database');
const plans = require('../config/plans');
const logger = require('../utils/logger');

function _slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/\s+/g, '-').slice(0, 64);
}

function _hydrate(r) {
  if (!r) return null;
  return {
    id: r.id, authorId: r.author_id, authorEmail: r.author_email, slug: r.slug,
    title: r.title, description: r.description, strategy: r.strategy,
    timeframe: r.timeframe, direction: r.direction,
    config: (() => { try { return JSON.parse(r.config_json || '{}'); } catch { return {}; } })(),
    risk:   (() => { try { return JSON.parse(r.risk_json || '{}'); } catch { return {}; } })(),
    installs: r.installs || 0,
    rating: r.rating_cnt ? Math.round((r.rating_sum / r.rating_cnt) * 100) / 100 : null,
    ratingCount: r.rating_cnt || 0,
    isPublic: Boolean(r.is_public),
    priceUsd: Number(r.price_usd) || 0,
    platformFeePct: Number(r.platform_fee_pct) || 20,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function publish(authorId, { title, description = '', strategy, timeframe = '1h', direction = 'both', config = {}, risk = {}, priceUsd = 0 } = {}) {
  if (!title || title.length < 3) { const e = new Error('title ≥3'); e.statusCode = 400; throw e; }
  if (!strategy) { const e = new Error('strategy is required'); e.statusCode = 400; throw e; }
  // Clamp price to sane range — prevents typos like $99999 in the UI.
  const price = Math.max(0, Math.min(500, Number(priceUsd) || 0));
  // Plan gate: marketplacePublish flag — Starter+ per inventory.
  const planRow = db.prepare(`SELECT plan FROM subscriptions WHERE user_id = ?`).get(authorId);
  const userPlan = (planRow && planRow.plan) || 'free';
  if (!plans.canUseFeature(userPlan, 'marketplacePublish')) {
    const e = new Error('Publishing strategies requires Starter plan or higher.');
    e.statusCode = 403; e.code = 'UPGRADE_REQUIRED';
    e.requiredPlan = plans.requiredPlanFor('marketplacePublish') || 'starter';
    throw e;
  }
  const baseSlug = _slugify(title) || ('strategy-' + Date.now());
  let slug = baseSlug;
  for (let i = 1; db.prepare(`SELECT 1 FROM published_strategies WHERE slug = ?`).get(slug); i += 1) {
    slug = baseSlug + '-' + i;
  }
  const info = db.prepare(`
    INSERT INTO published_strategies
      (author_id, slug, title, description, strategy, timeframe, direction, config_json, risk_json, price_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(authorId, slug, title, description, strategy, timeframe, direction,
    JSON.stringify(config), JSON.stringify(risk), price);
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'strategy.publish', 'strategy', ?, ?)
  `).run(authorId, info.lastInsertRowid, JSON.stringify({ slug, title }));
  logger.info('strategy published', { authorId, slug, id: info.lastInsertRowid });
  return get(slug);
}

function list({ search = null, limit = 50, offset = 0 } = {}) {
  const parts = ['s.is_public = 1'];
  const params = [];
  if (search) { parts.push('(s.title LIKE ? OR s.description LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }
  const where = 'WHERE ' + parts.join(' AND ');
  return db.prepare(`
    SELECT s.*, u.email AS author_email
    FROM published_strategies s LEFT JOIN users u ON u.id = s.author_id
    ${where}
    ORDER BY s.installs DESC, s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map(_hydrate);
}

function get(slug) {
  return _hydrate(db.prepare(`
    SELECT s.*, u.email AS author_email
    FROM published_strategies s LEFT JOIN users u ON u.id = s.author_id
    WHERE s.slug = ? AND s.is_public = 1
  `).get(slug));
}

function install(userId, slug, { name = null, symbols = ['BTCUSDT'], tradingMode = 'paper' } = {}) {
  if (tradingMode === 'live') { const e = new Error('Live install is coming soon — use paper'); e.statusCode = 400; throw e; }
  const st = db.prepare(`SELECT * FROM published_strategies WHERE slug = ? AND is_public = 1`).get(slug);
  if (!st) { const e = new Error('Strategy not found'); e.statusCode = 404; throw e; }
  if (st.author_id === userId) { const e = new Error('Cannot install your own strategy'); e.statusCode = 400; throw e; }

  // Paid strategies require Stripe checkout. Wiring is not yet in place —
  // return a 402 with code PAYMENT_REQUIRED so the frontend can show a
  // "покупка скоро" hint. Free (price=0) installs flow through unchanged.
  if (Number(st.price_usd || 0) > 0) {
    const alreadyOwn = db.prepare(`
      SELECT 1 FROM strategy_installs WHERE user_id = ? AND strategy_id = ? AND price_paid_usd > 0
    `).get(userId, st.id);
    if (!alreadyOwn) {
      const e = new Error('Paid strategies are in private beta — purchase coming soon');
      e.statusCode = 402; e.code = 'PAYMENT_REQUIRED'; throw e;
    }
  }

  const botName = name || st.title.slice(0, 48);
  const tx = db.transaction(() => {
    const bot = db.prepare(`
      INSERT INTO trading_bots (user_id, name, exchange, symbols, strategy, timeframe,
        direction, leverage, risk_pct, max_open_trades, auto_trade, trading_mode,
        strategy_config, risk_config, is_active)
      VALUES (?, ?, 'bybit', ?, ?, ?, ?, 1, 1, 5, 1, ?, ?, ?, 0)
    `).run(
      userId, botName, JSON.stringify(symbols), st.strategy, st.timeframe, st.direction,
      tradingMode, st.config_json, st.risk_json,
    );
    db.prepare(`
      INSERT INTO strategy_installs (user_id, strategy_id, bot_id) VALUES (?, ?, ?)
      ON CONFLICT(user_id, strategy_id) DO UPDATE SET bot_id = excluded.bot_id
    `).run(userId, st.id, bot.lastInsertRowid);
    db.prepare(`UPDATE published_strategies SET installs = installs + 1 WHERE id = ?`).run(st.id);
    return bot.lastInsertRowid;
  });
  const botId = tx();
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'strategy.install', 'strategy', ?, ?)
  `).run(userId, st.id, JSON.stringify({ slug: st.slug, botId }));
  return { botId, strategy: st.slug };
}

function rate(userId, slug, stars) {
  if (stars < 1 || stars > 5) { const e = new Error('stars 1..5'); e.statusCode = 400; throw e; }
  const st = db.prepare(`SELECT id FROM published_strategies WHERE slug = ?`).get(slug);
  if (!st) { const e = new Error('Strategy not found'); e.statusCode = 404; throw e; }
  const existing = db.prepare(`SELECT rating FROM strategy_installs WHERE user_id = ? AND strategy_id = ?`).get(userId, st.id);
  if (!existing) { const e = new Error('Install the strategy first'); e.statusCode = 400; throw e; }
  const tx = db.transaction(() => {
    if (existing.rating) {
      db.prepare(`UPDATE published_strategies SET rating_sum = rating_sum - ? WHERE id = ?`).run(existing.rating, st.id);
    } else {
      db.prepare(`UPDATE published_strategies SET rating_cnt = rating_cnt + 1 WHERE id = ?`).run(st.id);
    }
    db.prepare(`UPDATE strategy_installs SET rating = ? WHERE user_id = ? AND strategy_id = ?`).run(stars, userId, st.id);
    db.prepare(`UPDATE published_strategies SET rating_sum = rating_sum + ? WHERE id = ?`).run(stars, st.id);
  });
  tx();
  return { ok: true };
}

function unpublish(userId, slug, { isAdmin = false } = {}) {
  const st = db.prepare(`SELECT * FROM published_strategies WHERE slug = ?`).get(slug);
  if (!st) { const e = new Error('Strategy not found'); e.statusCode = 404; throw e; }
  if (!isAdmin && st.author_id !== userId) { const e = new Error('Not your strategy'); e.statusCode = 403; throw e; }
  db.prepare(`UPDATE published_strategies SET is_public = 0 WHERE id = ?`).run(st.id);
  return { unpublished: true };
}

// Author earnings summary — used by Publisher dashboard (my-strategies tab).
// Returns per-strategy earned + pending + paid totals so authors can see
// what they're owed before the first Stripe payout flow lands.
function earnings(authorId) {
  const rows = db.prepare(`
    SELECT s.id, s.slug, s.title, s.price_usd, s.installs,
      COALESCE((SELECT SUM(amount_usd)       FROM strategy_earnings e WHERE e.strategy_id = s.id AND e.status = 'pending'), 0) AS pending_usd,
      COALESCE((SELECT SUM(amount_usd)       FROM strategy_earnings e WHERE e.strategy_id = s.id AND e.status = 'paid'),    0) AS paid_usd,
      COALESCE((SELECT SUM(platform_fee_usd) FROM strategy_earnings e WHERE e.strategy_id = s.id), 0) AS platform_fees_usd
    FROM published_strategies s
    WHERE s.author_id = ?
    ORDER BY s.created_at DESC
  `).all(authorId);
  const totals = rows.reduce((acc, r) => {
    acc.pending += r.pending_usd; acc.paid += r.paid_usd; acc.installs += r.installs;
    return acc;
  }, { pending: 0, paid: 0, installs: 0 });
  return { strategies: rows, totals };
}

module.exports = { publish, list, get, install, rate, unpublish, earnings };
