/**
 * trailingStop.js — V4 Hybrid Trailing Stop
 * Ported from Python CHM_BREAKER_V4
 *
 * Combines ATR trailing (dynamic) with step floors (guaranteed minimum).
 * SL NEVER moves backwards.
 *
 * ATR trailing: SL at 1.2 × ATR distance from mark price
 * Step floors: At +1R → SL at BE, At +2R → SL at +1R, At +3R → SL at +2R
 * Final SL = MAX(atr_trailing, step_floor, current_sl)
 */

const config = require('../config/tradingDefaults');
const log = require('../utils/logger')('TrailingStop');

/**
 * Calculate new trailing SL for an open position
 *
 * @param {object} position - { entry, currentSL, direction, currentPrice, atr }
 * @param {object} opts - override config.TRAILING
 * @returns {object} { newSL, moved, reason }
 */
function calculateTrailingSL(position, opts = {}) {
  const cfg = { ...config.TRAILING, ...opts };
  if (!cfg.enabled) return { newSL: position.currentSL, moved: false, reason: 'disabled' };

  const { entry, currentSL, direction, currentPrice, atr } = position;
  const dir = (direction || 'long').toLowerCase();
  const risk = Math.abs(entry - currentSL);
  if (risk <= 0 || !entry || !currentPrice) {
    return { newSL: currentSL, moved: false, reason: 'invalid position data' };
  }

  // Current R (how many R in profit)
  const currentR = dir === 'long'
    ? (currentPrice - entry) / risk
    : (entry - currentPrice) / risk;

  // 1. ATR Trailing SL
  const atrDist = (atr || risk) * (cfg.atrMult || 1.2);
  const atrSL = dir === 'long'
    ? currentPrice - atrDist
    : currentPrice + atrDist;

  // 2. Step Floor SL (find the highest triggered step)
  let stepFloorSL = dir === 'long' ? -Infinity : Infinity;
  const steps = cfg.steps || config.TRAILING.steps;

  for (const step of steps) {
    if (currentR >= step.triggerR) {
      const floorPrice = dir === 'long'
        ? entry + risk * step.floorR
        : entry - risk * step.floorR;
      if (dir === 'long') {
        stepFloorSL = Math.max(stepFloorSL, floorPrice);
      } else {
        stepFloorSL = Math.min(stepFloorSL, floorPrice);
      }
    }
  }

  // 3. Take the BEST (most protective) of ATR and Step Floor
  let newSL;
  if (dir === 'long') {
    newSL = Math.max(atrSL, stepFloorSL);
    // NEVER move SL backwards
    newSL = Math.max(newSL, currentSL);
  } else {
    newSL = Math.min(atrSL, stepFloorSL);
    // NEVER move SL backwards (for short, lower is worse)
    newSL = Math.min(newSL, currentSL);
  }

  const moved = Math.abs(newSL - currentSL) > 0.0001;
  const reason = moved
    ? `SL moved to ${newSL.toFixed(6)} (${currentR.toFixed(1)}R, ${atrSL > stepFloorSL ? 'ATR' : 'step floor'})`
    : 'no change';

  return {
    newSL: +newSL.toFixed(8),
    moved,
    reason,
    currentR: +currentR.toFixed(2),
    atrSL: +atrSL.toFixed(8),
    stepFloorSL: stepFloorSL === -Infinity || stepFloorSL === Infinity ? null : +stepFloorSL.toFixed(8),
  };
}

module.exports = { calculateTrailingSL };
