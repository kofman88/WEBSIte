/**
 * Secrets out of anything that goes to a log or to Sentry: URLs, paths, messages.
 *
 * What a URL of this site or of a service it calls can carry:
 *   /api/auth/verify-email/<token>            the e-mail confirmation link of older e-mails
 *   ?reset= / ?verify= / #reset= / #verify=   old and new account e-mail links (frontend/auth/)
 *   #oauth=<code>, ?code=&state=              the Google sign-in hand-off / callback
 *   ?start=<code>                             a Telegram link code (t.me/<bot>?start=…)
 *   #impersonate=<key>, ?token= / access_token= / refresh_token= / pendingToken=
 *   https://api.telegram.org/bot<id>:<token>/… the bot token in the path of every Bot API call
 *     (an outgoing-request breadcrumb or span in Sentry would carry it)
 * Each value becomes [redacted]; the key stays, so the line still says what happened.
 */

const QUERY_KEYS = ['reset', 'verify', 'oauth', 'code', 'state', 'start', 'token', 'access_token', 'refresh_token',
  'accessToken', 'refreshToken', 'pendingToken', 'impersonate', 'imp', 'secret', 'password', 'api_key', 'apiKey', 'key', 'signature'];
const QUERY_RE = new RegExp(`([#?&;](?:${QUERY_KEYS.join('|')})=)[^&#\\s"'<>]+`, 'g');
const PATH_RES = [
  [/(\/verify-email\/)(?!\[redacted\])[^/?#\s"'<>]+/g, '$1[redacted]'],
  [/(\/bot)\d+:[A-Za-z0-9_-]+/g, '$1[redacted]'],
];

/** The string with every secret-bearing URL part replaced by [redacted]. Non-strings pass through. */
function redact(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s.replace(QUERY_RE, '$1[redacted]');
  for (const [re, to] of PATH_RES) out = out.replace(re, to);
  return out;
}

/** Deep copy of a plain value with every string redacted (objects / arrays, depth-limited). */
function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, depth + 1);
  return out;
}

module.exports = { redact, redactDeep };
