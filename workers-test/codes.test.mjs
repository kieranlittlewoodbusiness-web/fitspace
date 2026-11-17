import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { claimCode } from '../src/ops/codes.mjs';
import { write } from '../src/writer.mjs';
import { db, seedBlock, tally } from './helpers.mjs';

async function seedCode(maxUses) {
  const { ptId, users } = await seedBlock({ customers: 1 });
  const id = 'code-' + crypto.randomUUID();
  await db().run("INSERT INTO discount_codes(id,code,owner,pt_id,scope,kind,amount,max_uses,created_by,created_at) VALUES(?,?,'pt',?,'all_classes','percent',10,?,?,?)", id, 'SPRING' + id.slice(-6), ptId, maxUses, users[0].id, Date.now());
  return id;
}

describe('discount code max_uses', () => {
  it('20 concurrent single-statement claims with max_uses=5 succeed exactly 5 times (no queue)', async () => {
    const id = await seedCode(5);
    const d = db();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => claimCode(d, { codeId: id })));
    const outcome = results.map(r => (r.status === 'fulfilled' ? 'claimed' : r.reason.status === 409 ? 'limit' : 'error'));
    const row = await d.get('SELECT uses,max_uses FROM discount_codes WHERE id=?', id);
    console.log('claimCode x20 max_uses 5:', JSON.stringify(tally(outcome)), 'uses:', row.uses);
    expect(tally(outcome)).toEqual({ claimed: 5, limit: 15 });
    expect(row.uses).toBe(5);
  });

  it('the same claim through the Writer also stops at max_uses', async () => {
    const id = await seedCode(3);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => write(env, 'claimCode', { codeId: id })));
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(3);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409)).toBe(true);
  });

  it('the CHECK constraint refuses uses > max_uses even for an unguarded UPDATE', async () => {
    const id = await seedCode(1);
    await db().run('UPDATE discount_codes SET uses=1 WHERE id=?', id);
    await expect(db().run('UPDATE discount_codes SET uses=uses+1 WHERE id=?', id)).rejects.toThrow(/CHECK constraint failed/);
  });
});
