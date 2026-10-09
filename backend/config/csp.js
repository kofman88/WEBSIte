/**
 * Content-Security-Policy of the site in production (server.js → helmet, useDefaults off: this
 * object is the whole policy). Dev / tests run without a CSP (inline bits + HMR fight it);
 * tests/csp.test.js pins this exact header, and tests/e2e/csp_pages_probe.mjs loads every page
 * under it in Chromium (0 violations).
 *
 * Why each source is there (each one was checked by taking it out: the probe then reports a
 * violation or a broken page):
 *
 * script-src 'self' 'unsafe-inline' + Yandex Metrika. 'unsafe-inline' is for the pages' inline
 * <script> blocks. script-src must never get a hash or nonce: either one makes browsers ignore
 * 'unsafe-inline' and would block those scripts. Metrika (yandex-metrika.js →
 * https://mc.yandex.ru/metrika/tag.js) per Yandex's "Installing a tag on a site with CSP":
 * mc.yandex.ru (tag.js), mc.yandex.com and yastatic.net (the modules tag.js loads).
 *
 * script-src-attr (inline event-handler attributes): none, except the landing's (index.html,
 * pricing/index.html) non-blocking font stylesheet `<link media="print" onload="this.media='all'">`.
 * The landing has a hard byte budget, so that one handler is allowed by its exact hash
 * ('unsafe-hashes' + sha256 of the attribute value) instead of moving it into landing.js. Every
 * other page binds its handlers from JS (data-* attributes + addEventListener). A browser without
 * script-src-attr falls back to script-src ('unsafe-inline') and runs the handler anyway.
 *
 * style-src 'unsafe-inline': style attributes and <style> blocks everywhere; fonts.googleapis.com:
 * the Google Fonts stylesheets. font-src: fonts.gstatic.com (the font files); no data: — nothing
 * on the site embeds a font as a data: URL (tests/csp.test.js checks), and data: fonts would only
 * help injected CSS.
 *
 * img-src data: (the landing's inline SVG favicon and backgrounds, support-widget previews) and
 * https:, connect-src https: + wss: — Metrika's hits go to mc.yandex.ru and the regional
 * mc.yandex.<tld> / mc.webvisor.* hosts tag.js picks at runtime (Yandex's "general list"), and
 * the checkout / 2FA QR images come from api.qrserver.com. These were already scheme sources
 * before; narrowing them to a host list needs a Report-Only period against the live counter.
 *
 * frame-src blob: mc.yandex.ru / mc.yandex.com: Metrika's Session Replay and click / scroll / link
 * maps (blob: frames, mc.yandex.* match frames). No 'self': every same-origin response carries
 * frame-ancestors 'none' + X-Frame-Options DENY, so a same-origin frame can never load anyway.
 *
 * child-src 'self' blob: is only the worker fallback here (frame-src is set, and there is no
 * worker-src): 'self' for /sw.js (settings.html registers it for web push), blob: for Metrika's
 * blob: worker. Workers are same-origin or blob: by construction, so Yandex's hosts in child-src
 * (its docs list them for old browsers that read frames from child-src) would be dead entries.
 *
 * frame-ancestors 'none' (no framing of the site, also not by metrika.yandex.ru's in-page map
 * viewer: against clickjacking), object-src 'none', base-uri / form-action 'self'.
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
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  connectSrc: ["'self'", 'wss:', 'https:'],
  frameSrc: ['blob:', ...YANDEX_METRIKA],
  childSrc: ["'self'", 'blob:'],
  upgradeInsecureRequests: [],
};

/** helmet's contentSecurityPolicy option: the policy above in production, no CSP header otherwise. */
function helmetCsp(isProd) {
  return isProd ? { useDefaults: false, directives: cspDirectives } : false;
}

module.exports = { cspDirectives, helmetCsp, LANDING_FONT_ONLOAD_SHA256 };
