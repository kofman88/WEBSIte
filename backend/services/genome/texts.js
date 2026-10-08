'use strict';
/**
 * texts.js — the user-facing genome texts, verbatim (genome_ui.py, handlers/genome.py, i18n):
 *
 *   formatGenomeDashboard(strategy, tf, {store})  genome_ui.format_genome_dashboard (HTML)
 *   formatGenomeHelp()                            genome_ui.format_genome_help (HTML; its stale
 *                                                 numbers — 30 genomes, 20 % elite, 14 days, Bybit — kept)
 *   evolveStatusText(result, strategy, tf)        the adv_g_ev_ reply ("✅ Эволюция …" / "⚠️ …")
 *   applyResultText(result, strategy, tf)         the adv_g_ap_ reply (HTML, html.escape'd keys/values)
 *   genomeKeyboard(strategy, tf, user, lang)      _kb_genome rows [{text, callback}] (the web UI's buttons)
 *   I18N                                          sub_genome_locked / genome_auto_apply_* (RU / EN)
 *   LOCKED_MENU_BUTTON / MENU_BUTTON              main-menu button texts
 */

const { fmtFixed } = require('../../strategies/common/pyfmt');
const { pyRound, pyMax, pyMin } = require('../../strategies/common/pyround');
const { pySum } = require('../../strategies/common/series');
const { GENE_SPACE, FLOAT_GENE_KEYS } = require('./geneSpace');
const C = require('./config');
const { pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const BIRTH_ICON = Object.freeze({ random: '🎲', crossover: '🧬', mutation: '⚡', elite: '👑' });

const I18N = Object.freeze({
  sub_genome_locked: { ru: '🔒 Strategy Genome — доступен в тарифе Pro', en: '🔒 Strategy Genome — available in Pro plan' },
  genome_auto_apply_btn_on: { ru: '🧬 Auto-apply: вкл ✓', en: '🧬 Auto-apply: on ✓' },
  genome_auto_apply_btn_off: { ru: '🧬 Auto-apply: выкл', en: '🧬 Auto-apply: off' },
  genome_auto_apply_disabled: {
    ru: '✅ Genome auto-apply выключен. Параметры стратегии останутся такими, какими ты их настроил.',
    en: '✅ Genome auto-apply disabled. Strategy parameters stay as you configured them.',
  },
  genome_auto_apply_enabled_warn: {
    ru: '⚠️ Genome auto-apply включён. Параметры стратегии будут автоматически обновляться результатами эволюции. Сигналы могут стать реже (эволюция ищет лучший R:R — фильтры строже). Выключи в любой момент тем же переключателем.',
    en: '⚠️ Genome auto-apply enabled. Strategy parameters will auto-update from evolution results. Signal frequency may decrease (evolution optimises for R:R — stricter filters). Toggle off any time.',
  },
});

function t(key, lang = 'ru') {
  const e = I18N[key];
  if (!e) return key;
  return e[lang] || e.ru;
}

const MENU_BUTTON = '🧬 Strategy Genome';
const LOCKED_MENU_BUTTON = '🔒 🧬 Strategy Genome  · ⭐ PRO';
const EVOLVE_STARTED = '🚀 Запускаю эволюцию... (1-3 мин)';
const APPLY_STARTED = '🔧 Применяю лучший геном...';

/** html.escape(s, quote=True) */
function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** Python str(v) for a genome / changed value (float keys print like floats). */
function pyStr(v, key = null) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') {
    const { pyRepr } = require('../../strategies/common/pyfmt');
    if ((key !== null && FLOAT_GENE_KEYS.has(key)) || !Number.isInteger(v)) return pyRepr(v);
    return String(v);
  }
  return String(v);
}

const isFloatVal = (k, v) => typeof v === 'number' && (FLOAT_GENE_KEYS.has(k) || !Number.isInteger(v));
const fitOf = (g) => (g && g.fitness !== undefined && g.fitness !== null ? g.fitness : 0);

/** genome_ui.format_genome_dashboard(strategy, tf) */
function formatGenomeDashboard(strategy = 'LEVELS', tf = '', { store = null } = {}) {
  const st = store || require('./store');
  let S = pyUpper(String(strategy || ''));
  if (!Object.prototype.hasOwnProperty.call(GENE_SPACE, S)) S = 'LEVELS';
  const tfs = C.getTfs(S);
  let T = tf;
  if (!tfs.includes(T)) T = C.getDefaultTf(S);

  const lastGen = st.getLastGeneration(S, T);
  const pop = lastGen ? st.getCurrentPopulation(S, T, lastGen) : [];
  const history = st.getHistory(S, T, 15);

  const lines = [
    '🧬 <b>STRATEGY GENOME</b>',
    SEP,
    `<i>Стратегия: <b>${S}</b>  ·  ТФ: <b>${T}</b>  ·  популяция ${C.POP_SIZE}  ·  элита ${Math.trunc(C.ELITE_FRACTION * 100)}%</i>`,
    `<i>Доступные ТФ: ${tfs.join(', ')}</i>`,
    '',
  ];

  if (!pop.length) {
    lines.push(
      '🔬 <b>Популяция ещё не создана.</b>',
      '',
      'Первое поколение будет запущено автоматически через несколько минут,',
      'либо вручную через кнопку <b>🚀 Запустить новую эволюцию</b>.',
      '',
      `<i>Гены для ${S}: ${Object.keys(GENE_SPACE[S]).length} параметров.</i>`,
    );
    return lines.join('\n');
  }

  let best = pop[0];
  for (let i = 1; i < pop.length; i++) if (fitOf(pop[i]) > fitOf(best)) best = pop[i];
  const fitnesses = pop.map(fitOf);
  const avgFit = pySum(fitnesses) / pop.length;
  const wr = best.winrate === undefined || best.winrate === null ? 0 : best.winrate;
  const pf = best.profit_factor === undefined || best.profit_factor === null ? 0 : best.profit_factor;
  const ciLo = best.wr_ci_low || 0;
  const ciHi = best.wr_ci_high || 0;
  const livePf = best.live_pf ? best.live_pf : pyRound(pf * C.LIVE_PF_DISCOUNT, 2);
  const ciStr = ciLo > 0 ? ` (${fmtFixed(ciLo, 0)}-${fmtFixed(ciHi, 0)}% CI)` : '';
  const stab = [];
  if (Object.prototype.hasOwnProperty.call(best, 'regime_mult')) {
    const r = best.regime_mult === undefined || best.regime_mult === null ? 1.0 : best.regime_mult;
    const icon = r >= 0.85 ? '🟢' : (r >= 0.6 ? '🟡' : '🔴');
    const word = r >= 0.85 ? 'отлично' : (r >= 0.6 ? 'средне' : 'нестабильно');
    stab.push(`  ${icon} Стабильность: ${word}  ·  MC DD: ${fmtFixed(best.mc_p95_dd || 0, 1)}R`);
  }
  let mn = fitnesses[0];
  let mx = fitnesses[0];
  for (const f of fitnesses) { if (f < mn) mn = f; if (f > mx) mx = f; }

  lines.push(
    `🧪 <b>Поколение #${lastGen}</b>`,
    `  🏆 Best fitness: <b>${fmtFixed(fitOf(best), 3)}</b>`,
    `  📊 WR: <b>${fmtFixed(wr, 1)}%</b>${ciStr}`,
    `  📈 PF: <b>${fmtFixed(pf, 2)}</b> (backtest)  →  <b>${fmtFixed(livePf, 2)}</b> (ожид. live)`,
    `  📋 Сделок: ${pyStr(best.trades === undefined ? 0 : best.trades)}  ·  DD: ${fmtFixed(best.drawdown || 0, 1)}R`,
    ...stab,
    `  Среднее fitness: ${fmtFixed(avgFit, 3)}  (разброс ${fmtFixed(mn, 2)}…${fmtFixed(mx, 2)})`,
    '',
  );

  lines.push('🏅 <b>TOP-5 геномов:</b>');
  const top5 = pop.map((g, i) => [g, i]).sort((a, b) => (fitOf(b[0]) - fitOf(a[0])) || (a[1] - b[1])).slice(0, 5).map((x) => x[0]);
  top5.forEach((g, k) => {
    const icon = BIRTH_ICON[g.birth_type || ''] || '·';
    const glpf = g.live_pf || 0;
    const lpfStr = glpf > 0 ? ` →${fmtFixed(glpf, 1)}` : '';
    lines.push(`  ${k + 1}. ${icon} fitness <b>${fmtFixed(g.fitness, 3)}</b>  WR ${fmtFixed(g.winrate, 0)}% · PF ${fmtFixed(g.profit_factor, 2)}${lpfStr} · N=${pyStr(g.trades)}`);
  });
  lines.push('');

  lines.push('👑 <b>Лучший геном (параметры):</b>');
  for (const k of Object.keys(best.genome || {}).sort()) {
    const v = best.genome[k];
    const vs = isFloatVal(k, v) ? fmtFixed(v, 3).replace(/0+$/, '').replace(/\.$/, '') : pyStr(v, k);
    lines.push(`  <code>${k} = ${vs}</code>`);
  }
  lines.push('');

  if (history.length >= 2) {
    lines.push('📈 <b>Эволюция fitness (best/avg):</b>');
    let maxFit = history.length ? history.reduce((m, h) => (h.best_fitness > m ? h.best_fitness : m), history[0].best_fitness) : 1.0;
    if (!maxFit) maxFit = 1.0;
    if (maxFit <= 0) maxFit = 1.0;
    const width = 20;
    for (const h of history) {
      const ratio = pyMax(0.0, pyMin(1.0, h.best_fitness / maxFit));
      const filled = Math.trunc(ratio * width);
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      lines.push(`  gen#${String(h.generation).padEnd(3)} ${bar} ${fmtFixed(h.best_fitness, 2)}  (avg ${fmtFixed(h.avg_fitness, 2)})`);
    }
    lines.push('');
  }

  if (best.parent_a || best.parent_b) {
    lines.push(`🧬 <b>Генеалогия:</b> ребёнок ID ${best.id} (parents: #${best.parent_a || 0} × #${best.parent_b || 0}, тип: ${best.birth_type === undefined || best.birth_type === null ? '?' : best.birth_type})`);
    lines.push('');
  }

  lines.push(SEP);
  lines.push(
    `<i>Backtest: top-${C.evalTopN(S)} монет × ${C.EVAL_DAYS} дней на ТФ <b>${T}</b>. `
    + `Fees ${pyStr(C.FEE_ROUND_TRIP_PCT, 'fee')}% + slippage ${pyStr(C.SLIPPAGE_PCT, 'fee')}%. `
    + `Out-of-sample: train ${Math.trunc(C.OOS_SPLIT * 100)}% / test ${Math.trunc((1 - C.OOS_SPLIT) * 100)}%. `
    + `Live PF = backtest × ${pyStr(C.LIVE_PF_DISCOUNT, 'fee')}.</i>`,
  );
  lines.push('⚠️ Fitness считается ТОЛЬКО на out-of-sample данных. Multi-regime проверка: геном должен работать в обоих периодах. CI = 95% confidence interval для WR.');
  return lines.join('\n');
}

/** "🧬 <b>STRATEGY GENOME</b>\n\nModule error: {e}" */
function dashboardModuleError(e) {
  return `🧬 <b>STRATEGY GENOME</b>\n\nModule error: ${e && e.message !== undefined ? e.message : e}`;
}

const HELP_TEXT = '📖 <b>STRATEGY GENOME — гид</b>\n'
  + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
  + '<b>Что это:</b>\n'
  + 'Генетический алгоритм, который автоматически находит лучшие '
  + 'параметры торговой стратегии через backtest. Вместо того чтобы '
  + 'вручную подбирать <code>min_rr</code>, <code>vol_mult</code> и '
  + 'десятки других параметров — эволюция делает это за тебя.\n\n'
  + '<b>Ключевые понятия:</b>\n'
  + '• <b>Геном</b> — набор параметров стратегии (min_rr, vol_mult, '
  + 'min_quality, и т.д.). Каждый геном = одна «версия» стратегии.\n'
  + '• <b>Популяция</b> — 30 геномов, живущие в данном поколении.\n'
  + '• <b>Fitness</b> — оценка качества на backtest:\n'
  + '    <code>WR × PF × log(trades) − drawdown</code>\n'
  + '  Чем выше — тем лучше работает стратегия.\n'
  + '• <b>Поколение</b> — одна итерация эволюции (каждые 6 часов).\n\n'
  + '<b>Таймфреймы (важно!):</b>\n'
  + 'Backtest для каждой стратегии идёт на её «родном» ТФ:\n'
  + '  • LEVELS   → <b>1h</b>  (свинг)\n'
  + '  • SMC      → <b>1h</b>  (структура)\n'
  + '  • VOLUME   → <b>1h</b>  (EMA + объём)\n'
  + 'Геном оптимизирован <b>только для своего ТФ</b>. '
  + 'Если у тебя LEVELS-сканер стоит на 4h — применение генома '
  + '(подобран на 1h) может дать другой результат. Совет: '
  + 'переключи основной ТФ стратегии на 1h перед применением.\n\n'
  + '<b>Как работает эволюция:</b>\n'
  + '1. 🎲 <b>Инициализация</b>: первое поколение — 30 случайных геномов.\n'
  + '2. 🧪 <b>Evaluation</b>: каждый геном тестируется на backtest '
  + '(10 монет × 14 дней на своём ТФ) → fitness.\n'
  + '3. 👑 <b>Элита</b>: топ-20% (6 геномов) переходят без изменений.\n'
  + '4. 🧬 <b>Crossover</b>: 2 случайных родителя «скрещиваются» — '
  + 'ребёнок наследует часть генов от каждого.\n'
  + '5. ⚡ <b>Mutation</b>: с вероятностью 50% один из генов ребёнка '
  + 'случайно меняется — это даёт разнообразие.\n'
  + '6. Новое поколение заменяет старое.\n\n'
  + '<b>Обозначения на дашборде:</b>\n'
  + '🎲 random — случайный геном (только в поколении #1)\n'
  + '👑 elite — прошёл отбор из прошлого поколения\n'
  + '🧬 crossover — смесь двух родителей\n'
  + '⚡ mutation — смесь + случайное изменение гена\n\n'
  + '<b>Как читать метрики:</b>\n'
  + '• <b>WR</b> — winrate (% выигрышных сделок)\n'
  + '• <b>PF</b> — profit factor (сумма прибылей / сумма убытков, &gt;1 = выгодно)\n'
  + '• <b>N</b> — количество сделок на backtest (минимум 3 для валидности)\n'
  + '• <b>DD</b> — максимальная просадка (%)\n'
  + '• <b>fitness</b> — итоговый score (все вместе)\n\n'
  + '<b>Как использовать:</b>\n'
  + '1. Жди первой эволюции (до 5-10 мин после деплоя бота).\n'
  + '2. Смотри <b>TOP-5</b> и лучший геном.\n'
  + '3. Если fitness &gt; 2.0 — стратегия рабочая на текущем рынке.\n'
  + '4. Нажми <b>🔧 Применить лучший</b> — параметры применятся к '
  + 'твоим персональным настройкам стратегии.\n'
  + '5. Следи за ростом <b>best fitness</b> через поколения — '
  + 'если растёт, эволюция «учится». Если стоит на месте — '
  + 'возможно, уже найден локальный максимум.\n\n'
  + '<b>Ограничения и правила:</b>\n'
  + '• Backtest на 14 днях может не учитывать смену режима рынка — '
  + 'геном может быть «подогнан» под недавнюю фазу\n'
  + '• Минимум 3 сделки для валидного fitness — иначе score = 0\n'
  + '• Эволюция идёт по каждой стратегии отдельно (LEVELS, SMC, VOLUME)\n'
  + '• Не применяй вслепую — проверь что геном даёт &gt;20 сделок за 14 дней\n\n'
  + '<b>Кнопки дашборда:</b>\n'
  + '• <b>🔄 Обновить</b> — перечитать данные из БД\n'
  + '• <b>🚀 Эволюция сейчас</b> — запустить новое поколение (займёт 1-3 мин)\n'
  + '• <b>🔧 Применить лучший</b> — скопировать параметры в свой профиль\n'
  + '• <b>📊 Переключить стратегию</b> — LEVELS / SMC / VOLUME\n\n'
  + '<b>Советы:</b>\n'
  + '• Не спеши применять первое поколение — оно случайное, '
  + 'подожди хотя бы 3-5 поколений\n'
  + '• Сравни свои текущие параметры с лучшим геномом — возможно '
  + 'ты интуитивно подобрал близко к оптимуму\n'
  + '• Если лучший fitness стагнирует — нажми «Эволюция сейчас» '
  + 'несколько раз подряд, mutation найдёт новый оптимум\n\n'
  + '<i>Эволюция работает на реальных исторических данных Bybit.</i>';

function formatGenomeHelp() {
  return HELP_TEXT;
}

/** handlers/genome.cb_genome_evolve reply text. */
function evolveStatusText(result, strategy, tf) {
  if (result && result.ok) {
    return `✅ Эволюция ${strategy}/${tf} завершена!\n`
      + `Поколение #${result.generation}, best fitness ${fmtFixed(result.best_fitness, 3)}, WR ${fmtFixed(result.best_wr, 1)}%, PF ${fmtFixed(result.best_pf, 2)}\n`
      + `Время: ${fmtFixed(result.elapsed, 0)}с`;
  }
  const err = result && result.error !== undefined ? result.error : 'unknown';
  return `⚠️ Эволюция не удалась: ${err}`;
}

/** handlers/genome.cb_genome_apply reply text (HTML). */
function applyResultText(result, strategy, tf) {
  if (result && result.ok) {
    const changed = result.changed || {};
    const keys = Object.keys(changed);
    if (!keys.length) return `ℹ️ Твои настройки уже совпадают с лучшим геномом ${strategy}/${tf}.`;
    const lines = [
      `✅ Лучший геном ${strategy}/${tf} применён!`,
      `Fitness: ${fmtFixed(result.fitness, 3)}  ·  WR: ${fmtFixed(result.winrate, 1)}%  ·  PF: ${fmtFixed(result.pf, 2)}  (N=${pyStr(result.trades)} сделок)`,
      '',
      `<b>⚠️ Переключи ТФ стратегии на ${tf}</b> в настройках`,
      '',
      '<b>🚨 ВАЖНО — прочитай перед использованием:</b>',
      '• Это результат БЭКТЕСТА — прошлые данные ≠ будущая прибыль',
      '• Рынок мог поменяться за последние 21 день',
      '• Геном мог overfit-иться под конкретные условия',
      '• <b>Торгуй с минимальным риском</b> (0.3-0.5%) первую неделю',
      '• Если реальный WR сильно ниже backtest — откати настройки',
      '',
      'Изменено:',
    ];
    for (const k of keys.sort()) lines.push(`  • <code>${htmlEscape(pyStr(k))}</code> → <code>${htmlEscape(pyStr(changed[k], k))}</code>`);
    return lines.join('\n');
  }
  const err = result && result.error !== undefined ? result.error : 'unknown';
  return `⚠️ Не удалось применить: ${htmlEscape(pyStr(err))}`;
}

/** handlers/genome._kb_genome(strategy, tf, user) as rows of {text, callback}. */
function genomeKeyboard(strategy = 'LEVELS', tf = '1h', user = null, lang = null) {
  const lg = lang || (user && user.lang) || 'ru';
  const rows = [];
  rows.push(C.STRATEGIES.map((s) => ({ text: `${s === strategy ? '◉ ' : '○ '}${s}`, callback: `adv_g_st_${s}_${C.getDefaultTf(s)}` })));
  rows.push(C.getTfs(strategy).map((x) => ({ text: `${x === tf ? '◉ ' : '○ '}${x}`, callback: `adv_g_tf_${strategy}_${x}` })));
  rows.push([{ text: '🔄 Обновить', callback: `adv_g_tf_${strategy}_${tf}` }]);
  rows.push([{ text: '🚀 Эволюция сейчас', callback: `adv_g_ev_${strategy}_${tf}` }]);
  rows.push([{ text: '🔧 Применить лучший', callback: `adv_g_ap_${strategy}_${tf}` }]);
  const on = Boolean(user && user.genome_auto_apply);
  rows.push([{ text: t(on ? 'genome_auto_apply_btn_on' : 'genome_auto_apply_btn_off', lg), callback: `genome_auto_apply_toggle:${strategy}_${tf}` }]);
  rows.push([{ text: 'ℹ️ Что это / как работает', callback: 'adv_genome_help' }]);
  rows.push([{ text: '◀️ Назад', callback: 'back_main' }]);
  return rows;
}

module.exports = {
  SEP, BIRTH_ICON, I18N, t, MENU_BUTTON, LOCKED_MENU_BUTTON, EVOLVE_STARTED, APPLY_STARTED,
  htmlEscape, pyStr, formatGenomeDashboard, dashboardModuleError, HELP_TEXT, formatGenomeHelp,
  evolveStatusText, applyResultText, genomeKeyboard,
};
