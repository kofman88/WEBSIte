import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';

// The production Content-Security-Policy (config/csp.js → helmet in server.js), pinned header for
// header, plus the page-side rules that keep it at 0 violations (tests/e2e/csp_pages_probe.mjs
// loads every page under it in Chromium): no inline event handlers except the landing's hashed
// font switch, no CDN script outside script-src, no @latest.

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const { cspDirectives, helmetCsp, LANDING_FONT_ONLOAD_SHA256 } = require('../config/csp');

const EXPECTED = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://mc.yandex.ru https://mc.yandex.com https://yastatic.net",
  "script-src-attr 'unsafe-hashes' 'sha256-MhtPZXr7+LpJUY5qtMutB+qWfQtMaPccfe7QXtCcEYc='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' wss: https:",
  'frame-src blob: https://mc.yandex.ru https://mc.yandex.com',
  "child-src 'self' blob:",
  'upgrade-insecure-requests',
].join(';');

function parsePolicy(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}
const POLICY = parsePolicy(EXPECTED);

/** frontend files (no node_modules, no vendored libraries) */
function frontendFiles(exts) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  walk(FRONTEND);
  return out.sort();
}
const rel = (p) => path.relative(FRONTEND, p).split(path.sep).join('/');
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const sha256 = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const HANDLER_ATTR = /\son([a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;

describe('config/csp.js: the production policy, exactly', () => {
  it('helmet renders exactly the intended directives (no helmet defaults merged in)', async () => {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: helmetCsp(true) }));
    app.get('/', (_req, res) => res.send('ok'));
    const r = await request(app).get('/');
    expect(r.headers['content-security-policy']).toBe(EXPECTED);
  });

  it('no CSP outside production (dev / tests)', () => {
    expect(helmetCsp(false)).toBe(false);
  });

  it("script-src keeps 'unsafe-inline' and never gets a hash / nonce (either one would switch it off for the inline <script> blocks)", () => {
    expect(cspDirectives.scriptSrc).toContain("'unsafe-inline'");
    expect(cspDirectives.scriptSrc.filter((s) => /^'(sha(256|384|512)|nonce)-/.test(s))).toEqual([]);
    expect(cspDirectives.scriptSrc.filter((s) => s.includes('*') || s === 'https:' || s === 'http:')).toEqual([]);
  });

  it('Yandex Metrika: exact origins only (script, frames / workers incl. blob:), no wildcard hosts', () => {
    expect(POLICY['script-src']).toEqual(["'self'", "'unsafe-inline'", 'https://mc.yandex.ru', 'https://mc.yandex.com', 'https://yastatic.net']);
    expect(POLICY['frame-src']).toEqual(['blob:', 'https://mc.yandex.ru', 'https://mc.yandex.com']);
    // child-src only backs worker-src here (frame-src is set): sw.js + Metrika's blob: worker
    expect(POLICY['child-src']).toEqual(["'self'", 'blob:']);
    expect(EXPECTED).not.toMatch(/\*/);
    // the counter's hits (img / connect) are within img-src / connect-src
    expect(POLICY['img-src']).toContain('https:');
    expect(POLICY['connect-src']).toContain('https:');
    const metrika = fs.readFileSync(path.join(FRONTEND, 'yandex-metrika.js'), 'utf8');
    for (const u of metrika.match(/https:\/\/[a-z0-9.-]+/gi)) expect(POLICY['script-src'], u).toContain(u);
  });
});

describe('pages: what the policy allows is what they use', () => {
  it('the only inline event handlers are the landing font switches, allowed by their exact sha256', () => {
    const found = [];
    for (const f of frontendFiles(['.html'])) {
      const html = fs.readFileSync(f, 'utf8');
      for (const m of html.matchAll(HANDLER_ATTR)) found.push({ file: rel(f), event: m[1].toLowerCase(), value: decode(m[3] ?? m[4]) });
    }
    expect(found).toEqual([
      { file: 'index.html', event: 'load', value: "this.media='all'" },
      { file: 'pricing/index.html', event: 'load', value: "this.media='all'" },
    ]);
    const hashes = [...new Set(found.map((h) => sha256(h.value)))];
    expect(hashes).toEqual([LANDING_FONT_ONLOAD_SHA256]);
    expect(POLICY['script-src-attr']).toEqual(["'unsafe-hashes'", ...hashes]);
    // the hashed handler sits on the non-blocking Google Fonts stylesheet
    for (const page of ['index.html', 'pricing/index.html']) {
      const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
      expect(html, page).toMatch(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" media="print" onload="this\.media='all'"\/>/);
    }
  });

  it('no script builds inline handler attributes into markup (innerHTML / templates)', () => {
    const hits = [];
    for (const f of frontendFiles(['.js'])) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
        if (/[\s"'`]on[a-z]+\s*=\s*(\\?["'`]|\$\{)/i.test(line) && !/\.on[a-z]+\s*=/.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    for (const f of frontendFiles(['.html'])) {
      const html = fs.readFileSync(f, 'utf8');
      if (/setAttribute\(\s*['"]on[a-z]+['"]/i.test(html)) hits.push(`${rel(f)}: setAttribute('on…')`);
    }
    expect(hits).toEqual([]);
  });

  it('every external <script src> / stylesheet is an origin of the policy, pinned (no @latest)', () => {
    const bad = [];
    for (const f of frontendFiles(['.html'])) {
      const html = fs.readFileSync(f, 'utf8');
      for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
        const src = decode(m[1]);
        if (/@latest/.test(src)) bad.push(`${rel(f)}: ${src} (@latest)`);
        if (/^(https?:)?\/\//.test(src) && !POLICY['script-src'].includes(new URL(src, 'https://chmup.top').origin)) bad.push(`${rel(f)}: script ${src}`);
      }
      for (const m of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)) {
        const href = decode((m[0].match(/\bhref="([^"]+)"/) || [])[1] || '');
        if (/^(https?:)?\/\//.test(href) && !POLICY['style-src'].includes(new URL(href, 'https://chmup.top').origin)) bad.push(`${rel(f)}: stylesheet ${href}`);
      }
      if (/localhost:3000/.test(html)) bad.push(`${rel(f)}: http://localhost:3000 API base (connect-src 'self')`);
    }
    for (const f of frontendFiles(['.js'])) {
      if (/localhost:3000/.test(fs.readFileSync(f, 'utf8'))) bad.push(`${rel(f)}: http://localhost:3000 API base (connect-src 'self')`);
    }
    expect(bad).toEqual([]);
  });

  it('the legal pages use the vendored lucide build of the version their <script> names', () => {
    for (const page of ['terms.html', 'privacy.html', 'risk.html']) {
      const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
      const m = html.match(/<script src="\/assets\/vendor\/lucide-(\d+\.\d+\.\d+)\.min\.js" defer><\/script>/);
      expect(m, page).not.toBeNull();
      const lib = fs.readFileSync(path.join(FRONTEND, 'assets', 'vendor', `lucide-${m[1]}.min.js`), 'utf8');
      expect(lib.slice(0, 200)).toContain(`@license lucide v${m[1]} - ISC`);
      // lucide is deferred: icons are created once it has run (DOMContentLoaded), not before
      expect(html).toContain("document.addEventListener('DOMContentLoaded', function () {\n  if (typeof lucide !== 'undefined') lucide.createIcons();");
      expect(html).toContain('img[data-hide-on-error]');
    }
    expect(fs.existsSync(path.join(FRONTEND, 'assets', 'vendor', 'lucide-LICENSE.txt'))).toBe(true);
  });

  // The sources config/csp.js leaves out on purpose stay unneeded.
  it("font-src has no data: — no font on the site (vendored libraries included) is a data: URL", () => {
    expect(POLICY['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
    const all = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(css|html|js)$/.test(e.name)) all.push(p);
      }
    };
    walk(FRONTEND);
    const hits = all.filter((f) => /data:(font\/|application\/(x-)?font|application\/vnd\.ms-fontobject)/i.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(hits).toEqual([]);
  });

  it("frame-src has no 'self' (frame-ancestors 'none' refuses every same-origin frame) and the site frames nothing itself", () => {
    expect(POLICY['frame-ancestors']).toEqual(["'none'"]);
    expect(POLICY['frame-src']).not.toContain("'self'");
    const hits = [];
    for (const f of frontendFiles(['.html', '.js'])) {
      const t = fs.readFileSync(f, 'utf8');
      if (/<iframe\b|createElement\(\s*['"]iframe['"]\s*\)/i.test(t)) hits.push(rel(f));
    }
    expect(hits).toEqual([]);
  });

  it("child-src is the worker fallback: 'self' for /sw.js, blob: for Metrika — no host (workers are same-origin or blob:)", () => {
    expect(POLICY['worker-src']).toBeUndefined();
    expect(POLICY['child-src']).toEqual(["'self'", 'blob:']);
    const regs = [];
    for (const f of frontendFiles(['.html', '.js'])) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/serviceWorker\.register\(\s*['"]([^'"]+)['"]/g)) regs.push(`${rel(f)} ${m[1]}`);
      if (/new\s+(Shared)?Worker\(/.test(t)) regs.push(`${rel(f)} new Worker`);
    }
    expect(regs).toEqual(['settings.html /sw.js']);
    expect(fs.existsSync(path.join(FRONTEND, 'sw.js'))).toBe(true);
  });

  // server.js serves every .js with `max-age=2592000, immutable`: the handlers moved out of the
  // legacy pages' inline on* attributes live in app.js / ops.js, so those files ship under a
  // versioned URL — a browser holding the old copy would otherwise run new HTML with old JS
  // (dead sign-out and ops drawer buttons) for up to 30 days.
  // support-widget.js likewise (its phone layout changed with it): the same one version string as
  // app.js / ops.js on every legacy page, and the landing's on-demand loader (landing.js, which
  // carries the landing's own version, tests/public/landing.test.js) names the same URL.
  it('the legacy pages load app.js / ops.js / support-widget.js under one cache-busting version', () => {
    expect(fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8')).toMatch(/\.\(css\|js\|[^)]*\)\$\/i\.test\(filePath\)\) \{\s*res\.setHeader\('Cache-Control', 'public, max-age=2592000, immutable'\)/);
    const refs = [];
    for (const f of fs.readdirSync(FRONTEND).filter((n) => n.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
      for (const m of html.matchAll(/<script\b[^>]*\bsrc="((?:\.\/|\/)?(app|ops|support-widget)\.js(?:\?v=([\w.-]+))?)"/g)) refs.push({ page: f, file: m[2], v: m[3] || null });
    }
    expect(refs.map((r) => `${r.page} ${r.file}`).sort()).toEqual([
      'about.html support-widget', 'admin.html app', 'admin.html support-widget', 'api-docs.html support-widget',
      'ops.html app', 'ops.html ops', 'ops.html support-widget', 'privacy.html support-widget', 'risk.html support-widget',
      'settings.html app', 'settings.html support-widget', 'status.html app', 'status.html support-widget',
      'subscriptions.html app', 'subscriptions.html support-widget', 'terms.html support-widget',
    ]);
    expect(refs.filter((r) => !r.v)).toEqual([]);
    const versions = new Set(refs.map((r) => r.v));
    expect(versions.size).toBe(1);
    // every other mention of the widget in the frontend (landing.js's loader) is the same URL
    const others = [];
    for (const f of frontendFiles(['.js', '.html'])) {
      if (rel(f) === 'support-widget.js') continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/support-widget\.js(\?v=[\w.-]+)?/g)) others.push(`${rel(f)} ${m[1] || '(no version)'}`);
    }
    const v = [...versions][0];
    expect(others.filter((o) => !o.endsWith(` ?v=${v}`))).toEqual([]);
    expect(others).toContain(`landing/landing.js ?v=${v}`);
  });
});

// The real server.js in production mode (helmet as deployed) in a child process: the header on
// HTML pages, static assets, the SPA fallback and the API.
describe('server.js with NODE_ENV=production sends the policy', () => {
  let child = null;
  let base = '';
  let dir = '';
  let log = '';
  const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chm-csp-'));
    fs.mkdirSync(path.join(dir, 'home'));
    fs.symlinkSync(FRONTEND, path.join(dir, 'home', 'public_html'), 'dir');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOME: path.join(dir, 'home'),
      DATABASE_PATH: path.join(dir, 'csp.db'),
      JWT_SECRET: 'csp_test_jwt_secret_that_is_at_least_32_chars',
      JWT_REFRESH_SECRET: 'csp_test_refresh_secret_that_is_at_least_32_chars',
      WALLET_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      CORS_ORIGIN: base,
      ENGINE_WORKER: '0',
      MAINTENANCE_DISABLED: '1',
      SECURITY_MONITOR_DISABLED: '1',
      LOG_LEVEL: 'error',
      DB_QUIET: '1',
    };
    for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'SENTRY_DSN', 'STRIPE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'SMTP_HOST', 'PUBLIC_TRACK_USER_IDS']) delete env[k];
    child = spawn(process.execPath, ['-e', "require('./server')"], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { log += c; });
    child.stderr.on('data', (c) => { log += c; });
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
      try { await fetch(base + '/api/health'); break; } catch (_e) { /* not listening yet */ }
      if (Date.now() - t0 > 20000) throw new Error(`server did not start: ${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => { const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } r(); }, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['/', '/?data=empty', '/pricing/', '/app/', '/auth/', '/settings.html', '/terms.html', '/ops.html', '/landing/landing.js', '/no/such/page', '/api/health', '/api/public/stats'])('%s', async (p) => {
    const r = await fetch(base + p, { redirect: 'manual' });
    expect(r.headers.get('content-security-policy')).toBe(EXPECTED);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });

  it('the landing it serves carries the hashed handler byte for byte', async () => {
    const html = await (await fetch(base + '/')).text();
    const m = html.match(/ onload="([^"]*)"/);
    expect(sha256(decode(m[1]))).toBe(LANDING_FONT_ONLOAD_SHA256);
  });
});
