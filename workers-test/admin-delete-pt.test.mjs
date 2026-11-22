// RC-31: admin soft-delete of a PT account.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { write } from '../src/writer.mjs';
import { db, seedUser, seedBlock, jsonRequest, insertBooking, getRequest } from './helpers.mjs';

const send = (req, e = env) => worker.fetch(req, e);
const jsonOf = async res => JSON.parse(await res.text());
const cookieFrom = res => (res.headers.get('set-cookie') || '').match(/fit_session=([^;]+)/)?.[1] || null;
const ptBody = (slug, create_key = crypto.randomUUID(), over = {}) => ({
  create_key, slug, brand_name: 'Test Studio', tagline: 'Strong every week',
  description: 'Small group strength classes.', about: 'Six-week blocks for all levels.',
  accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'],
  owner_name: 'Test Trainer', email: `${slug}@example.com`, published: true, ...over
});

async function createLivePt(admin, slug = 'coach-' + crypto.randomUUID().slice(0, 8)) {
  const body = ptBody(slug);
  const res = await send(jsonRequest(admin, 'POST', '/api/admin/pts', body));
  const data = await jsonOf(res);
  expect(res.status, JSON.stringify(data)).toBe(201);
  return { ...data, slug, email: body.email, temporary_password: data.temporary_password };
}

async function addBlock(ptId, { future = true, published = 1, closed = 0 } = {}) {
  const blockId = 'block-' + crypto.randomUUID();
  const starts = future ? '2099-01-05T18:30' : '2001-01-05T18:30';
  const epoch = future ? Date.UTC(2099, 0, 5, 18, 30) : Date.UTC(2001, 0, 5, 18, 30);
  const d = db();
  await d.batch([
    d.stmt('INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capacity,published,closed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      blockId, ptId, 'Strength', 'Six weeks', 'Studio', 1500, 5, published, closed, Date.now()),
    d.stmt('INSERT INTO class_sessions VALUES(?,?,?,?,?)', blockId + '-s0', blockId, starts, epoch, 60)
  ]);
  return blockId;
}

describe('DELETE /api/admin/pts/:id', () => {
  it('non-admin 403, missing CSRF 403, unknown id 404, admin/self target 403', async () => {
    const admin = await seedUser({ role: 'admin' });
    const created = await createLivePt(admin);
    const ptOwner = await db().get("SELECT id FROM users WHERE pt_id=? AND role='pt'", created.pt_id);
    const customer = await seedUser({ role: 'customer' });
    const asPt = await seedUser({ role: 'pt', ptId: created.pt_id });

    const asCustomer = await send(jsonRequest(customer, 'DELETE', '/api/admin/pts/' + created.pt_id));
    expect(asCustomer.status).toBe(403);
    const asTrainer = await send(jsonRequest(asPt, 'DELETE', '/api/admin/pts/' + created.pt_id));
    expect(asTrainer.status).toBe(403);

    const noCsrf = await send(new Request('http://example.test/api/admin/pts/' + created.pt_id, {
      method: 'DELETE',
      headers: { origin: 'http://example.test', cookie: 'fit_session=' + admin.token, 'content-type': 'application/json' },
      body: '{}'
    }));
    expect(noCsrf.status).toBe(403);

    const missing = await send(jsonRequest(admin, 'DELETE', '/api/admin/pts/' + crypto.randomUUID()));
    expect(missing.status).toBe(404);

    await db().run("UPDATE users SET role='admin' WHERE id=?", ptOwner.id);
    const otherAdmin = await send(jsonRequest(admin, 'DELETE', '/api/admin/pts/' + created.pt_id));
    expect(otherAdmin.status).toBe(403);
    expect(await jsonOf(otherAdmin)).toMatchObject({ code: 'ADMIN_PROTECTED' });
    await db().run("UPDATE users SET role='pt' WHERE id=?", ptOwner.id);

    const { ptId: selfPt } = await seedBlock({ customers: 0 });
    await db().run('UPDATE users SET pt_id=? WHERE id=?', selfPt, admin.id);
    const self = await send(jsonRequest(admin, 'DELETE', '/api/admin/pts/' + selfPt));
    expect(self.status).toBe(403);
    expect(await jsonOf(self)).toMatchObject({ code: 'ADMIN_PROTECTED' });
    expect((await db().get('SELECT deleted_at FROM pts WHERE id=?', created.pt_id)).deleted_at).toBeNull();
    expect((await db().get('SELECT deleted_at FROM pts WHERE id=?', selfPt)).deleted_at).toBeNull();
  });

  it('409 with upcoming count then force succeeds: sessions, classes, slug, history, audit, login, refund account id', async () => {
    const admin = await seedUser({ role: 'admin' });
    const created = await createLivePt(admin);
    const login = await send(jsonRequest(null, 'POST', '/api/auth/login', { email: created.email, password: created.temporary_password }));
    expect(login.status).toBe(200);
    const ptSession = { token: cookieFrom(login), csrf: (await jsonOf(login)).csrf };
    expect(ptSession.token).toBeTruthy();

    const blockId = await addBlock(created.pt_id, { future: true });
    const pastBlock = await addBlock(created.pt_id, { future: false });
    const customer = await seedUser({ role: 'customer' });
    const bookingId = await insertBooking({
      blockId, customerId: customer.id, status: 'paid', mode: 'stripe_test',
      extra: { payment_intent: 'pi_test_' + crypto.randomUUID().replaceAll('-', ''), stripe_account_id: 'acct_live_keep', stripe_routing: 'connected' }
    });
    const pastPaid = await insertBooking({ blockId: pastBlock, customerId: customer.id, status: 'paid', mode: 'demo' });
    const expiredPending = await insertBooking({
      blockId, customerId: (await seedUser({ role: 'customer' })).id, status: 'pending', mode: 'demo', expiresAt: Date.now() - 60000
    });
    const hookId = 'evt_' + crypto.randomUUID();
    const d = db();
    await d.batch([
      d.stmt("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready,updated_at) VALUES(?,'stripe_test',?,'connected',1,0)", created.pt_id, 'acct_live_keep'),
      d.stmt('UPDATE pts SET stripe_account=?,stripe_ready=1 WHERE id=?', 'acct_live_keep', created.pt_id),
      d.stmt('INSERT INTO webhook_events(id,created_at) VALUES(?,?)', hookId, Date.now())
    ]);

    const blocked = await send(jsonRequest(admin, 'DELETE', '/api/admin/pts/' + created.pt_id));
    expect(blocked.status).toBe(409);
    expect(await jsonOf(blocked)).toMatchObject({ code: 'UPCOMING_BOOKINGS', upcoming_count: 1 });
    expect((await db().get('SELECT deleted_at FROM pts WHERE id=?', created.pt_id)).deleted_at).toBeNull();

    const forced = await send(jsonRequest(admin, 'DELETE', '/api/admin/pts/' + created.pt_id + '?force=1'));
    expect(forced.status).toBe(200);
    expect(await jsonOf(forced)).toMatchObject({ ok: true, pt_id: created.pt_id });

    // Alias is accepted too (already deleted -> 404), and the canonical route is /api/admin/pts/:id.
    const aliasAgain = await send(jsonRequest(admin, 'DELETE', '/api/admin/trainers/' + created.pt_id + '?force=1'));
    expect(aliasAgain.status).toBe(404);

    expect((await send(getRequest(ptSession, '/api/dashboard'))).status).toBe(401);

    const blocks = await db().all('SELECT published,closed FROM blocks WHERE pt_id=?', created.pt_id);
    expect(blocks.length).toBe(2);
    expect(blocks.every(b => b.published === 0 && b.closed === 1)).toBe(true);

    const ptRow = await db().get('SELECT slug,published,deleted_at,stripe_account,stripe_ready,create_key FROM pts WHERE id=?', created.pt_id);
    expect(ptRow.slug).toBe('deleted-' + created.pt_id);
    expect(ptRow.published).toBe(0);
    expect(ptRow.deleted_at).toBeGreaterThan(0);
    expect(ptRow.stripe_account).toBe('acct_live_keep');
    expect(ptRow.stripe_ready).toBe(0);
    expect(ptRow.create_key).toBeNull();

    const page = await send(new Request('http://example.test/api/public/pts/' + created.slug));
    expect(page.status).toBe(404);

    expect(await db().get('SELECT id,status,stripe_account_id,payment_intent FROM bookings WHERE id=?', bookingId)).toMatchObject({
      id: bookingId, status: 'paid', stripe_account_id: 'acct_live_keep'
    });
    expect(await db().get('SELECT id,status FROM bookings WHERE id=?', pastPaid)).toMatchObject({ id: pastPaid, status: 'paid' });
    expect(await db().get('SELECT id,status FROM bookings WHERE id=?', expiredPending)).toMatchObject({ id: expiredPending, status: 'pending' });
    expect(await db().get('SELECT id FROM webhook_events WHERE id=?', hookId)).toMatchObject({ id: hookId });
    expect(await db().get('SELECT pt_id FROM stripe_connections WHERE pt_id=?', created.pt_id)).toBeNull();

    const audit = await db().get("SELECT action,user_id,target_id FROM audit_log WHERE action='pt_deleted' AND target_id=?", created.pt_id);
    expect(audit).toMatchObject({ action: 'pt_deleted', user_id: admin.id, target_id: created.pt_id });

    const relogin = await send(jsonRequest(null, 'POST', '/api/auth/login', { email: created.email, password: created.temporary_password }));
    expect(relogin.status).toBe(401);

    const dash = await jsonOf(await send(getRequest(admin, '/api/dashboard')));
    expect(dash.pts.map(p => p.id)).not.toContain(created.pt_id);

    const jobId = await write(env, 'prepareRefund', {
      bookingId, userId: admin.id, token: 'refund-token-' + crypto.randomUUID().slice(0, 8), mode: 'stripe_test'
    });
    const job = await db().get('SELECT payload FROM stripe_jobs WHERE id=?', jobId);
    expect(JSON.parse(job.payload).account).toBe('acct_live_keep');
  });
});
