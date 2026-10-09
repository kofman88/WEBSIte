/**
 * paymentWatcher.js — auto-confirm crypto payments on-chain.
 *
 * Каждые WATCH_INTERVAL_MS обходит все pending-платежи (USDT BEP20/TRC20)
 * и спрашивает у публичных explorer-API (BscScan / Tronscan) пришли ли
 * входящие переводы на наш адрес с суммой, совпадающей с инвойсом
 * (±1% толерантность — заложено в paymentService.confirmCryptoPayment).
 *
 * Что НЕ требуется:
 *   - API-ключи: оба explorer'а отдают первые ~5 req/sec без auth.
 *     Нам этого хватает с большим запасом.
 *   - WebSocket к ноде: для платёжек 1-15-минутный poll достаточен.
 *   - Свой полный нод: explorer-API уже даёт finality.
 *
 * Что зашито в дизайн:
 *   - Идемпотентность: confirmCryptoPayment делает status='confirmed' и
 *     дальше игнорирует вторые вызовы. Безопасно если watcher тиктнет
 *     второй раз пока tx ещё в pending.
 *   - Одна транзакция — один инвойс: tx, чей hash уже записан в payments.provider_tx_id, больше
 *     ничего не подтверждает (раньше каждая pending-строка искала себе tx в последних 50 переводах
 *     сама, и один платёж мог активировать несколько инвойсов — в т.ч. чужих).
 *   - Однозначность: инвойсы различаются только центами (paymentService._uniqueAmount), а ±1% —
 *     это ±0.69 USDT на месячном и ±6.6 USDT на годовом (69 × 12 × 0.8 = 662.4): весь диапазон
 *     центов годовых инвойсов. Поэтому сначала точное совпадение суммы (до цента); допуск ±1%
 *     применяется, только если в окне ровно один подходящий инвойс этой сети. Неоднозначный перевод
 *     не подтверждает ничего — его разбирает админ (лог «ambiguous»).
 *   - Окно валидности: payments.expires_at = created_at + 1 час
 *     (PENDING_TOLERANCE_SEC). Транзакции старше — игнорируем.
 *   - Только USDT. Получили нативный BNB или TRX без token-transfer —
 *     не наше, ничего не трогаем.
 *
 * Endpoints (без ключей):
 *   - BSC:    https://api.bscscan.com/api?module=account&action=tokentx
 *             &contractaddress=<USDT_BEP20>&address=<our_addr>
 *             &startblock=0&endblock=99999999&sort=desc
 *   - TRON:   https://apilist.tronscanapi.com/api/transfer/trc20
 *             ?relatedAddress=<our_addr>&toAddress=<our_addr>
 *             &start=0&limit=50&direction=in
 *
 * USDT contract addresses:
 *   BEP20: 0x55d398326f99059fF775485246999027B3197955  (18 decimals)
 *   TRC20: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t            (6 decimals)
 */

const db = require('../models/database');
const config = require('../config');
const paymentService = require('../services/paymentService');
const logger = require('../utils/logger');

const WATCH_INTERVAL_MS = Number(process.env.PAYMENT_WATCHER_MS) || 30_000;
const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const TOLERANCE_PCT = 0.01;

let timer = null;
let inflight = false;

function _within(amount, invoiced) {
  if (!Number.isFinite(amount) || !Number.isFinite(invoiced) || invoiced <= 0) return false;
  const diff = (amount - invoiced) / invoiced;
  return diff >= -TOLERANCE_PCT && diff <= TOLERANCE_PCT;
}

async function _fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(id); }
}

async function _bscRecent(address) {
  const url = 'https://api.bscscan.com/api?module=account&action=tokentx'
    + '&contractaddress=' + USDT_BEP20_CONTRACT
    + '&address=' + address
    + '&startblock=0&endblock=99999999&sort=desc';
  const j = await _fetchJson(url);
  if (!j || j.status !== '1' || !Array.isArray(j.result)) return [];
  return j.result.map((tx) => ({
    txHash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: Number(tx.value) / 1e18,
    timestamp: Number(tx.timeStamp) * 1000,
  })).filter((t) => t.to && t.to.toLowerCase() === address.toLowerCase());
}

async function _tronRecent(address) {
  const url = 'https://apilist.tronscanapi.com/api/transfer/trc20'
    + '?relatedAddress=' + address
    + '&toAddress=' + address
    + '&start=0&limit=50&direction=in';
  const j = await _fetchJson(url);
  if (!j || !Array.isArray(j.token_transfers)) return [];
  return j.token_transfers
    .filter((t) => t.tokenInfo && t.tokenInfo.tokenAbbr === 'USDT')
    .map((t) => ({
      txHash: t.transaction_id,
      from: t.from_address,
      to: t.to_address,
      value: Number(t.quant) / 1e6,
      timestamp: Number(t.block_ts || 0),
    }));
}

function _pendingPayments() {
  // Live invoice still in window. We use INSTR on metadata to avoid
  // pulling JSON parsing into SQL — `metadata` is JSON-serialized.
  return db.prepare(`
    SELECT id, user_id, amount_usd, method, plan, duration_days, metadata, created_at
      FROM payments
     WHERE status = 'pending'
       AND method IN ('usdt_bep20', 'usdt_trc20')
       AND created_at > datetime('now', '-1 hour')
     ORDER BY created_at DESC
  `).all();
}

async function tickOnce() {
  if (inflight) return; // skip overlapping ticks
  inflight = true;
  try {
    const pending = _pendingPayments();
    if (!pending.length) return;
    // Group by network: 1 explorer call per network per tick covers
    // every pending invoice without N×explorer round-trips.
    const need = { bep20: false, trc20: false };
    for (const p of pending) {
      if (p.method === 'usdt_bep20' && config.paymentBep20Address) need.bep20 = true;
      if (p.method === 'usdt_trc20' && config.paymentTrc20Address) need.trc20 = true;
    }
    const recent = { bep20: [], trc20: [] };
    if (need.bep20) {
      try { recent.bep20 = await _bscRecent(config.paymentBep20Address); }
      catch (err) { logger.warn('bsc explorer fetch failed', { err: err.message }); }
    }
    if (need.trc20) {
      try { recent.trc20 = await _tronRecent(config.paymentTrc20Address); }
      catch (err) { logger.warn('tron explorer fetch failed', { err: err.message }); }
    }
    for (const net of ['bep20', 'trc20']) {
      const invoices = pending.filter((p) => p.method === 'usdt_' + net);
      const txs = (recent[net] || []).filter((t) => t && t.txHash && Number.isFinite(t.value) && t.value > 0);
      for (const { payment: p, tx: match } of matchTransfers(invoices, txs)) {
        try {
          paymentService.confirmCryptoPayment(p.id, {
            txHash: match.txHash,
            fromAddress: match.from,
            amountUsdt: match.value,
          });
          logger.info('crypto payment auto-confirmed', {
            paymentId: p.id, userId: p.user_id, plan: p.plan, network: net,
            txHash: match.txHash, amountUsdt: match.value,
          });
        } catch (err) {
          // confirmCryptoPayment throws UNDERPAID/OVERPAID etc — log and
          // leave pending (admin can resolve manually).
          logger.warn('auto-confirm failed', { paymentId: p.id, err: err.message });
        }
      }
    }
  } catch (err) {
    logger.error('paymentWatcher tick error', { err: err.message });
  } finally {
    inflight = false;
  }
}

const createdMsOf = (p) => new Date(String(p.created_at).replace(' ', 'T') + 'Z').getTime() || Date.now() - 3600_000;
const sameCents = (a, b) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) === 0;
const usedTx = (hash) => Boolean(db.prepare('SELECT 1 FROM payments WHERE provider_tx_id = ? LIMIT 1').get(hash));

/**
 * Pairs { payment, tx } to confirm: each transfer pays at most one invoice and each invoice is paid
 * by at most one transfer; a transfer already recorded on a payment pays nothing again. A transfer
 * matches an invoice of its network created at most 60 s after it was sent: the one with exactly its
 * amount (to the cent) — or, when no invoice has that amount, the only invoice within ±1%. Two or
 * more candidates either way → ambiguous, nothing is confirmed.
 */
function matchTransfers(invoices, txs) {
  const out = [];
  const taken = new Set();
  const ordered = txs.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const seen = new Set();
  for (const t of ordered) {
    if (seen.has(t.txHash)) continue;
    seen.add(t.txHash);
    if (usedTx(t.txHash)) continue;
    const open = invoices.filter((p) => !taken.has(p.id) && t.timestamp >= createdMsOf(p) - 60_000);
    const exact = open.filter((p) => sameCents(t.value, Number(p.amount_usd)));
    let pick = null;
    if (exact.length === 1) pick = exact[0];
    else if (exact.length === 0) {
      const near = open.filter((p) => _within(t.value, Number(p.amount_usd)));
      if (near.length === 1) pick = near[0];
      else if (near.length > 1) logger.warn('crypto transfer ambiguous: several invoices within tolerance', { txHash: t.txHash, amountUsdt: t.value, invoices: near.map((p) => p.id) });
    } else {
      logger.warn('crypto transfer ambiguous: several invoices with this exact amount', { txHash: t.txHash, amountUsdt: t.value, invoices: exact.map((p) => p.id) });
    }
    if (pick) { taken.add(pick.id); out.push({ payment: pick, tx: t }); }
  }
  return out;
}

function start() {
  if (timer) return;
  // First tick after a small delay so server boot isn't blocked.
  setTimeout(tickOnce, 5_000);
  timer = setInterval(tickOnce, WATCH_INTERVAL_MS);
  logger.info('paymentWatcher started', { intervalMs: WATCH_INTERVAL_MS });
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, _tickOnce: tickOnce, matchTransfers };
