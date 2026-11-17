// RC-1 spike probes. Each probe isolates one §9.3 risk and returns JSON.
// No credential values are ever returned or logged.
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { databasePool, ensureSchema, withSnapshot } from '../lib/storage.mjs';

const err = e => ({ ok: false, name: e?.name, code: e?.code, message: String(e?.message || e).replace(/postgres(ql)?:\/\/[^\s]+/g, '[redacted-url]') });
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Module-scope marker used to show what survives between requests in one isolate.
let persistPath = null;

export async function sqliteProbe() {
  const detail = {};
  try {
    const mod = await import('node:sqlite');
    detail.exports = Object.keys(mod).sort();
    detail.DatabaseSyncType = typeof mod.DatabaseSync;
    const db = new mod.DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(x INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(42);
    return { ok: true, ...detail, value: db.prepare('SELECT x FROM t').get().x };
  } catch (e) { return { ...detail, ...err(e) }; }
}

export async function fsProbe() {
  const out = { tmpdir: tmpdir() };
  try {
    const folder = await mkdtemp(join(tmpdir(), 'fitspace-preview-'));
    const file = join(folder, 'working.sqlite');
    const bytes = Buffer.concat(Array.from({ length: 16 }, () => crypto.randomBytes(65536))); // 1 MiB (workerd caps getRandomValues at 64 KiB per call)
    await writeFile(file, bytes, { mode: 0o600 });
    const back = await readFile(file);
    out.folder = folder;
    out.roundTripEqual = Buffer.compare(bytes, back) === 0;
    out.size = (await stat(file)).size;
    out.listing = await readdir(folder);
    // Big write near the app's 8 MiB cap.
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    const t0 = Date.now();
    await writeFile(join(folder, 'big.bin'), big);
    out.big8MiBEqual = Buffer.compare(big, await readFile(join(folder, 'big.bin'))) === 0;
    out.big8MiBMs = Date.now() - t0;
    // Leave one file behind deliberately to test per-request lifetime.
    const keep = join(tmpdir(), 'rc1-persist-check.txt');
    out.previousRequestFileVisible = persistPath ? await readFile(persistPath, 'utf8').then(() => true, () => false) : 'first request in isolate';
    await writeFile(keep, 'left by previous request');
    persistPath = keep;
    await rm(folder, { recursive: true, force: true });
    out.removed = await stat(folder).then(() => false, () => true);
    out.ok = out.roundTripEqual && out.big8MiBEqual;
  } catch (e) { Object.assign(out, err(e)); }
  return out;
}

export async function nodeApisProbe() {
  const out = {};
  const run = async (name, fn) => { try { out[name] = { ok: true, value: await fn() }; } catch (e) { out[name] = err(e); } };
  await run('crypto.scryptSync', () => crypto.scryptSync('pw', 'salt', 64).toString('hex').slice(0, 16));
  await run('crypto.randomUUID', () => crypto.randomUUID().length);
  await run('crypto.timingSafeEqual', () => crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('a')));
  await run('crypto.createHash', () => crypto.createHash('sha256').update('x').digest('hex').slice(0, 16));
  await run('crypto.createHmac', () => crypto.createHmac('sha256', 'k').update('x').digest('hex').slice(0, 16));
  // Same seal/open pattern as app/pt-stripe.cjs (AAD + utf8 + auth tag).
  await run('crypto.cipheriv(aes-256-gcm, app pattern)', () => { const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), aad = Buffer.from('id:pt:stripe_test:secret'); const c = crypto.createCipheriv('aes-256-gcm', k, iv); c.setAAD(aad); const sealed = Buffer.concat([iv, c.update('rk_test_example', 'utf8'), c.final(), c.getAuthTag()]); const d = crypto.createDecipheriv('aes-256-gcm', k, sealed.subarray(0, 12)); d.setAAD(aad); d.setAuthTag(sealed.subarray(-16)); return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()]).toString('utf8'); });
  await run('stream.Readable.from', async () => { const chunks = []; for await (const c of Readable.from([Buffer.from('ab')])) chunks.push(c); return Buffer.concat(chunks).toString(); });
  await run('import.meta.url', () => String(import.meta.url));
  await run('module.createRequire(import.meta.url)', () => typeof createRequire(import.meta.url));
  await run('module.createRequire("/bundle/x.js")', () => typeof createRequire('/bundle/x.js'));
  await run('require("/bundle/app/server.cjs") (absolute VFS path)', () => typeof createRequire('/bundle/package.json')('/bundle/app/server.cjs'));
  await run('url.fileURLToPath', () => fileURLToPath('file:///bundle/app/'));
  await run('fs.readdir(/bundle)', () => readdir('/bundle'));
  await run('process.env populated', () => ({ DATABASE_URL: Boolean(process.env.DATABASE_URL), DATA_NAMESPACE: Boolean(process.env.DATA_NAMESPACE) }));
  await run('node:http import', async () => { const m = await import('node:http'); return typeof m.createServer; });
  return out;
}

// Workers forbid sharing an I/O object (socket) across requests. ?pool=shared keeps one
// module-level pool like platform.mjs does; the default creates one pool per request,
// scoped to that request only (module-level request state would leak between concurrent requests).
let sharedPool;
function poolFor(ctx) {
  if (ctx.shared) { sharedPool ||= databasePool(process.env.DATABASE_URL); return sharedPool; }
  ctx.pool ||= databasePool(process.env.DATABASE_URL);
  return ctx.pool;
}

export async function pgProbe(ctx) {
  const out = {};
  try {
    const p = poolFor(ctx);
    const { rows } = await p.query("SELECT current_setting('server_version') AS v, now() AS t");
    out.serverVersion = rows[0].v;
    await ensureSchema(p);
    out.schema = 'ok';
    out.ok = true;
  } catch (e) { Object.assign(out, err(e)); }
  return out;
}

// withSnapshot round trip WITHOUT SQLite: work() appends bytes to the temp file.
export async function snapshotProbe(ctx, namespace = 'rc1-spike-raw') {
  const out = {};
  try {
    const p = poolFor(ctx);
    await ensureSchema(p);
    const before = (await p.query('SELECT octet_length(snapshot) AS n FROM fitspace_preview_state WHERE namespace=$1', [namespace])).rows[0]?.n ?? null;
    const marker = crypto.randomUUID();
    const t0 = Date.now();
    const res = await withSnapshot(p, namespace, async filename => {
      let prev = Buffer.alloc(0);
      try { prev = await readFile(filename); } catch {}
      out.loadedFromPostgresBytes = prev.length;
      await writeFile(filename, Buffer.concat([prev, Buffer.from(marker + '\n')]));
      return new Response('ok');
    });
    out.withSnapshotMs = Date.now() - t0;
    out.status = res.status;
    const after = (await p.query('SELECT octet_length(snapshot) AS n, position($2::bytea in snapshot) > 0 AS has FROM fitspace_preview_state WHERE namespace=$1', [namespace, Buffer.from(marker)])).rows[0];
    out.bytesBefore = before; out.bytesAfter = after.n; out.markerPersisted = after.has;
    out.ok = after.has === true;
  } catch (e) { Object.assign(out, err(e)); }
  return out;
}

// withSnapshot round trip WITH SQLite (the real app pattern).
export async function sqliteSnapshotProbe(ctx, namespace = 'rc1-spike-sqlite') {
  const out = {};
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const p = poolFor(ctx);
    await ensureSchema(p);
    await withSnapshot(p, namespace, async filename => {
      const db = new DatabaseSync(filename);
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hits(id INTEGER PRIMARY KEY, at TEXT)');
      db.prepare('INSERT INTO hits(at) VALUES (?)').run(new Date().toISOString());
      out.rows = db.prepare('SELECT count(*) AS n FROM hits').get().n;
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
      return new Response('ok');
    });
    out.ok = true;
  } catch (e) { Object.assign(out, err(e)); }
  return out;
}

export async function handleProbe(request) {
  const { pathname } = new URL(request.url);
  const name = pathname.replace(/^\/__spike\/?/, '') || 'all';
  const ctx = { shared: new URL(request.url).searchParams.get('pool') === 'shared', pool: null };
  try { return await runProbe(name, ctx); }
  finally { if (ctx.pool) await ctx.pool.end().catch(() => {}); }
}

// The real app path: platform.mjs's runtime require of app/server.cjs, then createApp on a /tmp file.
export async function appProbe() {
  const out = {};
  try {
    // Same specifier platform.mjs produces under the wrangler.jsonc define (runtimeRoot "/").
    const require = createRequire('/package.json');
    const { createApp } = require('//app/server.cjs');
    out.requireServerCjs = typeof createApp;
    const folder = await mkdtemp(join(tmpdir(), 'fitspace-preview-'));
    const app = createApp({ dbPath: join(folder, 'working.sqlite'), demo: false, origin: 'http://127.0.0.1', paymentMode: 'demo', deferStripe: true, startEmailWorker: false });
    out.createApp = 'ok';
    app.db.close();
    out.ok = true;
  } catch (e) { Object.assign(out, err(e)); out.stackTop = String(e?.stack || '').split('\n').slice(0, 4).map(l => l.trim()); }
  return out;
}

async function runProbe(name, ctx) {
  const probes = { app: appProbe, sqlite: sqliteProbe, fs: fsProbe, node: nodeApisProbe, pg: () => pgProbe(ctx), snapshot: () => snapshotProbe(ctx), 'sqlite-snapshot': () => sqliteSnapshotProbe(ctx) };
  if (name === 'all') { const all = {}; for (const [k, f] of Object.entries(probes)) all[k] = await f(); return json(all); }
  if (!probes[name]) return json({ error: 'unknown probe', probes: Object.keys(probes) }, 404);
  return json(await probes[name]());
}
