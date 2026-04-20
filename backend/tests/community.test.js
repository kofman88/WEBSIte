import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-community.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let app, db, leaderboard;
beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  leaderboard = (await import('../services/leaderboardService.js')).default;
});
beforeEach(() => {
  db.prepare('DELETE FROM support_messages').run();
  db.prepare('DELETE FROM support_tickets').run();
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

async function reg(email = 'x@x.com') {
  return (await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' })).body;
}
function mkTrade(userId, pnl, { strategy = 'smc', symbol = 'BTC/USDT' } = {}) {
  return db.prepare(`
    INSERT INTO trades (user_id, exchange, symbol, side, strategy, entry_price, quantity,
      stop_loss, status, realized_pnl, realized_pnl_pct, margin_used, trading_mode, closed_at, opened_at)
    VALUES (?, 'bybit', ?, 'long', ?, 50000, 0.01, 49000, 'closed', ?, ?, 500, 'paper',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(userId, symbol, strategy, pnl, (pnl / 500) * 100).lastInsertRowid;
}

describe('Public leaderboard', () => {
  it('excludes users who did not opt-in', async () => {
    const u1 = await reg('private@x.com');
    mkTrade(u1.user.id, 100);
    mkTrade(u1.user.id, 200);
    const res = await request(app).get('/api/public/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.traders).toHaveLength(0);
  });

  it('includes opted-in users, ranks by pnl', async () => {
    const a = await reg('a@x.com');
    const b = await reg('b@x.com');
    db.prepare('UPDATE users SET public_profile = 1 WHERE id IN (?, ?)').run(a.user.id, b.user.id);
    mkTrade(a.user.id, 100); mkTrade(a.user.id, 50); mkTrade(a.user.id, 30);
    mkTrade(b.user.id, 500); mkTrade(b.user.id, -100); mkTrade(b.user.id, 10);

    const res = await request(app).get('/api/public/leaderboard?period=all&sort=pnl');
    expect(res.status).toBe(200);
    expect(res.body.traders).toHaveLength(2);
    expect(res.body.traders[0].rank).toBe(1);
    expect(res.body.traders[0].totalPnl).toBe(410); // b wins by PnL
    expect(res.body.traders[1].totalPnl).toBe(180);
  });

  it('winrate sort respects min-trades threshold (10)', async () => {
    const a = await reg('a2@x.com');
    const b = await reg('b2@x.com');
    db.prepare('UPDATE users SET public_profile = 1 WHERE id IN (?, ?)').run(a.user.id, b.user.id);
    // a: 2 wins only (below 10-trade threshold — excluded from winrate ranking)
    mkTrade(a.user.id, 50); mkTrade(a.user.id, 50);
    // b: 11 wins
    for (let i = 0; i < 11; i++) mkTrade(b.user.id, 10);

    const res = await request(app).get('/api/public/leaderboard?period=all&sort=winrate');
    expect(res.body.traders).toHaveLength(1);
    expect(res.body.traders[0].userId).toBe(b.user.id);
  });

  it('hides email, shows anonymized name when no display_name', async () => {
    const u = await reg('priv@x.com');
    db.prepare('UPDATE users SET public_profile = 1 WHERE id = ?').run(u.user.id);
    mkTrade(u.user.id, 50); mkTrade(u.user.id, 50); mkTrade(u.user.id, 50);
    const res = await request(app).get('/api/public/leaderboard');
    const t = res.body.traders[0];
    expect(t.displayName).toMatch(/^Trader#/);
    expect(t.email).toBeUndefined();
  });
});

describe('Public profile /api/public/u/:code', () => {
  it('404 for private profile', async () => {
    const u = await reg();
    const code = u.user.referralCode;
    const res = await request(app).get('/api/public/u/' + code);
    expect(res.status).toBe(404);
  });

  it('returns aggregated stats when opted-in', async () => {
    const u = await reg();
    db.prepare('UPDATE users SET public_profile = 1 WHERE id = ?').run(u.user.id);
    mkTrade(u.user.id, 100, { strategy: 'smc' });
    mkTrade(u.user.id, -30, { strategy: 'scalping' });
    mkTrade(u.user.id, 40, { strategy: 'smc' });
    const res = await request(app).get('/api/public/u/' + u.user.referralCode);
    expect(res.status).toBe(200);
    expect(res.body.stats.closedTrades).toBe(3);
    expect(res.body.stats.totalPnl).toBe(110);
    expect(res.body.stats.wins).toBe(2);
    expect(res.body.byStrategy.length).toBeGreaterThan(0);
    expect(res.body.recent.length).toBeGreaterThan(0);
    expect(res.body.email).toBeUndefined();
  });

  it('rejects invalid ref code format with 400', async () => {
    const res = await request(app).get('/api/public/u/!!!');
    expect(res.status).toBe(400);
  });
});

describe('Profile privacy toggle', () => {
  it('PUT /api/support/profile/public flips flag', async () => {
    const u = await reg();
    // Off by default
    let row = db.prepare('SELECT public_profile FROM users WHERE id = ?').get(u.user.id);
    expect(row.public_profile).toBe(0);

    const r1 = await request(app).put('/api/support/profile/public')
      .set('Authorization', 'Bearer ' + u.accessToken).send({ enabled: true });
    expect(r1.status).toBe(200);
    row = db.prepare('SELECT public_profile FROM users WHERE id = ?').get(u.user.id);
    expect(row.public_profile).toBe(1);

    const r2 = await request(app).put('/api/support/profile/public')
      .set('Authorization', 'Bearer ' + u.accessToken).send({ enabled: false });
    expect(r2.status).toBe(200);
    row = db.prepare('SELECT public_profile FROM users WHERE id = ?').get(u.user.id);
    expect(row.public_profile).toBe(0);
  });
});

describe('Support tickets', () => {
  it('create → list → get → reply → close lifecycle', async () => {
    const u = await reg();
    // Create
    const create = await request(app).post('/api/support/tickets')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({ subject: 'Bot stuck', body: 'My BTC bot has not opened a trade in 3 days' });
    expect(create.status).toBe(201);
    expect(create.body.subject).toBe('Bot stuck');
    expect(create.body.status).toBe('open');
    const ticketId = create.body.id;

    // List
    const list = await request(app).get('/api/support/tickets')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(list.body.tickets).toHaveLength(1);

    // Get with messages
    const get = await request(app).get('/api/support/tickets/' + ticketId)
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(get.body.messages).toHaveLength(1);
    expect(get.body.messages[0].isAdmin).toBe(false);

    // Reply
    const reply = await request(app).post('/api/support/tickets/' + ticketId + '/reply')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({ body: 'Adding more info: the scanner seems frozen' });
    expect(reply.status).toBe(200);
    expect(reply.body.messages).toHaveLength(2);

    // Close
    const close = await request(app).post('/api/support/tickets/' + ticketId + '/close')
      .set('Authorization', 'Bearer ' + u.accessToken).send({});
    expect(close.status).toBe(200);
  });

  it('cannot access another user\'s ticket', async () => {
    const u1 = await reg('u1@x.com');
    const u2 = await reg('u2@x.com');
    const create = await request(app).post('/api/support/tickets')
      .set('Authorization', 'Bearer ' + u1.accessToken)
      .send({ subject: 'Test', body: 'private content here longer than ten chars' });
    const res = await request(app).get('/api/support/tickets/' + create.body.id)
      .set('Authorization', 'Bearer ' + u2.accessToken);
    expect(res.status).toBe(403);
  });

  it('admin can list all tickets, regular user cannot', async () => {
    const u = await reg('user@x.com');
    const admin = await reg('admin@x.com');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
    await request(app).post('/api/support/tickets')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({ subject: 'Hello', body: 'A message long enough for the validator' });

    // Re-login admin to get a token with is_admin=1
    const adminLogin = await request(app).post('/api/auth/login')
      .send({ email: 'admin@x.com', password: 'Abcdef123' });
    const adminTok = adminLogin.body.accessToken;

    const forbidden = await request(app).get('/api/support/admin/tickets')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(forbidden.status).toBe(403);

    const ok = await request(app).get('/api/support/admin/tickets')
      .set('Authorization', 'Bearer ' + adminTok);
    expect(ok.status).toBe(200);
    expect(ok.body.tickets.length).toBeGreaterThanOrEqual(1);
    expect(ok.body.tickets[0].userEmail).toBeTruthy();
  });

  it('validates min subject length', async () => {
    const u = await reg();
    const res = await request(app).post('/api/support/tickets')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({ subject: 'x', body: 'this body is long enough' });
    expect(res.status).toBe(400);
  });
});
