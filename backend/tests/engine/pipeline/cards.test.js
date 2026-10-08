/**
 * Card snapshots pinned to the bot: the JS engines' signal objects on golden fixtures
 * (fixtures/card_signals.json, tools/dumpCardSignals.js) rendered by the bot's own card
 * functions (fixtures/cards.json, tools/gen_cards.py — scanner_mid.signal_text,
 * smc.scanner._signal_text_smc / _maybe_append_smc_sl_warning / _smc_keyboard,
 * volume_scanner.signal_text, signal_format.format_signal_lite,
 * scanner_mid.signal_compact_keyboard / trade_records_keyboard, position_size.position_line,
 * watermark.wm_inject, signal_confluence.get_confluence_label) under six BTC trend states.
 * Every string must be byte-identical.
 *
 * Regenerate:
 *   node tests/engine/pipeline/tools/dumpCardSignals.js
 *   cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
 *     <venv>/bin/python <site>/backend/tests/engine/pipeline/tools/gen_cards.py
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const levels = req('../../../services/engine/cards/levels.js');
const smc = req('../../../services/engine/cards/smc.js');
const volume = req('../../../services/engine/cards/volume.js');
const lite = req('../../../services/engine/cards/lite.js');
const kb = req('../../../services/engine/cards/keyboards.js');
const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
const { positionLine } = req('../../../services/engine/positionLine.js');
const { wmInject } = req('../../../services/engine/watermark.js');

const FIX = path.join(process.cwd(), 'tests', 'engine', 'pipeline', 'fixtures');
const SIGNALS = JSON.parse(fs.readFileSync(path.join(FIX, 'card_signals.json'), 'utf8'));
const CARDS = JSON.parse(fs.readFileSync(path.join(FIX, 'cards.json'), 'utf8'));

const quietLog = { debug() {}, info() {}, warning() {}, error() {} };
const monitors = CARDS.scenarios.map((sc) => {
  const m = createTrendMonitor({ env: {}, kv: null, log: quietLog });
  m._seed(sc.trend, sc.strength);
  return m;
});

const tg = (rows) => kb.toTelegram(rows).inline_keyboard;

describe('LEVELS cards (bot strings)', () => {
  it.each(CARDS.levels.map((c, i) => [i, c.source, c]))('#%i %s', (idx, _src, c) => {
    const sig = { ...SIGNALS.levels[idx].signal, ...c.mutation };
    const trend = monitors[c.scenario];
    for (const lang of ['ru', 'en']) {
      expect(levels.signalText(sig, { timeframe: c.timeframe }, lang, { trend })).toBe(c.out[`full_${lang}`]);
      expect(lite.formatSignalLite({
        symbol: sig.symbol, direction: sig.direction, quality: sig.quality, entry: sig.entry, sl: sig.sl,
        tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: 'LEVELS', lang, qualityScale: 10,
      })).toBe(c.out[`lite_${lang}`]);
      expect(tg(kb.signalCompactKeyboard(`777_${idx}`, sig.symbol, {
        showTradeBtn: idx % 2 === 0, isCounterTrend: Boolean(sig.is_counter_trend), isAutoTraded: idx % 4 === 1, lang,
      }))).toEqual(c.out[`kb_${lang}`]);
    }
  });
  it('trade_records_keyboard', () => {
    expect(tg(kb.tradeRecordsKeyboard('777_1'))).toEqual(CARDS.trade_records_kb);
  });
});

describe('SMC cards (bot strings)', () => {
  it.each(CARDS.smc.map((c, i) => [i, c.source, c]))('#%i %s', (idx, _src, c) => {
    const sig = { ...SIGNALS.smc[idx].signal, ...c.mutation };
    const trend = monitors[c.scenario];
    const conf = createSignalConfluence({ now: () => 1_800_000_000 });
    for (const s of c.confluence_others) conf.recordSignal(sig.symbol, sig.direction, s, 3);
    for (const lang of ['ru', 'en']) {
      const raw = smc.signalTextSmc(sig, c.fund_block, lang, { trend });
      expect(raw).toBe(c.out[`full_${lang}`]);
      const q = sig.score || sig.quality || 0;
      const liteText = lite.formatSignalLite({
        symbol: sig.symbol, direction: sig.direction, quality: q, entry: sig.entry, sl: sig.sl,
        tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: 'SMC', lang,
      });
      expect(liteText).toBe(c.out[`lite_${lang}`]);
      const pl = positionLine(c.user, sig.entry, sig.sl, lang, c.ctx, { balance: c.balance, ctxRiskMult: trend.ctxRiskMult, ctxLabel: trend.ctxLabel });
      const label = conf.getConfluenceLabel(sig.symbol, sig.direction, 'SMC');
      for (const [kind, base] of [['assembled', raw], ['assembled_lite', liteText]]) {
        expect(smc.assemble(base, sig, c.user, lang, { userId: c.user.user_id, positionLine: pl, confluenceLabel: label }))
          .toBe(c.out[`${kind}_${lang}`]);
      }
      expect(tg(kb.smcKeyboard(sig.symbol, idx % 7 ? `555_${idx}` : '', {
        showTradeBtn: idx % 2 === 0, isAutoTraded: idx % 3 === 1, lang,
      }))).toEqual(c.out[`kb_${lang}`]);
    }
  });
});

describe('VOLUME cards (bot strings)', () => {
  it.each(CARDS.volume.map((c, i) => [i, c.source, c]))('#%i %s', (idx, _src, c) => {
    const sig = { ...SIGNALS.volume[idx].signal, ...c.mutation };
    const trend = monitors[c.scenario];
    for (const lang of ['ru', 'en', 'de']) {
      expect(volume.signalText(sig, lang, { trend })).toBe(c.out[`full_${lang}`]);
    }
    for (const lang of ['ru', 'en']) {
      expect(lite.formatSignalLite({
        symbol: sig.symbol, direction: sig.direction, quality: Math.trunc(sig.quality), entry: sig.entry, sl: sig.sl,
        tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: 'VOLUME', lang,
      })).toBe(c.out[`lite_${lang}`]);
      expect(tg(kb.signalCompactKeyboard(`9_vol_${idx}`, sig.symbol, {
        showTradeBtn: idx % 3 === 0, isAutoTraded: idx % 2 === 1, lang,
      }))).toEqual(c.out[`kb_${lang}`]);
    }
  });
});

describe('i18n entries copied by the card modules', () => {
  const tables = { ...kb.MESSAGES, ...smc.MESSAGES, ...levels.MESSAGES };
  it.each(Object.keys(CARDS.i18n))('%s', (key) => {
    expect(tables[key]).toBeDefined();
    expect({ ru: tables[key].ru, en: tables[key].en }).toEqual(CARDS.i18n[key]);
  });
});

describe('watermark on assembled cards', () => {
  it('an assembled SMC card carries the uid', () => {
    const c = CARDS.smc[0];
    const { wmDecode } = req('../../../services/engine/watermark.js');
    expect(wmDecode(c.out.assembled_ru)).toBe(c.user.user_id);
    expect(wmInject('x', 5).length).toBe(41);
  });
});
