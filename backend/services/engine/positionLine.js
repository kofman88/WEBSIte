/**
 * positionLine — the bot's position_size.py verbatim (signal-pipeline.md §8.5):
 * the «💼 Позиция ≈ $…» line of a signal card.
 *
 * Pure: the exchange balance is passed in by the caller (the bot awaits
 * balance_cache.get_cached_balance with a 3 s timeout; the worker does that
 * and hands the number — or null — to `positionLine`). No balance (null /
 * ≤ 0) → the hypothetical $1000 deposit.
 */

'use strict';

const { fmtComma, fmtG } = require('../../strategies/common/pyfmt');
const { pyRound } = require('../../strategies/common/pyround');
const { pyFloat, pyInt } = require('./pycoerce');

const DEFAULT_DEPOSIT = 1000.0;

/** position_size.compute(balance, risk_pct, entry, sl, leverage) → {} when nothing to show. */
function compute(balance, riskPct, entry, sl, leverage) {
  const e = Number(entry);
  const slPct = e ? Math.abs(e - Number(sl)) / e : 0.0;
  if (slPct <= 0 || balance <= 0 || riskPct <= 0) return {};
  // int(leverage or 1): a float leverage truncates
  const lev = Math.max(1, Math.trunc(Number(leverage || 1)));
  const riskUsd = balance * riskPct / 100.0;
  let notional = riskUsd / slPct;
  let capped = false;
  if (notional > balance * lev) {          // маржи не хватит — биржа урежет размер
    notional = balance * lev;
    capped = true;
  }
  return { risk_usd: riskUsd, notional, margin: notional / lev, sl_pct: slPct * 100.0, leverage: lev, capped };
}

/** _usd(v): f"${v:,.0f}" when v >= 100 else f"${v:,.1f}" */
function usd(v) {
  return v >= 100 ? `$${fmtComma(v, 0)}` : `$${fmtComma(v, 1)}`;
}

/**
 * position_line(user, entry, sl, lang, ctx) with the balance resolved by the caller.
 *   opts.balance        — cached exchange balance (null when the user has no keys / fetch failed)
 *   opts.ctxRiskMult / opts.ctxLabel — trend_monitor hooks (default: the trendMonitor module)
 * Any exception → "" (the line is a nicety, never breaks delivery).
 */
function positionLine(user, entry, sl, lang = 'ru', ctx = '', opts = {}) {
  try {
    const u = user || {};
    let riskPct = pyFloat(u.trade_risk_pct || 1.0);
    let mult = 1.0;
    let multNote = '';
    if (ctx) {
      try {
        const tm = opts.ctxRiskMult && opts.ctxLabel ? opts : require('./trendMonitor');
        mult = pyFloat(tm.ctxRiskMult(ctx));
        if (mult <= 0.0) {
          return lang !== 'en'
            ? '⛔ <i>Автотрейд: сделка против сильного тренда BTC будет пропущена</i>'
            : '⛔ <i>Auto-trade: a trade against a strong BTC trend will be skipped</i>';
        }
        if (mult !== 1.0) {
          riskPct = pyRound(riskPct * mult, 4);
          multNote = ` (×${fmtG(mult, 6)}, ${tm.ctxLabel(ctx, lang)})`;
        }
      } catch (_e) { /* log.debug("[POSITION-SIZE] ctx: %s") */ }
    }
    const lev = pyInt(u.trade_leverage || 10);
    const bal = opts.balance === undefined ? null : opts.balance;
    const hypothetical = bal === null || pyFloat(bal) <= 0;
    const base = hypothetical ? DEFAULT_DEPOSIT : pyFloat(bal);
    const r = compute(base, riskPct, pyFloat(entry), pyFloat(sl), lev);
    if (!Object.keys(r).length) return '';
    if (lang === 'en') {
      const tail = hypothetical ? ` <i>(on a ${usd(base)} deposit)</i>` : ` <i>(balance ${usd(base)})</i>`;
      let s = `💼 Position ≈ <b>${usd(r.notional)}</b> · risk ${fmtG(riskPct, 6)}%${multNote} = ${usd(r.risk_usd)}`
        + ` · margin ${usd(r.margin)} at ${r.leverage}x${tail}`;
      if (r.capped) s += ' ⚠️ <i>not enough margin for the full risk</i>';
      return s;
    }
    const tail = hypothetical ? ` <i>(при депозите ${usd(base)})</i>` : ` <i>(баланс ${usd(base)})</i>`;
    let s = `💼 Позиция ≈ <b>${usd(r.notional)}</b> · риск ${fmtG(riskPct, 6)}%${multNote} = ${usd(r.risk_usd)}`
      + ` · маржа ${usd(r.margin)} при ${r.leverage}x${tail}`;
    if (r.capped) s += ' ⚠️ <i>маржи на полный риск не хватит</i>';
    return s;
  } catch (_e) {
    return '';
  }
}

module.exports = { DEFAULT_DEPOSIT, compute, usd, positionLine };
