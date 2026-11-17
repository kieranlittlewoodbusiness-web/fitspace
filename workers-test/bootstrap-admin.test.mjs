import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { bootstrapAdminSql } from '../scripts/bootstrap-admin.mjs';
import { db } from './helpers.mjs';
import { verifyPassword } from '../src/util.mjs';

describe('admin bootstrap script (outside the request path)', () => {
  it('creates one admin only if none exists, stores only a hash, escapes quotes', async () => {
    const d = db();
    await d.run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='admin')");
    await d.run("UPDATE users SET role='customer' WHERE role='admin'"); // this file's isolated storage only
    const password = 'Local only ' + crypto.randomUUID();
    const sql = bootstrapAdminSql({ email: 'owner@example.com', name: "O'Brien Admin", password });
    expect(sql).not.toContain(password);
    await env.DB.exec(sql.trim());
    await env.DB.exec(bootstrapAdminSql({ email: 'second@example.com', password }).trim());
    const admins = await d.all("SELECT name,email,password_hash FROM users WHERE role='admin'");
    console.log('bootstrap twice -> admins:', admins.length, admins.map(a => a.email).join(','));
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ name: "O'Brien Admin", email: 'owner@example.com' });
    expect(admins[0].password_hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(verifyPassword(password, admins[0].password_hash)).toBe(true);
  });
  it('refuses the old demo password and short passwords', () => {
    expect(() => bootstrapAdminSql({ email: 'a@example.com', password: 'TrainTogether123!' })).toThrow(/demo password/);
    expect(() => bootstrapAdminSql({ email: 'a@example.com', password: 'short' })).toThrow();
  });
});
