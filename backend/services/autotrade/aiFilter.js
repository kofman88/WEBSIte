'use strict';
/**
 * aiFilter.js — port of ai_filter.py ([AI-FILTER]): the three tier-gated AI layers the auto-trade
 * flow evaluates right before placement. Since [AI-NO-BLOCK Phase 2] the verdict is information
 * only (execute_auto_trade never blocks on it).
 *
 *   evaluateSignal(signal, user, context) → {passed, layers, confidence_score, blocking_layers,
 *       user_required_count, user_passed_count, preset_name}
 *     AI_FILTER_ENABLED != '1' → passed, no layers; a layer is active when user.can("ai_layer_<n>")
 *     and user.ai_filter_settings[<n>]; layers run concurrently, a layer exception → NEUTRAL 0.5.
 *   calculateWeightedConfidence(layers)
 *   buildAiButtonKb(result, userPlan, tradeId)   handlers/ai_insights.build_ai_button_kb (as an
 *       action keyboard: [[{id, label, action, kind}]]), null without layers
 *
 * Layers: market_regime (cached BTC regime), news_monitor (the site runs the bot's
 * NEWS_PROVIDER=none configuration — the news feed is not ported — unless `newsCheck` is
 * injected), genome_engine (services/genome/store.getLastMutationInfo).
 */

const { pyRound } = require('../../strategies/common/pyround');
const { fmtFixed } = require('../../strategies/common/pyfmt');
const { PLAN_FEATURES, normalizePlan } = require('../../config/planFeatures');
const { pf } = require('./pyfmt');

const AGREE = '✅';
const NEUTRAL = '⬜';
const AGAINST = '❌';

const LAYER_WEIGHTS = Object.freeze({ market_regime: 0.25, news_monitor: 0.15, genome_engine: 0.10 });
const AI_LAYERS = Object.freeze([
  ['market_regime', 'pro', '📊', 'Market Regime'],
  ['news_monitor', 'pro', '📰', 'News Monitor'],
  ['genome_engine', 'pro', '🧬', 'Genome Engine'],
]);

const layer = (name, verdict, confidence, reason, data = {}) => ({
  layer_name: name, verdict, confidence, reason, data, available_at_tier: 'pro',
});

function calculateWeightedConfidence(layers) {
  if (!layers || !layers.length) return 0.0;
  let total = 0.0;
  let score = 0.0;
  for (const r of layers) {
    const w = Object.prototype.hasOwnProperty.call(LAYER_WEIGHTS, r.layer_name) ? LAYER_WEIGHTS[r.layer_name] : 0.10;
    total += w;
    if (r.verdict === AGREE) score += w * Number(r.confidence === undefined ? 0.5 : r.confidence);
    else if (r.verdict === NEUTRAL) score += w * 0.5;
  }
  return total > 0 ? pyRound(score / total, 3) : 0.0;
}

function createAiFilter({
  getCachedRegime = null, regimeAllowsDirection = null, newsCheck = null, getLastMutationInfo = null,
  env = process.env, log = null,
} = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const regime = getCachedRegime || (() => require('../engine/regimeLoop').getCachedRegime());
  const allows = regimeAllowsDirection || ((r, d) => require('../../strategies/common/marketRegime').regimeAllowsDirection(r, d));
  const news = newsCheck || (async () => ({ high_impact_found: false, high_impact_count: 0, medium_count: 0, error: 'provider_disabled' }));
  const mutation = getLastMutationInfo || ((s, tf) => require('../genome/store').getLastMutationInfo(s, tf));

  async function evaluateMarketRegime(signal) {
    try {
      const r = await regime();
      if (r === null || r === undefined) return layer('market_regime', NEUTRAL, 0.5, 'Режим не определён (недостаточно данных)', { regime: null });
      const direction = signal.direction === undefined ? 'LONG' : signal.direction;
      let ok;
      try { ok = allows(r, direction); } catch (_e) { ok = true; }
      if (r === 'ranging') return layer('market_regime', NEUTRAL, 0.5, 'Рынок в боковике — нейтрально', { regime: r });
      if (r === 'high_vol') return layer('market_regime', AGAINST, 0.7, 'Высокая волатильность — рискованно', { regime: r });
      if (ok) return layer('market_regime', AGREE, 0.7, `Режим ${r} — согласен с ${direction}`, { regime: r });
      return layer('market_regime', AGAINST, 0.7, `Режим ${r} — против ${direction}`, { regime: r });
    } catch (e) {
      logger.debug(`ai_filter market_regime error: ${e && e.message}`);
      return layer('market_regime', NEUTRAL, 0.5, 'Ошибка проверки режима (нейтрально)', {});
    }
  }

  async function evaluateNewsMonitor(signal) {
    try {
      const symbol = String(signal.symbol || '').split('-USDT-SWAP').join('').split('USDT').join('');
      const n = await news(symbol, 30);
      if (n.error === 'no_api_key') return layer('news_monitor', NEUTRAL, 0.5, 'News service не настроен (CRYPTOPANIC_API_KEY)', n);
      if (n.high_impact_found) return layer('news_monitor', AGAINST, 0.8, 'High-impact news за 30 мин — риск волатильности', n);
      if ((n.medium_count || 0) > 2) return layer('news_monitor', NEUTRAL, 0.6, `${n.medium_count} medium news — осторожно`, n);
      return layer('news_monitor', AGREE, 0.7, 'Нет high-impact news — спокойно', n);
    } catch (e) {
      logger.debug(`ai_filter news error: ${e && e.message}`);
      return layer('news_monitor', NEUTRAL, 0.5, 'News service недоступен (нейтрально)', {});
    }
  }

  async function evaluateGenomeEngine(signal) {
    try {
      const info = await mutation(signal.strategy, signal.timeframe);
      if (info === null || info === undefined) return layer('genome_engine', NEUTRAL, 0.5, 'Genome не применялся', {});
      const hoursAgo = Number(info.hours_since_mutation === undefined ? 999 : info.hours_since_mutation);
      const improvement = Number(info.improvement_pct === undefined ? 0 : info.improvement_pct);
      if (hoursAgo < 4 && improvement > 0.5) {
        return layer('genome_engine', AGREE, 0.75, `Параметры оптимизированы ${fmtFixed(hoursAgo, 1)}ч назад (+${fmtFixed(improvement, 1)}% WR)`, info);
      }
      if (hoursAgo < 24) return layer('genome_engine', NEUTRAL, 0.55, `Параметры стабильны (${fmtFixed(hoursAgo, 0)}ч)`, info);
      return layer('genome_engine', NEUTRAL, 0.45, `Параметры не пересматривались ${fmtFixed(hoursAgo, 0)}ч`, info);
    } catch (e) {
      logger.debug(`ai_filter genome error: ${e && e.message}`);
      return layer('genome_engine', NEUTRAL, 0.5, 'Genome недоступен (нейтрально)', {});
    }
  }

  const EVALUATORS = { market_regime: evaluateMarketRegime, news_monitor: evaluateNewsMonitor, genome_engine: evaluateGenomeEngine };

  async function evaluateSignal(signal, user, context = null) {
    if (String(env.AI_FILTER_ENABLED === undefined ? '1' : env.AI_FILTER_ENABLED).trim() !== '1') {
      return { passed: true, layers: [], confidence_score: 1.0, blocking_layers: [], user_required_count: 0, user_passed_count: 0, preset_name: 'custom' };
    }
    void context;
    const aiSettings = (user && user.ai_filter_settings) || {};
    const active = [];
    for (const [name] of AI_LAYERS) {
      let canUse = false;
      try { canUse = Boolean(user.can(`ai_layer_${name}`)); } catch (_e) { canUse = false; }
      if (!canUse) continue;
      if (!aiSettings[name]) continue;
      active.push(name);
    }
    if (!active.length) {
      return { passed: true, layers: [], confidence_score: 1.0, blocking_layers: [], user_required_count: 0, user_passed_count: 0, preset_name: 'custom' };
    }
    const raw = await Promise.all(active.map((n) => EVALUATORS[n](signal, user, context).then((r) => r, (e) => e instanceof Error ? e : new Error(String(e)))));
    const results = raw.map((r, i) => {
      if (r instanceof Error) {
        logger.warning(pf('[AI-FILTER] layer=%s exception: %s', active[i], r.message));
        return layer(active[i], NEUTRAL, 0.5, 'Ошибка слоя (нейтрально)', {});
      }
      return r;
    });
    const blocking = results.filter((r) => r.verdict === AGAINST);
    const passed = blocking.length === 0;
    const score = calculateWeightedConfidence(results);
    const agreed = results.filter((r) => r.verdict === AGREE).length;
    logger.info(pf('[AI-FILTER] uid=%s sym=%s dir=%s layers=%d/%d agreed=%d passed=%s blocking=%s score=%.2f',
      user && user.user_id !== undefined && user.user_id !== null ? user.user_id : null,
      signal.symbol === undefined ? null : signal.symbol, signal.direction === undefined ? null : signal.direction,
      agreed, results.length, agreed, passed, blocking.map((r) => r.layer_name), score));
    return {
      passed, layers: results, confidence_score: score, blocking_layers: blocking.map((r) => r.layer_name),
      user_required_count: active.length, user_passed_count: results.filter((r) => r.verdict !== AGAINST).length,
      preset_name: 'custom',
    };
  }

  return { evaluateSignal, EVALUATORS };
}

/** handlers/ai_insights.build_ai_button_kb → action keyboard or null. */
function buildAiButtonKb(aiResult, userPlan, tradeId) {
  if (!aiResult || !aiResult.layers || !aiResult.layers.length) return null;
  const agree = aiResult.layers.filter((r) => r.verdict === AGREE).length;
  const total = aiResult.layers.length;
  if (total === 0) return null;
  const ratio = agree / total;
  const indicator = ratio >= 0.7 ? '✅' : (ratio >= 0.4 ? '🟡' : '⚠️');
  let canUse = false;
  try {
    const plan = normalizePlan(userPlan);
    canUse = Boolean((PLAN_FEATURES[plan] || {}).ai_layer_market_regime);
  } catch (_e) {
    canUse = false;
  }
  if (canUse) {
    return [[{ id: 'ai_show', label: `🧠 AI Анализ (${agree}/${total}) ${indicator}`, action: `ai_show:${tradeId}`, kind: 'callback' }]];
  }
  return [[{ id: 'upgrade_for_ai', label: '🧠 AI Анализ 🔒 (Pro)', action: 'upgrade_for_ai', kind: 'callback' }]];
}

module.exports = { AGREE, NEUTRAL, AGAINST, LAYER_WEIGHTS, AI_LAYERS, calculateWeightedConfidence, createAiFilter, buildAiButtonKb };
