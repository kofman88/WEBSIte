'use strict';
/**
 * riskPreview.js — port of risk_preview.py ([W1.2 RISK-PREVIEW]): the "Риск этой сделки" line
 * appended to the trade-open message.
 *
 *   calculateRiskPreview({entry, sl, qty, balanceUsd, pmult}) → {risk_amount_usd, risk_pct_balance,
 *       sl_distance_pct, warning_level}   (safe < 1.5 % ≤ elevated < 3 % ≤ high < 5 % ≤ extreme)
 *   formatRiskPreviewLine(preview, lang)  '' when the amount is 0
 */

const { pyRound } = require('../../strategies/common/pyround');
const { fmtFixed } = require('../../strategies/common/pyfmt');

function calculateRiskPreview({ entry, sl, qty, balanceUsd, pmult = 1.0 }) {
  if (entry <= 0 || sl <= 0 || qty <= 0 || balanceUsd <= 0) {
    return { risk_amount_usd: 0.0, risk_pct_balance: 0.0, sl_distance_pct: 0.0, warning_level: 'unknown' };
  }
  const slDist = Math.abs(entry - sl);
  const riskAmount = slDist * qty * (pmult || 1.0);
  const pctBalance = balanceUsd > 0 ? riskAmount / balanceUsd * 100.0 : 0.0;
  const slDistPct = slDist / entry * 100.0;
  let level;
  if (pctBalance < 1.5) level = 'safe';
  else if (pctBalance < 3.0) level = 'elevated';
  else if (pctBalance < 5.0) level = 'high';
  else level = 'extreme';
  return {
    risk_amount_usd: pyRound(riskAmount, 2), risk_pct_balance: pyRound(pctBalance, 2),
    sl_distance_pct: pyRound(slDistPct, 2), warning_level: level,
  };
}

const EMOJI = { safe: '🟢', elevated: '🟡', high: '🟠', extreme: '🔴' };
const LABEL_RU = { safe: 'безопасно', elevated: 'умеренный риск', high: 'высокий риск', extreme: 'ОЧЕНЬ ВЫСОКИЙ риск' };
const LABEL_EN = { safe: 'safe', elevated: 'moderate', high: 'high', extreme: 'VERY HIGH' };

function formatRiskPreviewLine(preview, lang = 'ru') {
  if (preview.risk_amount_usd <= 0) return '';
  const level = preview.warning_level;
  const em = EMOJI[level] || '⚪';
  if (lang === 'en') {
    const label = LABEL_EN[level] || level;
    return `${em} <b>Risk if SL hits:</b> -$${fmtFixed(preview.risk_amount_usd, 2)} (-${fmtFixed(preview.risk_pct_balance, 2)}% of balance) <i>· ${label}</i>`;
  }
  const label = LABEL_RU[level] || level;
  return `${em} <b>Риск этой сделки:</b> -$${fmtFixed(preview.risk_amount_usd, 2)} (-${fmtFixed(preview.risk_pct_balance, 2)}% от баланса) <i>· ${label}</i>`;
}

module.exports = { calculateRiskPreview, formatRiskPreviewLine };
