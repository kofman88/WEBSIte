import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// The web app's inbox (M12b) acts only on the callback routes the server stores
// (services/notificationsService.INBOX_ROUTES) — the two lists must not drift apart — and every
// body / title / label goes into the page as text. In Chromium: tests/e2e/app_real_smoke.mjs step 7.

const req = createRequire(import.meta.url);
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(BACKEND, '..', 'frontend', 'app', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(BACKEND, '..', 'frontend', 'app', 'index.html'), 'utf8');

describe('frontend/app inbox', () => {
  it('the client route list is the server\'s', () => {
    process.env.DB_QUIET = '1';
    const line = APP.split('\n').find((l) => l.startsWith('  var INBOX_ROUTES = ['));
    expect(line).toBeTruthy();
    const client = vm.runInNewContext(line.trim().replace(/^var INBOX_ROUTES = /, '').replace(/;$/, ''), {});
    const server = req('../services/notificationsService.js').INBOX_ROUTES;
    expect(client.map((r) => r.source)).toEqual(server.map((r) => r.source));
  });

  it('the inbox markup: bell button, badge, dialog; the cache key moved with the release', () => {
    expect(INDEX).toContain('<button id="inbox-btn" class="icon-btn inbox-btn" type="button" aria-label="Уведомления" hidden>');
    expect(INDEX).toContain('<section id="inbox" class="detail inbox" hidden role="dialog" aria-modal="true" aria-label="Уведомления"></section>');
    expect(INDEX).toContain('./app.js?v=m12b');
    expect(INDEX).toContain('./app.css?v=m12b');
  });

  it('notification text goes in as textContent; links never reach the API or leave without noopener', () => {
    const block = APP.slice(APP.indexOf('// INBOX (M12b)'), APP.indexOf('  function boot() {'));
    expect(block.length).toBeGreaterThan(1000);
    expect(block).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(block).toContain('h("p", { class: "inbox-body", text: body })');
    expect(block).toContain('h("div", { class: "inbox-title", text: n.title || "" })');
    expect(block).toContain('/^\\/api(?:\\/|$)/i.test(url)');
    expect(block).toContain('if (/^https:\\/\\//i.test(url)) { openExternal(url); return; }');
    expect(APP).toContain('window.open(url, "_blank", "noopener")');
  });
});
