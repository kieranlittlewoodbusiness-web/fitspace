// RC-4 x RC-20: the Worker port must carry the same customer-facing copy as legacy app/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// Static string literals that are user-visible copy in the auth emails.
const copy = (src) => (src.match(/'(?:[^'\\]|\\.)*'/g) || [])
  .map((s) => s.slice(1, -1))
  .filter((s) => /password|sign-in|reset was requested|choose a new|expires 30 minutes|did not make this change/i.test(s) && /\s/.test(s));

test('auth email subjects and bodies match legacy app/password-reset.cjs', () => {
  const legacy = copy(read('app/password-reset.cjs').slice(read('app/password-reset.cjs').indexOf("subject='Reset")));
  const worker = copy(read('src/mail.mjs'));
  for (const s of legacy.filter((s) => /Resilience Coaching|coach|link expires|choose a new/.test(s))) {
    assert.ok(worker.includes(s), 'missing in src/mail.mjs: ' + s);
  }
});

test('no FITSPACE or "trainer page" copy left in Worker user-facing strings', () => {
  for (const f of ['src/mail.mjs', 'src/public.mjs', 'worker/index.mjs']) {
    const strings = (read(f).match(/'(?:[^'\\]|\\.)*'/g) || []).filter((s) => /\s/.test(s));
    assert.deepEqual(strings.filter((s) => /FITSPACE|trainer page/i.test(s)), [], f);
  }
  assert.ok(read('src/public.mjs').includes("'This page is not available.'"));
});
