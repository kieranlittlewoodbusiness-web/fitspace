import { spawnSync } from 'node:child_process';
for (const [args, env] of [
  [['scripts/verify-bundle.mjs'], process.env],
  [['--test', 'tests/postgres.test.mjs', 'tests/stripe-netlify.test.mjs', 'tests/password-reset.test.mjs', 'tests/pt-direct.test.mjs'], { ...process.env, FITSPACE_TEST_BUNDLED: 'true' }]
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status || 1);
}
