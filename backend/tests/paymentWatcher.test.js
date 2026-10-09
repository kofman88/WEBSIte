import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// workers/paymentWatcher.js confirms USDT invoices from the explorers' transfer lists. Invoices of
// one network differ only by their cents (paymentService._uniqueAmount), while the ±1% tolerance is
// ±0.69 USDT on a monthly invoice and ±6.6 USDT on a yearly one (662.4 + cents): every yearly invoice
// was within tolerance of every yearly transfer, and each pending invoice looked for "its" transfer
// in the last 50 on its own — one payment could confirm several invoices, other users' included.
// Now: one transfer pays one invoice, the exact amount first, the tolerance only when unambiguous.

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-payment-watcher.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.PAYMENT_BEP20_ADDRESS = '0x00000000000000000000000000000000000b5c20';
process.env.PAYMENT_TRC20_ADDRESS = 'TWatcherTestDepositAddress0000000';

let db, pay, watcher, authService;
beforeAll(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  db = require('../models/database');
  pay = require('../services/paymentService');
  watcher = require('../workers/paymentWatcher');
  authService = require('../services/authService');
});
let n = 0;
async function user() { n += 1; return (await authService.register({ email: `w${n}@x.com`, password: 'Abcdef123' })).user.id; }
beforeEach(() => {
  for (const t of ['payments', 'subscriptions', 'audit_log', 'notifications', 'email_outbox']) { try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_e) { /* absent */ } }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// the explorers' answers for a list of transfers { hash, value (USDT), ts (ms) }
function explorers({ trc20 = [], bep20 = [] }) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    let body;
    if (u.startsWith('https://apilist.tronscanapi.com/')) {
      body = { token_transfers: trc20.map((t) => ({ transaction_id: t.hash, from_address: 'Tpayer', to_address: process.env.PAYMENT_TRC20_ADDRESS, quant: String(Math.round(t.value * 1e6)), block_ts: t.ts, tokenInfo: { tokenAbbr: 'USDT' } })) };
    } else if (u.startsWith('https://api.bscscan.com/')) {
      body = { status: '1', result: bep20.map((t) => ({ hash: t.hash, from: '0xpayer', to: process.env.PAYMENT_BEP20_ADDRESS, value: (BigInt(Math.round(t.value * 100)) * 10n ** 16n).toString(), timeStamp: String(Math.floor(t.ts / 1000)) })) };
    } else throw new Error('unexpected fetch ' + u);
    return { ok: true, status: 200, json: async () => body };
  }));
}
const row = (id) => db.prepare('SELECT status, provider_tx_id, duration_days, amount_usd FROM payments WHERE id = ?').get(id);
const expiresInDays = (uid) => Math.round((Date.parse(db.prepare('SELECT expires_at FROM subscriptions WHERE user_id = ?').get(uid).expires_at) - Date.now()) / 86_400_000);

describe.each(['trc20', 'bep20'])('%s: one transfer pays one invoice', (network) => {
  const tx = (hash, value, ts = Date.now() + 1000) => ({ [network]: [{ hash, value, ts }] });

  it('yearly: the payer\'s invoice is confirmed for 365 days; another user\'s yearly invoice stays pending, on every tick', async () => {
    const a = await user(), b = await user();
    const ia = pay.createCryptoPayment(a, { plan: 'pro', network, billingCycle: 'yearly' });
    const ib = pay.createCryptoPayment(b, { plan: 'pro', network, billingCycle: 'yearly' });
    expect(ia.amountUsdt).not.toBe(ib.amountUsdt);
    expect(Math.abs(ia.amountUsdt - ib.amountUsdt) / ib.amountUsdt).toBeLessThan(0.01);   // within the old ±1% of each other
    explorers(tx('0xA1' + network, ia.amountUsdt));
    await watcher._tickOnce();
    await watcher._tickOnce();
    expect(row(ia.paymentId)).toMatchObject({ status: 'confirmed', provider_tx_id: '0xA1' + network, duration_days: 365 });
    expect(row(ib.paymentId)).toMatchObject({ status: 'pending', provider_tx_id: null });
    expect(expiresInDays(a)).toBe(365);
    expect(db.prepare('SELECT plan, expires_at FROM subscriptions WHERE user_id = ?').get(b) || {}).not.toMatchObject({ plan: 'pro' });
  });

  it('monthly next to yearly: each transfer to its own invoice, 30 and 365 days', async () => {
    const a = await user(), b = await user();
    const m = pay.createCryptoPayment(a, { plan: 'pro', network, billingCycle: 'monthly' });
    const y = pay.createCryptoPayment(b, { plan: 'pro', network, billingCycle: 'yearly' });
    explorers({ [network]: [{ hash: '0xM' + network, value: m.amountUsdt, ts: Date.now() + 1000 }, { hash: '0xY' + network, value: y.amountUsdt, ts: Date.now() + 2000 }] });
    await watcher._tickOnce();
    expect(row(m.paymentId)).toMatchObject({ status: 'confirmed', provider_tx_id: '0xM' + network, duration_days: 30 });
    expect(row(y.paymentId)).toMatchObject({ status: 'confirmed', provider_tx_id: '0xY' + network, duration_days: 365 });
    expect([expiresInDays(a), expiresInDays(b)]).toEqual([30, 365]);
  });

  it('an inexact amount within ±1%: accepted only when one invoice could be meant', async () => {
    const a = await user(), b = await user();
    const ia = pay.createCryptoPayment(a, { plan: 'pro', network, billingCycle: 'yearly' });
    const ib = pay.createCryptoPayment(b, { plan: 'pro', network, billingCycle: 'yearly' });
    explorers(tx('0xU' + network, 660.0));            // a wallet fee off the gross: whose?
    await watcher._tickOnce();
    expect([row(ia.paymentId).status, row(ib.paymentId).status]).toEqual(['pending', 'pending']);
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('expired', ib.paymentId);
    await watcher._tickOnce();
    expect(row(ia.paymentId)).toMatchObject({ status: 'confirmed', provider_tx_id: '0xU' + network });
  });

  it('a transfer sent before the invoice existed pays nothing; a used transfer never pays again', async () => {
    const a = await user();
    const ia = pay.createCryptoPayment(a, { plan: 'pro', network, billingCycle: 'monthly' });
    explorers(tx('0xOLD' + network, ia.amountUsdt, Date.now() - 10 * 60_000));
    await watcher._tickOnce();
    expect(row(ia.paymentId).status).toBe('pending');
    // a transfer that already paid an invoice: recorded → skipped, and the service refuses it too
    explorers(tx('0xP' + network, ia.amountUsdt));
    await watcher._tickOnce();
    expect(row(ia.paymentId).status).toBe('confirmed');
    const ib = pay.createCryptoPayment(a, { plan: 'pro', network, billingCycle: 'monthly' });
    db.prepare('UPDATE payments SET amount_usd = ? WHERE id = ?').run(ia.amountUsdt, ib.paymentId);   // even with the same amount
    await watcher._tickOnce();
    expect(row(ib.paymentId).status).toBe('pending');
    expect(() => pay.confirmCryptoPayment(ib.paymentId, { txHash: '0xP' + network, amountUsdt: ia.amountUsdt })).toThrow(expect.objectContaining({ code: 'TX_ALREADY_USED' }));
  });

  it('two pending invoices with the same amount (older data): the transfer is ambiguous, nothing is confirmed', async () => {
    const a = await user(), b = await user();
    const ia = pay.createCryptoPayment(a, { plan: 'pro', network, billingCycle: 'monthly' });
    const ib = pay.createCryptoPayment(b, { plan: 'pro', network, billingCycle: 'monthly' });
    db.prepare('UPDATE payments SET amount_usd = ? WHERE id = ?').run(ia.amountUsdt, ib.paymentId);
    explorers(tx('0xDUP' + network, ia.amountUsdt));
    await watcher._tickOnce();
    expect([row(ia.paymentId).status, row(ib.paymentId).status]).toEqual(['pending', 'pending']);
  });
});

describe('paymentService._uniqueAmount: no two pending invoices of a network share their cents', () => {
  it('the same random draw gives the next free cents; another network may reuse them', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const u = await user();
    const a = pay.createCryptoPayment(u, { plan: 'pro', network: 'trc20', billingCycle: 'yearly' });
    const b = pay.createCryptoPayment(u, { plan: 'pro', network: 'trc20', billingCycle: 'yearly' });
    const c = pay.createCryptoPayment(u, { plan: 'pro', network: 'bep20', billingCycle: 'yearly' });
    expect([a.amountUsdt, b.amountUsdt, c.amountUsdt]).toEqual([662.41, 662.42, 662.41]);
    const m = pay.createCryptoPayment(u, { plan: 'pro', network: 'trc20', billingCycle: 'monthly' });
    expect(m.amountUsdt).toBe(69.01);
  });
});
