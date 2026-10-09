/**
 * M12b inbox: the buttons of an engine notification are stored with the row
 * (notifications.actions), normalised to what the inbox may act on, and returned by
 * GET /api/notifications; DELETE /api/notifications/:id/actions removes them (the bot's
 * reply_markup=None after a press) for the owner only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { setupEnv, insertUser } from '../challenge/helpers.js';

const req = createRequire(import.meta.url);
setupEnv('inbox-actions');

let db; let app; let N; let notifier; let authService; let engagement; let advisor; let dc;
const H = (uid) => ({ Authorization: `Bearer ${authService._signAccessToken(uid)}` });

beforeAll(async () => {
  db = req('../../models/database.js');
  app = (await import('../../server.js')).default;
  N = req('../../services/notificationsService.js');
  notifier = req('../../services/notifier.js');
  authService = req('../../services/authService.js');
  engagement = req('../../services/retention/engagement.js');
  advisor = req('../../services/entryAdvisor.js');
  dc = req('../../services/retention/dripCampaign.js');
  for (const uid of [5101, 5102]) insertUser(db, uid);
});

describe('normalizeActions', () => {
  it('the engine rows, the flat reports / advisor lists and the stored shape → one shape, idempotent', () => {
    const shapes = [
      engagement.keyboard(7, { lang: 'ru' }),
      advisor.keyboard('ru'),
      [{ text: '📊 Подробнее', url: '/app/?tab=stats' }],
      dc.keyboard([['📊 Мои результаты', 'dashboard_show']]),
    ];
    const out = shapes.map((x) => N.normalizeActions(x));
    expect(out[0]).toEqual([
      [{ label: '✍️ Оплатить — Написать админу', kind: 'url', url: 'https://t.me/crypto_chm' }],
      [{ label: '🔕 Не присылать напоминания', kind: 'callback', action: 'engagement_optout:7', api: { method: 'POST', path: 'engagement/optout' } }],
    ]);
    expect(out[1]).toEqual([
      [{ label: 'Включить вход по рынку', kind: 'callback', action: 'entry_market_on', api: { method: 'POST', path: 'entry-advice/on' } }],
      [{ label: 'Оставить лимитный', kind: 'callback', action: 'entry_market_keep', api: { method: 'POST', path: 'entry-advice/keep' } }],
    ]);
    expect(out[2]).toEqual([[{ label: '📊 Подробнее', kind: 'url', url: '/app/?tab=stats' }]]);
    expect(out[3]).toEqual([[{ label: '📊 Мои результаты', kind: 'url', url: '/app/?tab=stats' }]]);
    for (const o of out) expect(N.normalizeActions(JSON.parse(JSON.stringify(o)))).toEqual(o);
  });

  it('only site paths, https links and the inbox routes survive (trade buttons stay on the card, D16)', () => {
    expect(N.normalizeActions([[
      { label: 'exec', action: 'exec_trade_1', kind: 'callback', api: { method: 'POST', path: 'trades/1/exec' } },
      { label: 'qc', action: 'qc_full_1', kind: 'callback', api: { method: 'POST', path: 'trades/1/qc/full' } },
      { label: 'raw cb', action: 'trend_notify_off', kind: 'callback' },
      { label: 'js', action: 'javascript:alert(1)', kind: 'url' },
      { label: 'http', action: 'http://example.com/', kind: 'url' },
      { label: 'proto-rel', action: '//evil.example/x', kind: 'url' },
      { label: 'backslash', action: '/\\evil.example', kind: 'url' },
      { label: 'quote', action: '/app/"onmouseover=x', kind: 'url' },
      { label: 'api escape', url: '/api/app/../admin/x', text: 'x' },
      { label: '', action: '/app/', kind: 'url' },
    ]])).toBe(null);
    for (const u of ['/api/app/x', '/API/x', '/api', '/app/../admin', '/app/./x', '/a/..', 'ftp://x', 'https://x y', '']) {
      expect(N.normalizeActions([{ text: 't', url: u }])).toBe(null);
    }
    for (const u of ['/app/?tab=stats', '/subscriptions.html', '/app/?q=../x', '/.well-known/x', 'https://t.me/crypto_chm']) {
      expect(N.normalizeActions([{ text: 't', url: u }])).toEqual([[{ label: 't', kind: 'url', url: u }]]);
    }
    expect(N.normalizeActions('x')).toBe(null);
    expect(N.normalizeActions([[null, 5, 'str']])).toBe(null);
    // at most 8 buttons, labels ≤ 64 characters
    const many = N.normalizeActions(Array.from({ length: 12 }, (_, i) => ({ text: `b${i}${'x'.repeat(80)}`, url: '/app/' })));
    expect(many.length).toBe(8);
    expect(many[0][0].label.length).toBe(64);
  });
});

describe('GET /api/notifications and DELETE …/:id/actions', () => {
  it('a dispatched reminder comes back with its buttons; a signal card without them', async () => {
    await notifier.dispatch(5101, { type: 'signal', title: 'BTC LONG', body: '<b>BTC LONG</b>', link: '/app/?tab=signals&id=x',
      data: { kind: 'card', actions: [[{ label: 'Открыть сделку', action: 'exec_trade_x', kind: 'callback', api: { method: 'POST', path: 'trades/x/exec' } }]] } });
    engagement.configure({ clock: () => 1_800_000_000 });
    const sent = await engagement.sendReminder({ user_id: 5101, lang: 'en', sub_status: 'active', active: true }, '3d').finally(() => engagement.resetDeps());
    expect(sent).toBe(true);
    const r = await request(app).get('/api/notifications').set(H(5101));
    expect(r.status).toBe(200);
    expect(r.body.unreadCount).toBe(2);
    const [rem, sig] = r.body.notifications;
    expect(rem.type).toBe('reminder');
    expect(rem.actions).toEqual(N.normalizeActions(engagement.keyboard(5101, { lang: 'en' })));
    expect(sig.type).toBe('signal');
    expect(sig.actions).toBe(null);
    // another user cannot clear them; the owner can
    let d = await request(app).delete(`/api/notifications/${rem.id}/actions`).set(H(5102));
    expect(d.body).toEqual({ updated: 0 });
    d = await request(app).delete(`/api/notifications/${rem.id}/actions`).set(H(5101));
    expect(d.body).toEqual({ updated: 1 });
    const again = await request(app).get('/api/notifications').set(H(5101));
    expect(again.body.notifications[0].actions).toBe(null);
    expect((await request(app).delete(`/api/notifications/${rem.id}/actions`)).status).toBe(401);
  });

  it('a corrupt stored value reads as no buttons', async () => {
    const id = N.create(5102, { type: 'report', title: 't' });
    db.prepare('UPDATE notifications SET actions = ? WHERE id = ?').run('{not json', id);
    const r = await request(app).get('/api/notifications').set(H(5102));
    expect(r.body.notifications.find((n) => n.id === Number(id)).actions).toBe(null);
  });
});
