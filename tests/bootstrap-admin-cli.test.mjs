import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseBootstrapArgs, wranglerD1ExecuteArgs, HELP } from '../scripts/bootstrap-admin.mjs';

const SECRET_EMAIL = 'kieran-secret@example.com';
const SECRET_PASSWORD = 'Super-secret-admin-99';

test('parseBootstrapArgs: --env production needs confirmations; --remote without it is refused', () => {
  assert.deepEqual(parseBootstrapArgs([]), { help: true });
  assert.deepEqual(parseBootstrapArgs(['--help']), { help: true });
  assert.deepEqual(parseBootstrapArgs(['--local']), { help: false, remote: false, envName: undefined, persistTo: undefined });
  assert.deepEqual(parseBootstrapArgs(['--local', '--persist-to', '/tmp/state']), { help: false, remote: false, envName: undefined, persistTo: '/tmp/state' });
  const prod = parseBootstrapArgs(['--remote', '--confirm-remote', '--env', 'production', '--confirm-production']);
  assert.deepEqual(prod, { help: false, remote: true, envName: 'production', persistTo: undefined });
  assert.deepEqual(parseBootstrapArgs(['--local', '--env=production', '--confirm-production']), { help: false, remote: false, envName: 'production', persistTo: undefined });
  assert.throws(() => parseBootstrapArgs(['--remote']), /--confirm-remote/);
  assert.throws(() => parseBootstrapArgs(['--remote', '--confirm-remote']), /only with --env production/);
  assert.throws(() => parseBootstrapArgs(['--remote', '--confirm-remote', '--env', 'preview']), /only with --env production/);
  assert.throws(() => parseBootstrapArgs(['--local', '--env', 'production']), /--confirm-production/);
  assert.throws(() => parseBootstrapArgs(['--env', 'staging']), /only with --env production/);
});

test('wranglerD1ExecuteArgs passes --env production and never includes emails or secrets', () => {
  const args = wranglerD1ExecuteArgs({ remote: true, envName: 'production', file: '/tmp/bootstrap.sql' });
  assert.deepEqual(args, ['wrangler', 'd1', 'execute', 'DB', '--remote', '--env', 'production', '--file', '/tmp/bootstrap.sql']);
  const local = wranglerD1ExecuteArgs({ remote: false, envName: 'production', persistTo: '/tmp/state', json: true, command: "SELECT count(*) AS admins FROM users WHERE role='admin'" });
  assert.deepEqual(local, ['wrangler', 'd1', 'execute', 'DB', '--local', '--env', 'production', '--persist-to', '/tmp/state', '--json', '--command', "SELECT count(*) AS admins FROM users WHERE role='admin'"]);
  for (const list of [args, local, HELP.split(/\s+/)]) {
    assert.ok(!list.includes(SECRET_EMAIL) && !String(list).includes(SECRET_PASSWORD));
  }
});

test('bootstrap-admin CLI refuses a remote prod run without --env production and does not print secrets', () => {
  const run = args => spawnSync(process.execPath, ['scripts/bootstrap-admin.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ADMIN_EMAIL: SECRET_EMAIL, ADMIN_PASSWORD: SECRET_PASSWORD, ADMIN_NAME: 'Secret Name' }
  });
  const remote = run(['--remote', '--confirm-remote']);
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /only with --env production|Admin bootstrap failed/);
  const output = (remote.stdout || '') + (remote.stderr || '');
  assert.doesNotMatch(output, /kieran-secret@example.com|Super-secret-admin-99|Secret Name/);
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--env production/);
  assert.doesNotMatch((help.stdout || '') + (help.stderr || ''), /kieran-secret@example.com|Super-secret-admin-99/);
});
