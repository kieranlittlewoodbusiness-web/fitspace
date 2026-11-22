import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { db, seedBlock, seedUser, getRequest, jsonRequest, ORIGIN } from './helpers.mjs';
import { publicContactFields, replyToForSend } from '../src/profile.mjs';

const jsonOf = async res => { const text = await res.text(); try { return JSON.parse(text); } catch { return { raw: text }; } };
const send = (req, e = env) => exports.default.fetch(req, e);

async function seedTrainer() {
  const s = await seedBlock({ customers: 1 });
  const pt = await seedUser({ role: 'pt', ptId: s.ptId });
  const admin = await seedUser({ role: 'admin' });
  return { ...s, pt, admin };
}

const contact = {
  business_name: 'Resilience Coaching Ltd',
  contact_email: 'hello@resiliencecoaching.app',
  contact_phone: '+44 7700 900123',
  reply_to_email: 'bookings@mail.resiliencecoaching.app',
  reply_to_name: 'Resilience Bookings',
  venue_name: 'The Studio',
  venue_address: '1 High Street, London',
  cancellation_window_hours: 24,
  photo_url: 'https://cdn.example.com/coach.jpg'
};

describe('PT profile API', () => {
  it('GET /api/pt/profile returns display_name from brand_name and bio from about', async () => {
    const s = await seedTrainer();
    const res = await send(getRequest(s.pt, '/api/pt/profile'));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.pt).toMatchObject({
      id: s.ptId,
      display_name: 'Test PT',
      bio: 'About text here',
      slug: s.ptId,
      published: true,
      business_name: null,
      contact_email: null,
      contact_phone: null,
      reply_to_email: null,
      reply_to_name: null,
      venue_name: null,
      venue_address: null,
      cancellation_window_hours: null,
      photo_url: null
    });
  });

  it('customers, admins and anonymous callers cannot read or write the PT profile', async () => {
    const s = await seedTrainer();
    const anonGet = await send(new Request(ORIGIN + '/api/pt/profile'));
    const customerGet = await send(getRequest(s.users[0], '/api/pt/profile'));
    const adminGet = await send(getRequest(s.admin, '/api/pt/profile'));
    expect([anonGet.status, customerGet.status, adminGet.status]).toEqual([401, 403, 403]);
    const customerPatch = await send(jsonRequest(s.users[0], 'PATCH', '/api/pt/profile', { venue_name: 'Nope' }));
    const adminPatch = await send(jsonRequest(s.admin, 'PATCH', '/api/pt/profile', { venue_name: 'Nope' }));
    expect(customerPatch.status).toBe(403);
    expect(adminPatch.status).toBe(403);
  });

  it('PATCH requires CSRF; partial updates work; PUT is accepted; unknown and slug fields are rejected', async () => {
    const s = await seedTrainer();
    const noCsrf = await send(new Request(ORIGIN + '/api/pt/profile', {
      method: 'PATCH',
      headers: { origin: ORIGIN, cookie: 'fit_session=' + s.pt.token, 'content-type': 'application/json' },
      body: JSON.stringify({ venue_name: 'Hall' })
    }));
    expect(noCsrf.status).toBe(403);

    const partial = await jsonOf(await send(jsonRequest(s.pt, 'PATCH', '/api/pt/profile', { venue_name: 'Village Hall', contact_email: 'Coach@Example.COM' })));
    expect(partial.pt.venue_name).toBe('Village Hall');
    expect(partial.pt.contact_email).toBe('coach@example.com');
    expect(partial.pt.display_name).toBe('Test PT');
    expect(partial.pt.bio).toBe('About text here');

    const put = await jsonOf(await send(jsonRequest(s.pt, 'PUT', '/api/pt/profile', { display_name: 'Coach Name', ...contact })));
    expect(put.pt).toMatchObject({ display_name: 'Coach Name', bio: 'About text here', ...contact, contact_email: 'hello@resiliencecoaching.app' });
    expect((await db().get('SELECT brand_name,about FROM pts WHERE id=?', s.ptId))).toEqual({ brand_name: 'Coach Name', about: 'About text here' });

    const unknown = await send(jsonRequest(s.pt, 'PATCH', '/api/pt/profile', { slug: 'hijack', mystery: 'x' }));
    const denied = await jsonOf(unknown);
    expect(unknown.status).toBe(400);
    expect(denied.code).toBe('VALIDATION_FAILED');
    expect(denied.fields.slug).toMatch(/cannot be changed/i);
    expect(denied.fields.mystery).toMatch(/cannot be updated/i);
    expect((await db().get('SELECT slug FROM pts WHERE id=?', s.ptId)).slug).toBe(s.ptId);
  });

  it('rejects invalid email, phone, http photo_url and cancellation window with a fields map', async () => {
    const s = await seedTrainer();
    const res = await send(jsonRequest(s.pt, 'PATCH', '/api/pt/profile', {
      contact_email: 'not-an-email',
      contact_phone: 'abc',
      photo_url: 'http://insecure.example.com/p.jpg',
      cancellation_window_hours: 721
    }));
    const body = await jsonOf(res);
    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields.contact_email).toBeTruthy();
    expect(body.fields.contact_phone).toBeTruthy();
    expect(body.fields.photo_url).toMatch(/https/i);
    expect(body.fields.cancellation_window_hours).toMatch(/0 to 720/);
  });

  it('public payloads include display_name and set contact fields, omit blanks, and never expose reply_to', async () => {
    const s = await seedTrainer();
    await send(jsonRequest(s.pt, 'PATCH', '/api/pt/profile', {
      ...contact,
      venue_name: '  ',
      venue_address: null
    }));
    const site = await jsonOf(await send(new Request(ORIGIN + '/api/public/site')));
    const page = await jsonOf(await send(new Request(ORIGIN + '/api/public/pts/' + s.ptId)));
    const list = await jsonOf(await send(new Request(ORIGIN + '/api/public/pts')));
    const mine = list.pts.find(p => p.id === s.ptId);
    expect(mine).toBeTruthy();
    for (const pt of [page.pt, mine]) {
      expect(pt.display_name).toBe('Test PT');
      expect(pt.business_name).toBe('Resilience Coaching Ltd');
      expect(pt.contact_email).toBe('hello@resiliencecoaching.app');
      expect(pt.contact_phone).toBe('+44 7700 900123');
      expect(pt.cancellation_window_hours).toBe(24);
      expect(pt).not.toHaveProperty('venue_name');
      expect(pt).not.toHaveProperty('venue_address');
      expect(pt).not.toHaveProperty('reply_to_email');
      expect(pt).not.toHaveProperty('reply_to_name');
      expect(pt).not.toHaveProperty('photo_url');
    }
    for (const pt of [site.pt, ...list.pts].filter(Boolean)) {
      expect(pt).not.toHaveProperty('reply_to_email');
      expect(pt).not.toHaveProperty('reply_to_name');
      expect(pt).not.toHaveProperty('photo_url');
    }
    expect(publicContactFields({ brand_name: 'A', business_name: '', contact_email: null, cancellation_window_hours: 0 })).toEqual({
      display_name: 'A',
      cancellation_window_hours: 0
    });
  });

  it('GET /api/dashboard pt payload includes profile fields and profile_missing', async () => {
    const s = await seedTrainer();
    const before = await jsonOf(await send(getRequest(s.pt, '/api/dashboard')));
    expect(before.pt.display_name).toBe('Test PT');
    expect(before.pt.bio).toBe('About text here');
    expect(before.pt.reply_to_email).toBe(null);
    expect(before.pt.profile_missing).toEqual(['business_name', 'contact_email']);

    await send(jsonRequest(s.pt, 'PATCH', '/api/pt/profile', { business_name: 'Resilience Coaching Ltd' }));
    const mid = await jsonOf(await send(getRequest(s.pt, '/api/dashboard')));
    expect(mid.pt.profile_missing).toEqual(['contact_email']);
    expect(mid.pt.business_name).toBe('Resilience Coaching Ltd');

    await send(jsonRequest(s.pt, 'PATCH', '/api/pt/profile', { contact_email: 'hello@resiliencecoaching.app' }));
    const after = await jsonOf(await send(getRequest(s.pt, '/api/dashboard')));
    expect(after.pt.profile_missing).toEqual([]);
    expect(after.pt.contact_email).toBe('hello@resiliencecoaching.app');
  });
});

describe('reply-to header safety', () => {
  it('uses the custom address and name, falls back to the login email, and strips CR/LF', () => {
    expect(replyToForSend({ replyToEmail: 'coach@studio.test', replyToName: 'Coach', loginEmail: 'login@studio.test' })).toBe('Coach <coach@studio.test>');
    expect(replyToForSend({ loginEmail: 'login@studio.test' })).toBe('login@studio.test');
    const injected = replyToForSend({
      replyToEmail: 'coach@studio.test\r\nBcc: attacker@evil.test',
      replyToName: 'Nice\nName',
      loginEmail: 'login@studio.test'
    });
    expect(injected).toBe('NiceName <login@studio.test>');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).not.toMatch(/Bcc:/i);
  });
});
