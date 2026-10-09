/**
 * Content-Security-Policy of the site in production (server.js → helmet, useDefaults off: this
 * object is the whole policy). Dev / tests run without a CSP (inline bits + HMR fight it);
 * tests/csp.test.js pins this exact header, and tests/e2e/csp_pages_probe.mjs loads every page
 * under it in Chromium (0 violations).
 *
 * script-src keeps 'unsafe-inline' for the pages' inline <script> blocks. It must never get a hash
 * or nonce: either one makes browsers ignore 'unsafe-inline' and would block those scripts.
 *
 * script-src-attr (inline event-handler attributes): none, except the landing's (index.html,
 * pricing/index.html) non-blocking font stylesheet `<link media="print" onload="this.media='all'">`.
 * The landing has a hard byte budget, so that one handler is allowed by its exact hash
 * ('unsafe-hashes' + sha256 of the attribute value) instead of moving it into landing.js. Every
 * other page binds its handlers from JS (data-* attributes + addEventListener). A browser without
 * script-src-attr falls back to script-src ('unsafe-inline') and runs the handler anyway.
 *
 * Yandex Metrika (yandex-metrika.js → https://mc.yandex.ru/metrika/tag.js), per Yandex's
 * "Installing a tag on a site with CSP": script-src mc.yandex.ru / mc.yandex.com / yastatic.net
 * (tag.js loads its modules from there), frame-src + child-src `blob:` mc.yandex.ru / mc.yandex.com
 * (Session Replay, click / scroll / link maps; child-src is also the worker fallback). Its hits
 * (img / connect) are covered by img-src / connect-src `https:` (and `wss:`). frame-ancestors stays
 * 'none' (no framing of the site, also not by metrika.yandex.ru's in-page map viewer).
 *
 * Everything else is self-hosted: the legal pages' lucide icons are vendored
 * (frontend/assets/vendor/lucide-<version>.min.js), chart.js likewise; no other CDN is allowed.
 */

// sha256 of the landing's onload attribute value "this.media='all'" (UTF-8, base64)
const LANDING_FONT_ONLOAD_SHA256 = "'sha256-MhtPZXr7+LpJUY5qtMutB+qWfQtMaPccfe7QXtCcEYc='";

const YANDEX_METRIKA = ['https://mc.yandex.ru', 'https://mc.yandex.com'];

const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", ...YANDEX_METRIKA, 'https://yastatic.net'],
  scriptSrcAttr: ["'unsafe-hashes'", LANDING_FONT_ONLOAD_SHA256],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: ["'self'", 'data:', 'https:'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  connectSrc: ["'self'", 'wss:', 'https:'],
  frameSrc: ["'self'", 'blob:', ...YANDEX_METRIKA],
  childSrc: ["'self'", 'blob:', ...YANDEX_METRIKA],
  upgradeInsecureRequests: [],
};

/** helmet's contentSecurityPolicy option: the policy above in production, no CSP header otherwise. */
function helmetCsp(isProd) {
  return isProd ? { useDefaults: false, directives: cspDirectives } : false;
}

module.exports = { cspDirectives, helmetCsp, LANDING_FONT_ONLOAD_SHA256 };
