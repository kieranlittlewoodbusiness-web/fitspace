import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { wwwToApexRedirect } from '../worker/index.mjs';

describe('www to apex redirect', () => {
  it('301s www to the apex and leaves other hosts alone', async () => {
    const www = await worker.fetch(new Request('https://www.resiliencecoaching.app/health?x=1', { headers: { Host: 'www.resiliencecoaching.app' } }), env);
    expect(www.status).toBe(301);
    expect(www.headers.get('Location')).toBe('https://resiliencecoaching.app/health?x=1');

    const path = await worker.fetch(new Request('https://www.resiliencecoaching.app/pricing', { headers: { Host: 'www.resiliencecoaching.app' } }), env);
    expect(path.status).toBe(301);
    expect(path.headers.get('Location')).toBe('https://resiliencecoaching.app/pricing');

    const apex = await worker.fetch(new Request('https://resiliencecoaching.app/health', { headers: { Host: 'resiliencecoaching.app' } }), env);
    expect(apex.status).toBe(200);
    expect(await apex.json()).toEqual({ ok: true });

    expect(wwwToApexRedirect(new Request('https://resiliencecoaching-preview.littlk.workers.dev/health', { headers: { Host: 'resiliencecoaching-preview.littlk.workers.dev' } }))).toBeNull();
    expect(wwwToApexRedirect(new Request('http://example.test/health'))).toBeNull();
  });

  it('pins the apex when Host is www but the request URL hostname is not, and does not redirect other Hosts', async () => {
    // Host is www; the request URL hostname does not match. Location must still be the apex, with path and query kept.
    const mismatch = await worker.fetch(new Request('https://evil.example/booking/abc?ref=1', { headers: { Host: 'www.resiliencecoaching.app' } }), env);
    expect(mismatch.status).toBe(301);
    expect(mismatch.headers.get('Location')).toBe('https://resiliencecoaching.app/booking/abc?ref=1');
    expect(wwwToApexRedirect(new Request('http://other.example:8080/path?q=2', { headers: { Host: 'WWW.resiliencecoaching.app:443' } })).headers.get('Location')).toBe('https://resiliencecoaching.app/path?q=2');

    expect(wwwToApexRedirect(new Request('https://resiliencecoaching.app/health?x=1', { headers: { Host: 'resiliencecoaching.app' } }))).toBeNull();
    expect(wwwToApexRedirect(new Request('https://resiliencecoaching-preview.littlk.workers.dev/health', { headers: { Host: 'resiliencecoaching-preview.littlk.workers.dev' } }))).toBeNull();
    expect(wwwToApexRedirect(new Request('https://example.test/health', { headers: { Host: 'example.test' } }))).toBeNull();
  });
});
