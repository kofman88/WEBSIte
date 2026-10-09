/**
 * Adversarial three-scanner differential: the bot's REAL LEVELS (scanner_mid.MidScanner._cycle),
 * SMC (smc.scanner._scan_cycle) and VOLUME (volume_scanner._scan_cycle) cycles, sharing one
 * signal_registry / free_report / confluence / freshness / momentum / trend monitor / candle
 * cache / REST fetcher like bot.py, ran 19 consecutive ticks (2025-12-30 05:45 → 2025-12-31 23:00,
 * across the free 6-13 / 13-21 windows, the last-hour relax and two evening reports) over a
 * mutated golden market (gaps, flat bars, spikes, short / lagging histories, unlisted and
 * REST-failing symbols) with 29 users (23 randomized + 6 hand-made edge cases; py/adv_drive.py, seed 917331 →
 * fixtures/adv_scan.json.gz). The site's modules (adv_replay.js) replay the same script and must
 * reproduce everything observable (adv_compare.js): every delivery byte for byte (text, parse
 * mode, keyboard, protect / silent), every INFO+ log line in order, REST calls, charts,
 * auto-trade calls, metrics, smart prompts, sleeps, inserted trade ids, the persisted registry,
 * and per tick every signal_trades row (shared columns), trade_events, kv, trader_settings,
 * optimizer_params and the scanner / pipeline state.
 *
 *   Python: cd <bot> && PYTHONDONTWRITEBYTECODE=1 BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/scanners/adv/py/adv_drive.py      (~2 min)
 *
 * Not differences (adv_compare.js): the SMC background card tasks' effects (sends, auto-trade
 * calls, charts, their log lines) as multisets — the bot interleaves them freely; a registry
 * file saved inside the SMC step is checked for consistency, not entry by entry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9b-adv-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'adv-scan.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const { loadFixture, replay } = req('./adv_replay.js');
const { compare } = req('./adv_compare.js');
const { families } = req('./adv_families.js');
const FIX = loadFixture(path.join(__dirname, 'fixtures', 'adv_scan.json.gz'));

let run = null;
let result = null;

beforeAll(async () => {
  run = await replay(FIX);
  result = compare(FIX.expected, run.out, { limit: 50 });
}, 600_000);

afterAll(() => {
  req('../../../../services/engine/tradeCfg.js').setLog(null);
  req('../../../../services/engine/smcUserCfg.js').setLog(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ }
});

describe('adversarial LEVELS + SMC + VOLUME differential vs the bot (adv_drive.py)', () => {
  it('rebuilds the same mutated market (sha1 of every series)', () => {
    const bad = Object.keys(FIX.market_digest).filter((k) => FIX.market_digest[k] !== run.digest[k]);
    expect(bad).toEqual([]);
  });

  it('replays every tick and step', () => {
    expect(run.out.length).toBe(FIX.expected.length);
    expect(run.out.map((t) => t.steps.map((s) => s.step))).toEqual(FIX.expected.map((t) => t.steps.map((s) => s.step)));
  });

  it('compares the rows on the shared columns', () => {
    expect(result.tradeCols.length).toBeGreaterThanOrEqual(50);
    expect(result.userCols.length).toBeGreaterThanOrEqual(60);
  });

  it('reproduces every observable effect (zero differences)', () => {
    expect(result.diffs).toEqual([]);
  });

  it('covers every adversarial scenario family', () => {
    const fam = families(FIX);
    for (const [name, n] of Object.entries(fam)) expect([name, n > 0]).toEqual([name, true]);
  });
});
