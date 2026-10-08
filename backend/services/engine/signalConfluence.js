/**
 * signalConfluence — the bot's signal_confluence.py one-to-one (signal-pipeline.md §6.3).
 *
 * Module-level (not per user) cross-strategy confluence: (symbol, direction) →
 * [(strategy, ts, quality)] within CONFLUENCE_WINDOW_S = 1800. Two strategies
 * → "⭐ Confluence ×2", three → "🌟 A++ Confluence ×3". Only the SMC card
 * prepends the label; LEVELS and VOLUME record but never display it.
 */

'use strict';

const CONFLUENCE_WINDOW_S = 1800;   // 30 min — covers 1H scan cycles
const GRADE_DOUBLE = '⭐ Confluence ×2';
const GRADE_TRIPLE = '🌟 A++ Confluence ×3';

const nowSec = () => Date.now() / 1000;

function createSignalConfluence(deps = {}) {
  const now = deps.now || nowSec;
  const recent = new Map();   // "symbol|direction" → [{strategy, ts, quality}]
  const keyOf = (symbol, direction) => `${symbol}|${direction}`;

  function trim(key, t) {
    const cutoff = t - CONFLUENCE_WINDOW_S;
    const items = recent.get(key);
    if (!items || !items.length) return;
    const fresh = items.filter((e) => e.ts >= cutoff);
    if (fresh.length) recent.set(key, fresh); else recent.delete(key);
  }

  const c = {
    CONFLUENCE_WINDOW_S, GRADE_DOUBLE, GRADE_TRIPLE,

    /** record_signal(symbol, direction, strategy, quality=3): latest entry per strategy wins. */
    recordSignal(symbol, direction, strategy, quality = 3) {
      if (!symbol || !direction || !strategy) return;
      const t = now();
      const key = keyOf(symbol, direction);
      let items = (recent.get(key) || []).filter((e) => e.strategy !== strategy);
      const q = quality ? Math.trunc(Number(quality)) : 0;   // int(quality) if quality else 0
      items.push({ strategy, ts: t, quality: Number.isNaN(q) ? 0 : q });
      recent.set(key, items);
      trim(key, t);
    },

    /** get_confluent_strategies(symbol, direction, exclude_strategy) → [{strategy, ts, quality}] */
    getConfluentStrategies(symbol, direction, excludeStrategy = null) {
      if (!symbol || !direction) return [];
      const key = keyOf(symbol, direction);
      trim(key, now());
      let items = (recent.get(key) || []).slice();
      if (excludeStrategy) items = items.filter((e) => e.strategy !== excludeStrategy);
      return items;
    },

    /** get_confluence_label(symbol, direction, current_strategy) → "" | ×2 | ×3 */
    getConfluenceLabel(symbol, direction, currentStrategy = null) {
      const others = c.getConfluentStrategies(symbol, direction, currentStrategy);
      if (!others.length) return '';
      const nTotal = others.length + (currentStrategy ? 1 : 0);
      if (nTotal >= 3) return GRADE_TRIPLE;
      if (nTotal >= 2) return GRADE_DOUBLE;
      return '';
    },

    /** gc_recent(): full sweep, returns the number of keys dropped. */
    gcRecent() {
      const cutoff = now() - CONFLUENCE_WINDOW_S;
      let dropped = 0;
      for (const key of Array.from(recent.keys())) {
        const items = recent.get(key) || [];
        const fresh = items.filter((e) => e.ts >= cutoff);
        if (!fresh.length) { recent.delete(key); dropped++; } else if (fresh.length !== items.length) recent.set(key, fresh);
      }
      return dropped;
    },

    getStats() {
      let total = 0;
      for (const v of recent.values()) total += v.length;
      return { keys: recent.size, entries: total };
    },

    resetForTests() { recent.clear(); },
  };
  return c;
}

const defaultConfluence = createSignalConfluence();

module.exports = {
  CONFLUENCE_WINDOW_S, GRADE_DOUBLE, GRADE_TRIPLE, createSignalConfluence, defaultConfluence,
  recordSignal: (...a) => defaultConfluence.recordSignal(...a),
  getConfluentStrategies: (...a) => defaultConfluence.getConfluentStrategies(...a),
  getConfluenceLabel: (...a) => defaultConfluence.getConfluenceLabel(...a),
  gcRecent: () => defaultConfluence.gcRecent(),
  getStats: () => defaultConfluence.getStats(),
};
