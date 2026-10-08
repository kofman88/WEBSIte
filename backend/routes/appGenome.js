/**
 * /api/app/genome* — the Mini App genome routes (miniapp_api.py h_genome / h_genome_apply) and
 * the user-triggered evolution (decision D10, the bot's adv_g_ev_<S>_<tf> → trigger_evolution_now).
 * Mounted by routes/app.js under its auth + POST rate-limit middleware (bucket "post", 30/60 s).
 *
 *   GET  /api/app/genome          {ok, available: can("genome"), auto_apply, strategies: {S: {timeframe,
 *                                  generation, fitness, win_rate, profit_factor, updated_at, applied}}}
 *                                  → {ok:false, error:"genome_unavailable"} on failure
 *   POST /api/app/genome/apply    {strategy} → pro_required | bad_strategy (400) |
 *                                  {ok:false, error:"genome_not_ready", message} | {ok:true}
 *                                  (+ kv miniapp_genome_applied_<uid>_<S> = last generation)
 *   POST /api/app/genome/evolve   {strategy, tf?, wait?} (Pro) → the evolution lock throttle
 *                                  ("Эволюция уже идёт, подожди 1-3 мин"); default: started in the
 *                                  genome worker, the bot's status text is delivered as a `genome`
 *                                  notification when it finishes; `wait: true` → awaits and answers
 *                                  {ok, …result, text}.
 */

'use strict';

const express = require('express');
const ts = require('../services/traderSettingsService');
const kv = require('../services/engineKvService');
const C = require('../services/genome/config');
const store = require('../services/genome/store');
const apply = require('../services/genome/apply');
const texts = require('../services/genome/texts');
const runner = require('../services/genome/runner');
const { pyRound } = require('../strategies/common/pyround');
const logger = require('../utils/logger');

const router = express.Router();
const STRATS = C.STRATEGIES;

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
// Python str(v).upper(): only a real string can ever name a strategy
const upper = (v) => (typeof v === 'string' ? v.toUpperCase() : '');

function loadUser(req) {
  const user = ts.getOrCreate(req.userId);
  return { user, opts: { admin: Boolean(req.isAdmin) } };
}

function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

// ── GET genome (h_genome) ────────────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const out = {};
  try {
    for (const s of STRATS) {
      const tf = C.getDefaultTf(s);
      const hist = store.getHistory(s, tf, 1);
      const last = hist.length ? hist[hist.length - 1] : null;
      const applied = kv.get(`miniapp_genome_applied_${user.user_id}_${s}`);
      out[s] = {
        timeframe: tf,
        generation: last ? Math.trunc(Number(last.generation)) : null,
        fitness: last ? pyRound(Number(last.best_fitness || 0), 3) : null,
        win_rate: last ? pyRound(Number(last.best_wr || 0), 1) : null,
        profit_factor: last ? pyRound(Number(last.best_pf || 0), 2) : null,
        updated_at: last ? Math.trunc(Number(last.created_at || 0)) : null,
        applied: Boolean(last && applied && String(applied) === String(last.generation)),
      };
    }
  } catch (e) {
    logger.warn(`[MINIAPP] genome status: ${e.message}`);
    return res.json({ ok: false, error: 'genome_unavailable' });
  }
  res.json({
    ok: true,
    available: Boolean(ts.can(user, 'genome', opts)),
    auto_apply: Boolean(user.genome_auto_apply),
    strategies: out,
  });
}));

// ── POST genome/apply {strategy} (h_genome_apply) ────────────────────────
router.post('/apply', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  if (!ts.can(user, 'genome', opts)) return res.json({ ok: false, error: 'pro_required' });
  const s = upper(body(req).strategy);
  if (!STRATS.includes(s)) return res.status(400).json({ ok: false, error: 'bad_strategy' });
  const r = apply.applyBestToUser(user.user_id, s);
  if (!r.ok) return res.json({ ok: false, error: 'genome_not_ready', message: String(r.error === undefined || r.error === null ? '' : r.error) });
  try {
    const tf = C.getDefaultTf(s);
    kv.set(`miniapp_genome_applied_${user.user_id}_${s}`, String(store.getLastGeneration(s, tf)));
  } catch (e) {
    logger.debug(`[MINIAPP] genome applied mark: ${e.message}`);
  }
  logger.info(`[MINIAPP] genome applied uid=${user.user_id} ${s}`);
  res.json({ ok: true });
}));

// ── POST genome/evolve {strategy, tf?, wait?} (D10: adv_g_ev_<S>_<tf>) ──
async function notifyResult(userId, text) {
  try {
    const notifier = require('../services/notifier');
    const [title, ...rest] = String(text).split('\n');
    await notifier.dispatch(userId, { type: 'genome', title, body: rest.join('\n') || null, tgText: text });
  } catch (e) {
    logger.debug(`[MINIAPP] genome evolve notify: ${e.message}`);
  }
}

router.post('/evolve', wrap(async (req, res) => {
  const { user, opts } = loadUser(req);
  if (!ts.can(user, 'genome', opts)) return res.json({ ok: false, error: 'pro_required' });
  const b = body(req);
  const s = upper(b.strategy);
  if (!STRATS.includes(s)) return res.status(400).json({ ok: false, error: 'bad_strategy' });
  let tf = typeof b.tf === 'string' ? b.tf : '';
  if (!C.getTfs(s).includes(tf)) tf = C.getDefaultTf(s);
  if (runner.isRunning()) return res.json({ ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' });
  logger.info(`[MINIAPP] genome evolve uid=${user.user_id} ${s}/${tf}`);
  const run = runner.triggerEvolution(s, tf);
  if (b.wait === true) {
    const result = await run;
    const text = texts.evolveStatusText(result, s, tf);
    return res.json({ ...result, ok: Boolean(result.ok), text });
  }
  run.then((result) => notifyResult(user.user_id, texts.evolveStatusText(result, s, tf)))
    .catch((e) => logger.warn(`[MINIAPP] genome evolve: ${e.message}`));
  res.json({ ok: true, started: true, strategy: s, timeframe: tf, message: texts.EVOLVE_STARTED });
}));

module.exports = router;
