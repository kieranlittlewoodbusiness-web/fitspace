// Cron Trigger (scheduled()): email delivery with a claim lease + Resend Idempotency-Key,
// and housekeeping. Resend is MOCKED (vi.spyOn(fetch)); no email leaves the test.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { runScheduled } from '../src/mail.mjs';
import { db, seedBlock, insertBooking, ORIGIN } from './helpers.mjs';

const sendEnv = (over = {}) => Object.assign(Object.create(null), env, { EMAIL_MODE: 'send' }, over);
afterEach(() => vi.restoreAllMocks());

function mockResend(status = () => 200) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.resend.com/')) throw new Error('unexpected host in test');
    const body = JSON.parse(init.body);
    calls.push({ key: new Headers(init.headers).get('Idempotency-Key'), to: body.to[0], subject: body.subject, text: body.text, reply_to: body.reply_to });
    await new Promise(r => setTimeout(r, 15));
    const s = status(calls.length);
    return new Response(JSON.stringify(s === 200 ? { id: 'email_' + calls.length } : { message: 'provider down' }), { status: s, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}
async function outboxRow(ptId, recipient) {
  const id = 'ob-' + crypto.randomUUID();
  await db().run("INSERT INTO email_outbox(id,pt_id,customer_id,dedupe_key,recipient,subject,body,kind,status,created_at) VALUES(?,?,NULL,?,?,?,?,?,?,?)", id, ptId, 'dk-' + id, recipient, 'Booked', 'See you there', 'confirmation', 'queued', Date.now());
  return id;
}

describe('cron email delivery', () => {
  it('two overlapping cron runs send each email once; example.com is suppressed; reply_to is the PT', async () => {
    const s = await seedBlock({ customers: 0 });
    await db().run("INSERT INTO users(id,name,email,password_hash,role,pt_id,created_at) VALUES(?,?,?,'x','pt',?,?)", 'u-' + s.ptId, 'Owner', s.ptId + '@trainer.test', s.ptId, Date.now());
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await outboxRow(s.ptId, `customer${i}-${s.ptId.slice(3, 11)}@customer.test`));
    const demo = await outboxRow(s.ptId, 'demo@example.com');
    const calls = mockResend();
    const [a, b] = await Promise.all([runScheduled(sendEnv(), db()), runScheduled(sendEnv(), db())]);
    const perKey = calls.reduce((m, c) => ((m[c.key] = (m[c.key] || 0) + 1), m), {});
    console.log('overlapping cron runs:', JSON.stringify({ a: a.outbox, b: b.outbox }), 'Resend calls', calls.length, 'max per key', Math.max(...Object.values(perKey)));
    expect(calls).toHaveLength(4);
    expect(Object.values(perKey).every(n => n === 1)).toBe(true);
    expect(a.outbox.sent + b.outbox.sent).toBe(4);
    expect(calls.every(c => c.reply_to === s.ptId + '@trainer.test')).toBe(true);
    const rows = await db().all(`SELECT id,status FROM email_outbox WHERE id IN (${[...ids, demo].map(() => '?').join(',')})`, ...ids, demo);
    expect(rows.filter(r => r.status === 'sent')).toHaveLength(4);
    expect(rows.find(r => r.id === demo).status).toBe('preview');
    // A third run has nothing to do.
    expect((await runScheduled(sendEnv(), db())).outbox.sent).toBe(0);
  });

  it('a provider failure backs off (failed, attempts+1, next_attempt_at in the future), then a later run sends it', async () => {
    const s = await seedBlock({ customers: 0 });
    const id = await outboxRow(s.ptId, 'retry-' + s.ptId.slice(3, 11) + '@customer.test');
    mockResend(() => 500);
    const t0 = Date.now();
    await runScheduled(sendEnv(), db(), t0);
    const failed = await db().get('SELECT status,attempts,next_attempt_at FROM email_outbox WHERE id=?', id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.next_attempt_at).toBeGreaterThan(t0 + 30000);
    vi.restoreAllMocks();
    const calls = mockResend();
    expect((await runScheduled(sendEnv(), db(), t0 + 1000)).outbox.sent).toBe(0); // still backing off
    expect((await runScheduled(sendEnv(), db(), failed.next_attempt_at + 1)).outbox.sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('dk-' + id); // same Idempotency-Key on the retry
  });

  it('EMAIL_MODE=preview: nothing is sent; housekeeping still expires holds', async () => {
    const s = await seedBlock({ customers: 1 });
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', expiresAt: Date.now() - 1 });
    await outboxRow(s.ptId, 'p-' + s.ptId.slice(3, 11) + '@customer.test');
    const calls = mockResend();
    const r = await runScheduled(sendEnv({ EMAIL_MODE: 'preview' }), db());
    expect(r.outbox.skipped).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('expired');
  });

  it('password reset mail: the link is sent once by cron; a used link is dropped, not sent', async () => {
    const email = `reset-${crypto.randomUUID().slice(0, 8)}@customer.test`;
    const signup = await exports.default.fetch(new Request(ORIGIN + '/api/auth/signup', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' }, body: JSON.stringify({ name: 'Reset Me', email, password: 'Correct-horse-9', demo_acknowledged: true }) }));
    expect(signup.status).toBe(201);
    const forgot = () => exports.default.fetch(new Request(ORIGIN + '/api/auth/forgot-password', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.11' }, body: JSON.stringify({ email }) }));
    expect((await forgot()).status).toBe(200);
    const all = mockResend();
    const authCalls = () => all.filter(c => c.key.startsWith('fitspace-auth:'));
    const [a, b] = await Promise.all([runScheduled(sendEnv(), db()), runScheduled(sendEnv(), db())]);
    expect(a.auth.sent + b.auth.sent).toBe(1);
    const calls = authCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/\/reset-password#/);
    expect(calls[0].key).toMatch(/^fitspace-auth:/);
    // Second request; the link is used before cron runs -> dropped.
    await db().run('DELETE FROM password_reset_limits');
    expect((await forgot()).status).toBe(200);
    await db().run("UPDATE password_resets SET used_at=? WHERE used_at IS NULL", Date.now());
    const r = await runScheduled(sendEnv(), db());
    expect(r.auth).toMatchObject({ sent: 0, dropped: 1 });
    expect(authCalls()).toHaveLength(1);
  });

  it('scheduled() is wired: the default export runs the cron body via waitUntil', async () => {
    mockResend();
    const waits = [];
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, sendEnv({ EMAIL_MODE: 'preview' }), { waitUntil: p => waits.push(p) });
    expect(waits).toHaveLength(1);
    await waits[0];
  });

  it('Reply-To uses the PT profile address and name; injected CR/LF falls back to the login email', async () => {
    const s = await seedBlock({ customers: 0 });
    await db().run("INSERT INTO users(id,name,email,password_hash,role,pt_id,created_at) VALUES(?,?,?,'x','pt',?,?)", 'u-' + s.ptId, 'Owner', s.ptId + '@trainer.test', s.ptId, Date.now());
    await db().run("UPDATE pts SET reply_to_email=?,reply_to_name=? WHERE id=?", 'bookings@studio.test', 'Studio Bookings', s.ptId);
    const okId = await outboxRow(s.ptId, 'ok-' + s.ptId.slice(3, 11) + '@customer.test');
    const calls = mockResend();
    expect((await runScheduled(sendEnv(), db())).outbox.sent).toBe(1);
    expect(calls[0].reply_to).toBe('Studio Bookings <bookings@studio.test>');

    await db().run("UPDATE pts SET reply_to_email=?,reply_to_name=? WHERE id=?", 'bookings@studio.test\r\nBcc: attacker@evil.test', 'Coach', s.ptId);
    const badId = await outboxRow(s.ptId, 'bad-' + s.ptId.slice(3, 11) + '@customer.test');
    expect(badId).not.toBe(okId);
    expect((await runScheduled(sendEnv(), db())).outbox.sent).toBe(1);
    const injected = calls[1].reply_to;
    expect(injected).toBe('Coach <' + s.ptId + '@trainer.test>');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(JSON.stringify(calls[1])).not.toMatch(/Bcc:/i);
  });
});
