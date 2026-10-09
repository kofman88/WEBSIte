import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

// The web app's sign-in returns to the page that sent the visitor (?next=), same origin only: the
// legacy pages (settings, subscriptions, admin via app.js requireAuth; ops via ops.js) send
// /app/?next=<their path>, and the app accepts exactly the paths of its NEXT_PATHS. In Chromium:
// tests/e2e/csp_pages_probe.mjs (settings-anon / ops-anon sign in and land back; app-next-hostile).

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const APP = fs.readFileSync(path.join(FRONTEND, 'app', 'app.js'), 'utf8');

// NEXT_PATHS + safeNext() of frontend/app/app.js, verbatim, in a VM
function loadSafeNext() {
  const lines = APP.split('\n');
  const from = lines.findIndex((l) => l.startsWith('  var NEXT_PATHS = ['));
  const to = lines.findIndex((l, i) => i > from && l === '  }');
  expect(from).toBeGreaterThan(0);
  const code = lines.slice(from, to + 1).join('\n') + '\n({ safeNext, NEXT_PATHS });';
  return vm.runInNewContext(code, {});
}

describe('frontend/app/app.js: ?next= is same-origin, from an allow-list', () => {
  const { safeNext, NEXT_PATHS } = loadSafeNext();

  it('the allow-list is the legacy pages behind the sign-in', () => {
    expect([...NEXT_PATHS]).toEqual(['/settings.html', '/subscriptions.html', '/ops.html', '/admin.html']);
    for (const p of NEXT_PATHS) expect(fs.existsSync(path.join(FRONTEND, p.slice(1))), p).toBe(true);
  });

  it.each(['/settings.html', '/subscriptions.html', '/ops.html', '/admin.html'])('accepts %s', (p) => {
    expect(safeNext(p)).toBe(p);
  });

  it.each([
    'https://evil.example/', 'http://evil.example', '//evil.example', '//evil.example/ops.html', '///evil.example', '/\\evil.example',
    '\\\\evil.example', '/\\/evil.example', 'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x',
    '/ops.html?x=1', '/ops.html#x', '/ops.html/../evil', '/OPS.html', '/ops.html ', ' /ops.html', '/ops.html\n', '/%2F%2Fevil.example',
    '/ops.html@evil.example', 'ops.html', '/app/', '/', '', '/index.html', '/api/auth/me', '/auth/', null, undefined, 42, ['/ops.html'],
    '/' + 'a'.repeat(80),
  ])('rejects %j', (v) => {
    expect(safeNext(v)).toBe('');
  });

  it('a valid next is followed only after a sign-in (or a refreshed session), with location.replace; never in demo mode', () => {
    expect(APP).toContain('var NEXT = DEMO ? "" : safeNext(QS.get("next"));');
    expect(APP).toContain('if (NEXT) { location.replace(NEXT); return; }   // back to the page that sent the visitor here');
    expect(APP).toContain('if (NEXT && !tokenLive(Auth.access()) && Auth.refresh()) {');
    // it is the only navigation built from the query
    expect(APP.match(/location\.(?:replace|assign)\(|location\.href\s*=\s*[^;]*NEXT/g).length).toBe(2);
  });
});

describe('the legacy pages pass next=', () => {
  const appJs = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
  const ops = fs.readFileSync(path.join(FRONTEND, 'ops.js'), 'utf8');

  it('app.js requireAuth → /app/?next=<this page>; every page that calls it is on the allow-list', () => {
    expect(appJs).toContain("location.href = '/app/?next=' + encodeURIComponent(location.pathname);");
    const { NEXT_PATHS } = loadSafeNext();
    const gated = fs.readdirSync(FRONTEND).filter((n) => n.endsWith('.html') && /Auth\.requireAuth\(\)/.test(fs.readFileSync(path.join(FRONTEND, n), 'utf8')));
    expect(gated.sort()).toEqual(['admin.html', 'settings.html', 'subscriptions.html']);
    for (const g of gated) expect(NEXT_PATHS).toContain('/' + g);
  });

  it('a page leaving for the sign-in calls the API no more and never refreshes (the app refreshes the same token for ?next=)', () => {
    expect(appJs).toContain("leaving = true;\n      location.href = '/app/?next=' + encodeURIComponent(location.pathname);");
    // before a call, and when a call sent earlier (plan-gate.js's /auth/me) answers 401 after it
    expect(appJs.match(/if \(leaving\) return new Promise\(\(\) => \{\}\);/g)).toHaveLength(2);
    const req = appJs.slice(appJs.indexOf('async function apiRequest('), appJs.indexOf('async function tryRefresh('));
    expect(req.indexOf('if (leaving) return new Promise')).toBeLessThan(req.indexOf('const headers ='));
    expect(req.lastIndexOf('if (leaving) return new Promise')).toBeLessThan(req.indexOf('await tryRefresh()'));
  });

  it('ops.js → /app/?next=/ops.html (no session, or the session check failed); a non-admin → /app/', () => {
    expect(ops.match(/location\.replace\('\/app\/\?next=' \+ encodeURIComponent\('\/ops\.html'\)\)/g)).toHaveLength(2);
    expect(ops).toContain("if (!u.isAdmin) { location.replace('/app/'); return false; }");
  });
});
