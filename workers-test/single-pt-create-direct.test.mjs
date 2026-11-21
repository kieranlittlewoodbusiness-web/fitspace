// RC-14: Writer-bypassed concurrent create, isolated D1 so the table starts empty.
import { describe, it, expect } from 'vitest';
import { createPt } from '../src/ops/manage.mjs';
import { db, seedUser } from './helpers.mjs';

const ptBody = (slug) => ({
  create_key: crypto.randomUUID(), slug, brand_name: 'Test Studio', tagline: 'Strong every week',
  description: 'Small group strength classes.', about: 'Six-week blocks for all levels.',
  accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'],
  owner_name: 'Test Trainer', email: `${slug}@example.com`, published: true
});

describe('createPt single-PT lock (Writer bypassed)', () => {
  it('two concurrent different-key creates insert only one PT (single_pt_free)', async () => {
    const admin = await seedUser({ role: 'admin' });
    expect((await db().get('SELECT count(*) n FROM pts')).n).toBe(0);
    const jobs = [0, 1].map(i => createPt(db(), {
      userId: admin.id, body: ptBody('direct-' + i + '-' + crypto.randomUUID().slice(0, 6)),
      temporaryHash: 'x', temporary: 'TempPass1234!', multiPt: false
    }));
    const out = await Promise.allSettled(jobs);
    const ok = out.filter(o => o.status === 'fulfilled');
    const fail = out.filter(o => o.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);
    expect(fail[0].reason.code).toBe('SINGLE_PT_EXISTS');
    expect((await db().get('SELECT count(*) n FROM pts')).n).toBe(1);
  });
});
