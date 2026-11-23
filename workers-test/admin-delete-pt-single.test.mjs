// RC-31: isolated D1 — deleting the only PT in single-PT mode must allow a recreate.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { db, seedUser, jsonRequest } from './helpers.mjs';

const single = (over = {}) => Object.assign(Object.create(null), env, { MULTI_PT_ENABLED: 'false', ...over });
const send = (req, e = single()) => worker.fetch(req, e);
const jsonOf = async res => JSON.parse(await res.text());
const ptBody = (slug, create_key = crypto.randomUUID(), over = {}) => ({
  create_key, slug, brand_name: 'Test Studio', tagline: 'Strong every week',
  description: 'Small group strength classes.', about: 'Six-week blocks for all levels.',
  accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'],
  owner_name: 'Test Trainer', email: `${slug}@example.com`, published: true, ...over
});

describe('DELETE /api/admin/pts/:id (single-PT)', () => {
  it('deleting the only PT frees the slug and a new PT can be created with it; trainers alias works', async () => {
    const admin = await seedUser({ role: 'admin' });
    const slug = 'solo-' + crypto.randomUUID().slice(0, 8);
    const createdRes = await send(jsonRequest(admin, 'POST', '/api/admin/pts', ptBody(slug)));
    const created = await jsonOf(createdRes);
    expect(createdRes.status, JSON.stringify(created)).toBe(201);
    expect((await db().get('SELECT count(*) n FROM pts WHERE deleted_at IS NULL')).n).toBe(1);

    const siteBefore = await jsonOf(await send(new Request('http://example.test/api/public/site')));
    expect(siteBefore.pt.slug).toBe(slug);

    const del = await send(jsonRequest(admin, 'DELETE', '/api/admin/trainers/' + created.pt_id));
    expect(del.status).toBe(200);
    expect((await db().get('SELECT count(*) n FROM pts WHERE deleted_at IS NULL')).n).toBe(0);

    const siteAfter = await jsonOf(await send(new Request('http://example.test/api/public/site')));
    expect(siteAfter.pt).toBeNull();
    expect((await send(new Request('http://example.test/api/public/pts/' + slug))).status).toBe(404);

    const again = await send(jsonRequest(admin, 'POST', '/api/admin/pts', ptBody(slug)));
    const body = await jsonOf(again);
    expect(again.status, JSON.stringify(body)).toBe(201);
    expect(body.pt_id).not.toBe(created.pt_id);
    expect((await db().get('SELECT slug,deleted_at FROM pts WHERE id=?', body.pt_id))).toMatchObject({ slug, deleted_at: null });
    expect((await db().get('SELECT count(*) n FROM pts WHERE deleted_at IS NULL')).n).toBe(1);

    const siteNew = await jsonOf(await send(new Request('http://example.test/api/public/site')));
    expect(siteNew.pt.slug).toBe(slug);
  });
});
