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

let app, db;
beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
});
beforeEach(() => {
  db.prepare('DELETE FROM support_messages').run();
  db.prepare('DELETE FROM support_tickets').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

async function reg(email = 'x@x.com') {
  return (await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' })).body;
}
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
