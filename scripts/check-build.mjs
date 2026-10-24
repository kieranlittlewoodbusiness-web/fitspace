import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 for build and Functions runtime.');
const require = createRequire(import.meta.url);
require('node:sqlite');
require('pg');
const files = ['netlify/functions/platform.mjs', 'app/server.cjs', 'app/db.cjs',
  'app/pt-stripe.cjs', 'app/password-reset.cjs', 'app/stripe-mode.cjs', 'app/auth.cjs', 'app/payments.cjs', 'app/emails.cjs', 'app/public/app.js',
  'lib/bridge.mjs', 'lib/storage.mjs'];
for (const file of files) {
  await access(file);
  const result = spawnSync(process.execPath, ['--check', resolve(file)], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr);
}
await access('app/public/index.html');
await access('app/public/styles.css');
const config = await readFile('netlify.toml', 'utf8');
if (!config.includes('publish = "site"') || !config.includes('force = true')) throw new Error('Function routing configuration is missing.');
console.log('Netlify source checks passed. No database or private credentials are needed at build time.');
