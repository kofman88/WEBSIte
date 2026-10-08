/**
 * profilesService — the bot's profiles.py ([PROFILES] «Консервативный» /
 * «Активный», genome-challenge-profiles.md Part 3): one tap sets LEVELS /
 * VOLUME quality, risk, leverage, trade limit, auto-trade mode,
 * counter-trend, quiet hours and the strategy set (within the plan).
 *
 * `applyProfile(user, name, {admin, save})` mutates `user`, saves it (unless
 * save=false) and returns {ok, profile, applied[], skipped[]} in the bot's
 * order of operations. `enableStrategy` is the shared helper the Challenge
 * uses too (challenge.apply_settings → profiles._enable_strategy).
 */

'use strict';

const ts = require('./traderSettingsService');
const volumeUserCfg = require('./volumeUserCfg');
const volumeCfg = require('./engine/volumeCfgShim');
const tradeCfg = require('./engine/tradeCfg');
const quietHours = require('./engine/quietHours');
const strategySet = require('./engine/strategySet');
const logger = require('../utils/logger');

const PROFILES = Object.freeze({
  conservative: {
    title: { ru: 'Консервативный', en: 'Conservative' },
    desc: {
      ru: 'Качество 4★+, риск 0.5%, плечо 5, до 3 сделок, вход с подтверждением, '
        + 'только по тренду, тихие часы 23–07 UTC, стратегии: Уровни + SMC',
      en: 'Quality 4★+, 0.5% risk, 5x, up to 3 trades, confirmation mode, '
        + 'trend-only, quiet hours 23–07 UTC, strategies: Levels + SMC',
    },
    levels_min_quality: 7, volume_min_quality: 4,
    trade_risk_pct: 0.5, trade_leverage: 5, max_trades_limit: 3,
    auto_trade_mode: 'confirm', allow_counter_trend: false,
    levels_counter_trend_min_quality: 5,
    quiet: [23, 7], strategies: ['LEVELS', 'SMC'],
  },
  active: {
    title: { ru: 'Активный', en: 'Active' },
    desc: {
      ru: 'Качество 3★+, риск 1.5%, плечо 10, до 5 сделок, контр-тренд от 4★, '
        + 'без тихих часов, стратегии: Уровни + SMC + Объём',
      en: 'Quality 3★+, 1.5% risk, 10x, up to 5 trades, counter-trend from 4★, '
        + 'no quiet hours, strategies: Levels + SMC + Volume',
    },
    levels_min_quality: 5, volume_min_quality: 3,
    trade_risk_pct: 1.5, trade_leverage: 10, max_trades_limit: 5,
    auto_trade_mode: null, allow_counter_trend: true,
    levels_counter_trend_min_quality: 4,
    quiet: [-1, -1], strategies: ['LEVELS', 'SMC', 'VOLUME'],
  },
});

function title(name, lang = 'ru') {
  const p = PROFILES[name];
  return p ? p.title[lang === 'en' ? 'en' : 'ru'] : name;
}

function describe(name, lang = 'ru') {
  const p = PROFILES[name];
  return p ? p.desc[lang === 'en' ? 'en' : 'ru'] : '';
}

/**
 * profiles._enable_strategy(user, S): SMC / VOLUME need the plan feature;
 * long flag on, short flag = can("both_directions"); LEVELS also active=True
 * and scan_mode both|long; then _apply_multi(user, S, True).
 */
function enableStrategy(user, s, { admin } = {}) {
  const feat = { SMC: 'smc', VOLUME: 'volume' }[s];
  if (feat && !ts.can(user, feat, { admin })) return false;
  const flags = strategySet.FLAGS[s];
  if (!flags) return false;
  const both = Boolean(ts.can(user, 'both_directions', { admin }));
  user[flags[0]] = true;
  user[flags[1]] = both;
  if (s === 'LEVELS') {
    user.active = true;
    user.scan_mode = both ? 'both' : 'long';
  }
  strategySet.applyMulti(user, s, true);
  return true;
}

/** profiles.apply_profile(user, name, um) */
function applyProfile(user, name, { admin, save = true } = {}) {
  const key = String(name || '').toLowerCase();
  const p = PROFILES[key];
  if (!p) return { ok: false, error: 'unknown_profile' };
  const applied = [];
  const skipped = [];
  // LEVELS quality (0..10) — shared cfg, like Mini App settings/all
  try {
    tradeCfg.updateSharedField(user, 'min_quality', Math.trunc(p.levels_min_quality));
    applied.push('levels.min_quality');
  } catch (e) {
    logger.debug(`[PROFILE] levels min_quality: ${e.message}`); skipped.push('levels.min_quality');
  }
  // VOLUME quality (kv volume_cfg)
  try {
    if (ts.can(user, 'volume', { admin })) {
      const d = volumeCfg.impl().toDict(volumeUserCfg.loadUserCfg(user.user_id));
      d.min_quality = Math.trunc(p.volume_min_quality);
      volumeUserCfg.saveUserCfg(user.user_id, d);
      applied.push('volume.min_quality');
    } else {
      skipped.push('volume.min_quality');
    }
  } catch (e) {
    logger.debug(`[PROFILE] volume cfg: ${e.message}`); skipped.push('volume.min_quality');
  }
  for (const k of ['trade_risk_pct', 'trade_leverage', 'max_trades_limit', 'allow_counter_trend', 'levels_counter_trend_min_quality']) {
    user[k] = p[k];
    applied.push(k);
  }
  if (p.auto_trade_mode) {
    user.auto_trade_mode = p.auto_trade_mode;
    applied.push('auto_trade_mode');
  }
  try {
    [user.quiet_start, user.quiet_end] = quietHours.normalize(p.quiet[0], p.quiet[1]);
    applied.push('quiet_hours');
  } catch (e) {
    logger.debug(`[PROFILE] quiet: ${e.message}`); skipped.push('quiet_hours');
  }
  for (const s of p.strategies) {
    (enableStrategy(user, s, { admin }) ? applied : skipped).push(`strategy.${s}`);
  }
  if (save) ts.save(user);
  logger.info(`[PROFILE] uid=${user.user_id} ${key} applied=${JSON.stringify(applied)} skipped=${JSON.stringify(skipped)}`);
  return { ok: true, profile: key, applied, skipped };
}

/** profiles.summary_text(name, res, lang) — the bot's confirmation card. */
function summaryText(name, res, lang = 'ru') {
  const t = title(name, lang);
  const sk = (res && res.skipped ? res.skipped : []).filter((x) => x.startsWith('strategy.') || x === 'volume.min_quality');
  let note = '';
  if (sk.length) {
    note = (lang !== 'en' ? '\n\n<i>Часть пропущена — доступно на Pro: ' : '\n\n<i>Skipped (Pro only): ')
      + sk.map((x) => x.split('.').pop()).join(', ') + '</i>';
  }
  const head = lang !== 'en' ? `🎚 <b>Профиль «${t}» применён</b>` : `🎚 <b>Profile «${t}» applied</b>`;
  return head + '\n' + describe(name, lang) + note;
}

module.exports = { PROFILES, title, describe, enableStrategy, applyProfile, summaryText };
