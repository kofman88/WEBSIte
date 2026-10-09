/**
 * adv_families — how much of each adversarial scenario family the driver's fixture exercises
 * (inputs and the bot's observed effects). adv_scan.test.js asserts every family is non-empty;
 * `node adv_families.js fixtures/adv_scan.json.gz` prints the counts.
 */
'use strict';

const path = require('path');

const steps = (FIX, name) => FIX.expected.flatMap((t) => t.steps.filter((s) => !name || s.step === name));
const logs = (FIX, re, step) => steps(FIX, step).reduce((n, s) => n + s.logs.filter((l) => re.test(l[2])).length, 0);
const sends = (FIX, step, pred = () => true) => steps(FIX, step).reduce((n, s) => n + s.sent.filter(pred).length, 0);
const delivered = (m) => m.ok === true;

function families(FIX) {
  const users = FIX.users;
  const last = FIX.expected[FIX.expected.length - 1];
  const trades = last.trades;
  const optUsers = new Set(FIX.opt_init.map((r) => r[0]));
  const kvKeys = Object.keys(FIX.kv_init);
  const fam = {
    // ── inputs ──
    users: users.length,
    plans_free: users.filter((u) => u.sub_plan === 'free').length,
    plans_pro_trial_elite: users.filter((u) => u.sub_plan !== 'free' && u.sub_status !== 'banned').length,
    plans_banned_or_expired: users.filter((u) => u.sub_status === 'banned' || u.sub_status === 'expired').length,
    multi_strategy: users.filter((u) => String(u.extra_strategies || '').trim() !== '').length,
    long_short_flags: users.filter((u) => u.long_active || u.short_active || u.smc_long_active || u.vol_short_active).length,
    min_quality_varied: new Set(users.map((u) => u.min_quality)).size,
    risk_varied: new Set(users.map((u) => u.trade_risk_pct)).size,
    quiet_hours: users.filter((u) => Number(u.quiet_start) >= 0).length,
    format_lite: users.filter((u) => u.signal_format === 'lite').length,
    lang_en: users.filter((u) => u.lang === 'en').length,
    lang_ru: users.filter((u) => u.lang === 'ru').length,
    genome_auto_apply_with_genome: users.filter((u) => u.genome_auto_apply && optUsers.has(u.user_id)).length,
    challenge_active: kvKeys.filter((k) => k.startsWith('challenge_')).length,
    auto_trade_on: users.filter((u) => u.auto_trade).length,
    bot_blocked_users: FIX.bot_fail.length,
    candle_mutations: FIX.mutations.length,
    cache_modes: FIX.cache_mode.length,
    rest_modes: FIX.rest_mode.length,
    ticks: FIX.ticks.length,
    ws_bar_close_triggers: FIX.ticks.reduce((n, t) => n + t.ws.length, 0),
    settings_mutations: FIX.ticks.reduce((n, t) => n + t.mutate.length, 0),
    genome_updates: FIX.ticks.reduce((n, t) => n + t.opt_update.length, 0),
    momentum_events: FIX.ticks.filter((t) => t.momentum).length,
    trend_seeds: FIX.ticks.filter((t) => t.trend_seed).length,
    // ── observed effects ──
    levels_sends: sends(FIX, 'LEVELS', delivered),
    smc_sends: sends(FIX, 'SMC', delivered),
    volume_sends: sends(FIX, 'VOLUME', delivered),
    trend_broadcasts: sends(FIX, 'trend'),
    evening_reports: sends(FIX, 'evening'),
    undeliverable_sends: steps(FIX).reduce((n, s) => n + s.sent.filter((m) => m.ok === false).length, 0),
    free_window_ux: logs(FIX, /^\[FREE-(UX|WINDOW|SMC-PREVIEW)|^\[LEVELS-HINT-FREE\]/),
    registry_blocked: (last.state.registry_stats || {}).blocked || 0,
    levels_indicator_cooldowns: Object.values(last.state.levels_cooldowns || {}).reduce((n, v) => n + Object.keys(v).length, 0),
    freshness_rejects: logs(FIX, /^\[STALE-SIGNAL\]|^\[SIGNAL-DRIFT\]/),
    momentum_vetoes: logs(FIX, /^\[MOMENTUM-VETO\]/),
    filter_blocks: logs(FIX, /^\[FILTER-BLOCK\]/),
    auto_trade_calls: steps(FIX).reduce((n, s) => n + s.at.length, 0),
    charts: steps(FIX).reduce((n, s) => n + s.charts.length, 0),
    rest_calls: steps(FIX).reduce((n, s) => n + s.rest.length, 0),
    trades_levels: trades.filter((r) => r.strategy === 'LEVELS').length,
    trades_smc: trades.filter((r) => r.strategy === 'SMC').length,
    trades_volume: trades.filter((r) => r.strategy === 'VOLUME').length,
    trade_events: last.events.length,
    log_lines: steps(FIX).reduce((n, s) => n + s.logs.length, 0),
  };
  return fam;
}

module.exports = { families };

if (require.main === module) {
  // eslint-disable-next-line global-require
  const { loadFixture } = require(path.join(__dirname, 'adv_replay.js'));
  const fam = families(loadFixture(process.argv[2] || path.join(__dirname, 'fixtures', 'adv_scan.json.gz')));
  for (const [k, v] of Object.entries(fam)) console.log(String(v).padStart(7), k);
}
