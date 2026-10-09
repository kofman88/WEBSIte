import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { fileURLToPath } from 'url';

// Yandex Metrika runs with trackLinks: it reports the URL of every outbound link a visitor clicks.
// A link that carries a secret must be out of it (Metrika's class ym-disable-tracklink): the
// settings «Привязать Telegram» link t.me/<bot>?start=<one-time link code>. The support attachments
// (a user's screenshots, as data: URLs) are links too: excluded as well, and only ever a base64
// image (a javascript: URL there ran in the reader's session — an admin's on the ops page).

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-outbound-links.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

describe('Metrika link tracking never sees a secret', () => {
  it('Metrika does track outbound links (so the exclusion matters)', () => {
    expect(read('yandex-metrika.js')).toMatch(/trackLinks:true/);
  });

  it('settings: the Telegram link (t.me/<bot>?start=<one-time code>) is excluded, and is the only place the code goes', () => {
    const html = read('settings.html');
    const a = /<a id="tgLinkUrl"[^>]*>/.exec(html)[0];
    expect(a).toMatch(/class="ym-disable-tracklink /);
    expect(a).toContain('rel="noopener noreferrer"');
    // the link's URL comes from POST /telegram/link and goes into that element (and window.open, which trackLinks does not see)
    const uses = [...html.matchAll(/r\.url\b/g)].length;
    expect(uses).toBe(3);
    expect(html).toContain("document.getElementById('tgLinkUrl').href = r.url;");
    expect(html).toContain("document.getElementById('tgLinkUrl').textContent = r.url;");
    expect(html).toContain("window.open(r.url, '_blank', 'noopener,noreferrer');");
    const svc = fs.readFileSync(path.join(BACKEND, 'services', 'telegramService.js'), 'utf8');
    expect(svc).toContain("const url = 'https://t.me/' + botUsername() + '?start=' + token;");
  });

  it('support attachments: excluded from link tracking, and only a base64 image data: URL is rendered', () => {
    for (const f of ['support-widget.js', 'ops.js']) {
      const js = read(f);
      const links = js.match(/'<a [^']*href="' \+ a\.dataUrl/g) || [];
      expect(links.length, f).toBe(1);
      expect(links[0], f).toContain('class="ym-disable-tracklink"');
      expect(js, f).toMatch(/data:image\\\/\(\?:png\|jpe\?g\|gif\|webp\|bmp\|avif\|heic\|heif\);base64,\[A-Za-z0-9\+\\?\/\]\+=\{0,2\}\$/);
    }
  });

  it('support widget: Session Replay (public pages) sees neither the thread nor what is typed', () => {
    const js = read('support-widget.js');
    expect(js).toContain(`'<div class="chm-sup-panel ym-hide-content" id="chmSupPanel"`);
    const fields = js.match(/'<(?:textarea|input)\b[^']*'/g).filter((f) => !/type="file"/.test(f));
    expect(fields.length).toBe(4);
    for (const f of fields) expect(f).toContain('class="ym-disable-keys"');
    // the public pages that load it run Webvisor (no ?webvisor=0): the masking is what protects them
    for (const page of ['about.html', 'status.html', 'terms.html']) {
      const html = read(page);
      expect(html, page).toContain('support-widget.js?v=');
      expect(html, page).toContain('<script src="/yandex-metrika.js" async>');
    }
  });

  it('no other link of the site carries a token or code in its URL', () => {
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'vendor') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(html|js)$/.test(e.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/href="([^"]*)"/g)) {
            if (/[?&#](?:token|code|start|reset|verify|imp|access_token|refresh_token)=/i.test(m[1])) hits.push(`${path.relative(FRONTEND, p)}: ${m[1]}`);
          }
        }
      }
    };
    walk(FRONTEND);
    expect(hits).toEqual([]);
  });
});

describe('POST support replies: an attachment is a base64 image data: URL or a 400', () => {
  let app, token, ticketId;
  beforeAll(async () => {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
    app = (await import('../server.js')).default;
    const r = await request(app).post('/api/auth/register').send({ email: 'att@x.com', password: 'Abcdef123' });
    token = r.body.accessToken;
    const t = await request(app).post('/api/support/tickets').set('Authorization', 'Bearer ' + token).send({ subject: 'hello', body: 'help me' });
    ticketId = (t.body.ticket && t.body.ticket.id) || t.body.id;
  });
  const reply = (dataUrl) => request(app).post(`/api/support/tickets/${ticketId}/reply`).set('Authorization', 'Bearer ' + token)
    .send({ body: 'see attached', attachments: [{ name: 'a.png', type: 'image/png', dataUrl }] });

  it.each(['javascript:alert(document.domain)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,AAAA" onerror="x', 'https://evil.example/a.png', 'data:image/png,AAAA'])('refuses %s', async (u) => {
    const r = await reply(u);
    expect(r.status).toBe(400);
  });

  it('accepts a PNG / JPEG data: URL', async () => {
    expect((await reply('data:image/png;base64,iVBORw0KGgo=')).status).toBe(200);
    expect((await reply('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).status).toBe(200);
  });
});

// The bell (frontend/app.js) navigates to a notification's link, the push click (sw.js) too. The
// links the server writes are its own paths; the one input is the ops "notify" action — an admin
// with user.notify could set //host (open redirect) or javascript: (script in the user's session).
describe('notification links: a path of this site only', () => {
  let app, db, admin, target;
  beforeAll(async () => {
    app = (await import('../server.js')).default;
    db = (await import('../models/database.js')).default;
    const a = await request(app).post('/api/auth/register').send({ email: 'notify-admin@x.com', password: 'Abcdef123' });
    db.prepare("UPDATE users SET is_admin = 1, admin_role = 'superadmin' WHERE id = ?").run(a.body.user.id);
    admin = a.body.accessToken;
    target = (await request(app).post('/api/auth/register').send({ email: 'notify-target@x.com', password: 'Abcdef123' })).body.user.id;
  });
  const notify = (link) => request(app).post(`/api/admin/users/${target}/notify`).set('Authorization', 'Bearer ' + admin).send({ title: 'Hi', body: 'x', link });

  it.each(['//evil.example', '///evil.example', '/\\evil.example', '\\\\evil.example', 'https://evil.example/', 'javascript:alert(1)',
    'JavaScript:alert(1)', 'data:text/html,x', 'settings.html', '/a b', '/x\\y', ' /settings.html'])('refuses %j', async (link) => {
    expect((await notify(link)).status).toBe(400);
  });

  it.each(['/settings.html', '/app/?tab=signals&id=7_1', '/ops.html#users', undefined])('accepts %j', async (link) => {
    expect((await notify(link)).status).toBe(200);
  });

  it('the bell follows only such a path', () => {
    expect(read('app.js')).toContain("if (link && /^\\/(?![/\\\\])[^\\s\\\\]*$/.test(link)) location.href = link;");
  });
});
