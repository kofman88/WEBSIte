/**
 * publicTrack/view.js — the public state of one paper signal at view time V: signalOutcome's
 * status / R on the tracker view (result cleared), the landing's statuses and paths, R after the
 * fee estimate, and the sanitising helpers. Pure, no DB.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const view = require('../../services/publicTrack/view.js');
const { signalStatus, signalRr } = require('../../services/engine/signalOutcome.js');
const { FEES } = require('../../services/publicTrack/config.js');

const T0 = 1_760_000_000;
const V = T0 + 10 * 3600;
// LONG 100 → SL 98 (risk 2 %), TP 103 / 105 / 108 → planned R 1.5 / 2.5 / 4
const ROW = Object.freeze({
  trade_id: '7_1760000000000_123', user_id: 7, symbol: 'BTC-USDT-SWAP', direction: 'LONG',
  entry: 100, sl: 98, original_sl: null, tp1: 103, tp2: 105, tp3: 108, timeframe: '1h', strategy: 'LEVELS',
  created_at: T0, signal_msg_id: 11, progress_stage: '', progress_ts: 0, order_id: '', expire_rr: null, result: '',
});
const FEE = (0.12 + 0.1) / 2;   // 0.11 R
const st = (...pairs) => pairs.map(([s, t]) => ({ s, t }));

describe('fee estimate (the backtester model without in-simulation slippage)', () => {
  it('fee_r = (0.12 + 0.10) / risk %, clamped to [0, 0.5]', () => {
    expect(FEES).toMatchObject({ round_trip_pct: 0.12, slippage_pct: 0.1, max_r: 0.5 });
    expect(view.feeR(ROW)).toBeCloseTo(FEE, 12);
    expect(view.feeR({ ...ROW, sl: 99 })).toBeCloseTo(0.22, 12);                 // 1 % risk
    expect(view.feeR({ ...ROW, sl: 99.9 })).toBe(0.5);                            // 0.1 % risk → 2.2 R → clamp
    expect(view.feeR({ ...ROW, sl: 90 })).toBeCloseTo(0.022, 12);
    expect(view.feeR({ ...ROW, original_sl: 96, sl: 100 })).toBeCloseTo(0.055, 12); // original stop first (sl0)
    expect(view.feeR({ ...ROW, entry: 0 })).toBeCloseTo(0.22, 12);                // no risk known → 1 %
  });
});

describe('public status / path / r at V (tracker view of signalOutcome)', () => {
  const cases = [
    ['no stage yet', [], 'open', ['open'], null, 'open'],
    ['zone touched (ENTRY)', st(['ENTRY', T0 + 60]), 'open', ['open'], null, 'open'],
    ['TP1, stop at break-even', st(['TP1', T0 + 3600]), 'tp1', ['open', 'tp1'], null, 'tp1'],
    ['TP2 still running → tp1 with tp2 on the path', st(['TP1', T0 + 3600], ['TP2', T0 + 7200]), 'tp1', ['open', 'tp1', 'tp2'], null, 'tp2'],
    ['TP3', st(['TP1', T0 + 3600], ['TP3', T0 + 7200]), 'tp3', ['open', 'tp1', 'tp2', 'tp3'], 4 - FEE, 'tp3'],
    ['SL', st(['SL', T0 + 3600]), 'sl', ['open', 'sl'], -1 - FEE, 'sl'],
    ['BE after TP1', st(['TP1', T0 + 3600], ['BE', T0 + 7200]), 'tp1be', ['open', 'tp1', 'be'], -FEE, 'be'],
    ['BE after TP2', st(['TP1', T0 + 3600], ['TP2', T0 + 5000], ['BE', T0 + 7200]), 'tp2be', ['open', 'tp1', 'tp2', 'be'], -FEE, 'be'],
    ['BE seen without its TP1 (implied)', st(['BE', T0 + 7200]), 'tp1be', ['open', 'tp1', 'be'], -FEE, 'be'],
    ['TP2 then BE in one observation (TP2 lost) → tp1be', st(['TP1', T0 + 60], ['BE', T0 + 7200]), 'tp1be', ['open', 'tp1', 'be'], -FEE, 'be'],
    ['MISSED (zone never filled)', st(['MISSED', T0 + 4000]), 'missed', ['open', 'missed'], null, 'missed'],
  ];
  for (const [name, stages, status, path, r, raw] of cases) {
    it(name, () => {
      const s = view.publicState(ROW, stages, V);
      expect(s.raw).toBe(raw);
      expect(s.status).toBe(status);
      expect(s.path).toEqual(path);
      if (r === null) expect(s.r).toBeNull();
      else expect(s.r).toBeCloseTo(r, 9);
    });
  }

  it('EXPIRED: the mark-to-market R minus fees; the TPs seen before it stay on the path', () => {
    const row = { ...ROW, expire_rr: 0.734 };
    const a = view.publicState(row, st(['EXPIRED', T0 + 72 * 3600]), T0 + 80 * 3600);
    expect(a).toMatchObject({ status: 'exp', path: ['open', 'exp'] });
    expect(a.r).toBe(0.62);                        // round(0.73 − 0.11, 2): signal_rr rounds expire_rr to 2 first
    const b = view.publicState(row, st(['TP1', T0 + 3600], ['EXPIRED', T0 + 72 * 3600]), T0 + 80 * 3600);
    expect(b).toMatchObject({ status: 'exp', path: ['open', 'tp1', 'exp'] });
  });

  it('older than 72 h without a tracker stage: expired by age, no R (signal_status rule 10)', () => {
    const s = view.publicState(ROW, [], T0 + 73 * 3600);
    expect(s).toMatchObject({ raw: 'expired', status: 'exp', path: ['open', 'exp'], r: null });
  });

  it('a stage observed after V is not shown yet (the track as of now − 60 min)', () => {
    const stages = st(['TP1', T0 + 3600], ['BE', T0 + 7200]);
    expect(view.publicState(ROW, stages, T0 + 3599).status).toBe('open');
    expect(view.publicState(ROW, stages, T0 + 3600).status).toBe('tp1');
    expect(view.publicState(ROW, stages, T0 + 7199).status).toBe('tp1');
    expect(view.publicState(ROW, stages, T0 + 7200).status).toBe('tp1be');
  });

  it('ignores manual results, ghost SKIPs and stored result_rr: only the tracker stage counts', () => {
    const stages = st(['SL', T0 + 3600]);
    for (const extra of [
      { result: 'TP3', result_rr: 4 }, { result: 'SKIP', skip_reason: 'manual' }, { result: 'SKIP', skip_reason: 'ghost' },
      { result: 'MANUAL', result_rr: 9.9 },
    ]) {
      const s = view.publicState({ ...ROW, ...extra }, stages, V);
      expect(s.status).toBe('sl');
      expect(s.r).toBeCloseTo(-1 - FEE, 9);
    }
  });

  it('equals signalOutcome on the same tracker view (status and planned R)', () => {
    for (const stage of ['', 'ENTRY', 'TP1', 'TP2', 'TP3', 'SL', 'BE', 'EXPIRED', 'MISSED']) {
      const viewRow = { ...ROW, result: '', progress_stage: stage, expire_rr: stage === 'EXPIRED' ? -0.4 : null };
      const raw = signalStatus(viewRow, V);
      const s = view.publicState({ ...ROW, expire_rr: -0.4 }, stage ? st([stage, T0 + 100]) : [], V);
      expect(s.raw).toBe(raw);
      const rr = signalRr(viewRow, raw);
      if (view.isFinal(s.status)) expect(s.r).toBeCloseTo(rr - FEE, 9);
      else expect(s.r).toBeNull();
    }
  });

  it('SHORT signals use the same rules', () => {
    const row = { ...ROW, direction: 'SHORT', entry: 100, sl: 102, tp1: 97, tp2: 95, tp3: 92 };
    const s = view.publicState(row, st(['TP1', T0 + 1], ['TP3', T0 + 2]), V);
    expect(s.status).toBe('tp3');
    expect(s.r).toBeCloseTo(4 - FEE, 9);
  });
});

describe('stageAt', () => {
  it('implied stages: TP2 / TP3 / BE imply TP1, TP3 implies TP2', () => {
    expect([...view.stageAt(st(['TP3', 1]), 5).reached].sort()).toEqual(['TP1', 'TP2', 'TP3']);
    expect([...view.stageAt(st(['BE', 1]), 5).reached].sort()).toEqual(['BE', 'TP1']);
    expect(view.stageAt(st(['TP1', 1], ['TP2', 9]), 5)).toMatchObject({ stage: 'TP1' });
    expect(view.stageAt([], 5)).toMatchObject({ stage: '' });
  });
});

describe('helpers: nothing unsafe or private reaches the payload', () => {
  it('pair / tf / side / strategy', () => {
    expect(view.baseOf('BTC-USDT-SWAP')).toBe('BTC');
    expect(view.baseOf('1000PEPE-USDT')).toBe('1000PEPE');
    expect(view.baseOf('<img src=x>-USDT-SWAP')).toBe('imgsrcx');
    expect(['15m', '30m', '1h', '4h', '1d', '', null].map(view.tfOf)).toEqual(['15m', '30m', '1H', '4H', '1D', '1H', '1H']);
    expect(view.sideOf('long')).toBe('LONG');
    expect(view.sideOf('buy')).toBeNull();
    expect(view.strategyOf('smc')).toBe('SMC');
    expect(view.strategyOf('GERCHIK')).toBeNull();
  });

  it('publicId is opaque and stable: no user id, no trade id', () => {
    const a = view.publicId('7_1760000000000_123', 'secret-a');
    expect(a).toMatch(/^s[A-Za-z0-9_-]{12}$/);
    expect(view.publicId('7_1760000000000_123', 'secret-a')).toBe(a);
    expect(view.publicId('7_1760000000000_123', 'secret-b')).not.toBe(a);
    expect(a).not.toContain('7_');
    expect(a).not.toContain('1760000000000');
  });
});
