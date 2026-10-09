'use strict';
/**
 * publicTrack/config.js — the knobs of the public paper track (GET /api/public/feed, stats, trend).
 *
 * The honesty rules (docs/PORT_DECISIONS.md Q5, frontend/landing/README.md) fix most of them on
 * purpose: the 60-minute delay, the 30-closed-signals threshold and the fee model are constants,
 * not environment variables, so a deployment cannot quietly shorten the delay or drop the fees.
 *
 *   PUBLIC_TRACK_USER_IDS   the system ("витринные") accounts whose signals form the track:
 *                           "12,15" or "12:majors,15:alts" (site users.id[:public alias]).
 *                           Empty / unset → no track: feed and stats answer the honest empty payload.
 *   PUBLIC_API_RATE_PER_MIN requests per IP per 60 s over /api/public/{trend,stats,feed} (default 60, 0 = off)
 *   PUBLIC_TRACK_ID_SECRET  HMAC key of the public signal ids (default JWT_SECRET, else random)
 */

const DELAY_S = 3600;                 // Q5: guests see the track 60 minutes late
const CACHE_TTL_S = 60;               // a payload is recomputed at most once per minute
const LIVE_WINDOW_S = 5 * 86400;      // rows younger than this can still change (tracker: 72 h + 24 h grace)
const LAG_MAX_S = 3600;               // an observed stage is dated ≤ 1 h after the engine's bar time
const FEED_PAGE = 20;                 // items of the first GET /feed
const FEED_MAX_NEW = 60;              // 'new' events of one poll (the landing keeps 60 items)
const FEED_MAX_EVENTS = 500;          // changes read for one poll (the newest)
const STATS_MIN_CLOSED = 30;          // «Статистика появится после 30 закрытых сигналов»
const SHOWCASE_MIN_SIGNALS = 30;      // a bot qualifies for the showcase after 30 closed signals …
const SHOWCASE_MIN_DAYS = 30;         // … and 30 days (PORT_DECISIONS, «и», not «или»)
const OUTCOMES_WINDOW = 24;           // outcomes_recent: the last 24 closed signals of every bot
const BOTS_WINDOW_DAYS = 30;          // bots_30d
const RATE_WINDOW_S = 60;
const RATE_DEFAULT = 60;

// The Genome backtester's outer fee deduction (services/genome/backtester.js applyFees) without
// in-simulation slippage: fee_r = clamp((round trip + slippage) / risk %, 0, 0.5).
const FEES = Object.freeze({ round_trip_pct: 0.12, slippage_pct: 0.1, max_r: 0.5, note: 'после комиссий, оценка' });

const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** "12,15:alts" → [{ userId: 12, alias: 'sys1' }, { userId: 15, alias: 'alts' }] (bad / repeated entries dropped). */
function parseAccounts(raw) {
  const out = [];
  const ids = new Set();
  const aliases = new Set();
  for (const part of String(raw == null ? '' : raw).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(\d{1,12})(?::(.*))?$/.exec(s);
    if (!m) continue;
    const userId = Number(m[1]);
    if (!(userId > 0) || ids.has(userId)) continue;
    let alias = m[2] !== undefined ? m[2].trim().toLowerCase() : '';
    if (!ALIAS_RE.test(alias) || aliases.has(alias)) alias = '';
    if (!alias) {
      let k = out.length + 1;
      while (aliases.has(`sys${k}`)) k += 1;
      alias = `sys${k}`;
    }
    ids.add(userId);
    aliases.add(alias);
    out.push({ userId, alias });
  }
  return out;
}

function intEnv(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? n : dflt;
}

function readConfig(env = process.env) {
  return Object.freeze({
    accounts: Object.freeze(parseAccounts(env.PUBLIC_TRACK_USER_IDS)),
    ratePerMin: intEnv(env, 'PUBLIC_API_RATE_PER_MIN', RATE_DEFAULT),
    idSecret: env.PUBLIC_TRACK_ID_SECRET || env.JWT_SECRET || '',
  });
}

module.exports = {
  DELAY_S, CACHE_TTL_S, LIVE_WINDOW_S, LAG_MAX_S, FEED_PAGE, FEED_MAX_NEW, FEED_MAX_EVENTS, STATS_MIN_CLOSED,
  SHOWCASE_MIN_SIGNALS, SHOWCASE_MIN_DAYS, OUTCOMES_WINDOW, BOTS_WINDOW_DAYS, RATE_WINDOW_S, RATE_DEFAULT, FEES,
  parseAccounts, readConfig,
};
