// RC-14: create-PT lock tests need a fresh D1 (this file is isolated from single-pt.test.mjs).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { db, seedUser, jsonRequest } from './helpers.mjs';

const overlay = (over = {}) => Object.assign(Object.create(null), env, over);
const single = (over = {}) => overlay({ MULTI_PT_ENABLED: 'false', ...over });
const multi = (over = {}) => overlay({ MULTI_PT_ENABLED: 'true', ...over });
const send = (req, e) => worker.fetch(req, e);
const jsonOf = async res => JSON.parse(await res.text());
const ptBody = (slug, create_key = crypto.randomUUID(), over = {}) => ({
  create_key, slug, brand_name: 'Test Studio', tagline: 'Strong every week',
  description: 'Small group strength classes.', about: 'Six-week blocks for all levels.',
  accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'],
  owner_name: 'Test Trainer', email: `${slug}@example.com`, published: true, ...over
});

describe('POST /api/admin/pts single-PT lock', () => {
  it('two simultaneous different-key creates yield exactly one PT; replay works; a further create is 409 (single_pt_free)', async () => {
    const admin = await seedUser({ role: 'admin' });
    expect((await db().get('SELECT count(*) n FROM pts')).n).toBe(0);
    const bodies = [0, 1].map(i => ptBody('lock-' + i + '-' + crypto.randomUUID().slice(0, 6)));
    const res = await Promise.all(bodies.map(b => send(jsonRequest(admin, 'POST', '/api/admin/pts', b), single())));
    const results = await Promise.all(res.map(async (r, i) => ({ status: r.status, body: await jsonOf(r), input: bodies[i] })));
    const created = results.filter(r => r.status === 201);
    const conflicted = results.filter(r => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].body).toMatchObject({ code: 'SINGLE_PT_EXISTS', error: 'This site already has its coach.' });
    expect((await db().get('SELECT count(*) n FROM pts')).n).toBe(1);

    const replay = await send(jsonRequest(admin, 'POST', '/api/admin/pts', created[0].input), single());
    expect(replay.status).toBe(201);
    expect(await jsonOf(replay)).toMatchObject({ pt_id: created[0].body.pt_id, replay: true });

    const further = await send(jsonRequest(admin, 'POST', '/api/admin/pts', ptBody('other-' + crypto.randomUUID().slice(0, 8))), single());
    expect(further.status).toBe(409);
    expect(await jsonOf(further)).toMatchObject({ code: 'SINGLE_PT_EXISTS' });
  });

  it('when MULTI_PT_ENABLED=true, a second PT can still be created', async () => {
    const admin = await seedUser({ role: 'admin' });
    const a = await send(jsonRequest(admin, 'POST', '/api/admin/pts', ptBody('multi-a-' + crypto.randomUUID().slice(0, 6))), multi());
    const b = await send(jsonRequest(admin, 'POST', '/api/admin/pts', ptBody('multi-b-' + crypto.randomUUID().slice(0, 6))), multi());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await jsonOf(a)).pt_id).not.toBe((await jsonOf(b)).pt_id);
  });
});
