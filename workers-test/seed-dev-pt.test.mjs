import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { seedDevPtSql } from '../scripts/seed-dev-pt.mjs';
import { db } from './helpers.mjs';
import { verifyPassword } from '../src/util.mjs';

describe('dev seed (SQL only, local)', () => {
  it('inserts one published PT and user, stores only a hash, and is a no-op the second time', async () => {
    const password = 'Local only ' + crypto.randomUUID();
    const sql = seedDevPtSql({ email: 'local-coach@example.com', password, ownerName: "O'Coach" });
    expect(sql).not.toContain(password);
    await env.DB.exec(sql.trim());
    await env.DB.exec(seedDevPtSql({ email: 'other@example.com', password: 'AnotherPass123!' }).trim());
    const pts = await db().all('SELECT slug,brand_name,published FROM pts WHERE slug=?', 'local-coach');
    const users = await db().all("SELECT name,email,role,password_hash FROM users WHERE email='local-coach@example.com'");
    expect(pts).toEqual([{ slug: 'local-coach', brand_name: 'Local Coach', published: 1 }]);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: "O'Coach", role: 'pt' });
    expect(users[0].password_hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(verifyPassword(password, users[0].password_hash)).toBe(true);
    expect((await db().all("SELECT email FROM users WHERE email='other@example.com'"))).toEqual([]);
  });

  it('refuses short passwords', () => {
    expect(() => seedDevPtSql({ email: 'a@example.com', password: 'short' })).toThrow();
  });
});
