'use strict';
// One "Passenger process" for tests/authRace.test.js: opens the same SQLite file as the test (env
// DATABASE_PATH …), waits for the common start time, tries one single-use secret once, prints the
// outcome as JSON. argv: <mode> <startAtMs> <args…>
//   totp <userId> <code>            twoFactorService.verifyCode (TOTP step replay)
//   recovery <userId> <code>        twoFactorService.verifyCode (a recovery code)
//   imp <code>                      impersonationService.redeem
//   oauth <code>                    oauthService.redeemHandoff
//   hits <prefix> <key> <n>         SqliteRateLimitStore.increment n times
const path = require('path');
const B = path.resolve(__dirname, '..', '..');
const [mode, startAt, ...args] = process.argv.slice(2);
require(path.join(B, 'models/database'));
const work = {
  totp: () => require(path.join(B, 'services/twoFactorService')).verifyCode(Number(args[0]), args[1]),
  recovery: () => require(path.join(B, 'services/twoFactorService')).verifyCode(Number(args[0]), args[1]),
  imp: () => { try { return Boolean(require(path.join(B, 'services/impersonationService')).redeem(args[0]).accessToken); } catch (_e) { return false; } },
  oauth: () => { try { return Boolean(require(path.join(B, 'services/oauthService')).redeemHandoff(args[0]).userId); } catch (_e) { return false; } },
  hits: async () => {
    const { SqliteRateLimitStore } = require(path.join(B, 'middleware/rateLimitStore'));
    const st = new SqliteRateLimitStore({ prefix: args[0] });
    st.init({ windowMs: 60_000 });
    const out = [];
    for (let i = 0; i < Number(args[2]); i += 1) out.push((await st.increment(args[1])).totalHits);
    return out;
  },
}[mode];
(async () => {
  while (Date.now() < Number(startAt)) { /* the processes start together */ }
  const ok = await work();
  process.stdout.write(JSON.stringify({ ok }) + '\n');
})().catch((e) => { process.stdout.write(JSON.stringify({ error: e.message }) + '\n'); process.exit(1); });
