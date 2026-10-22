import { Readable } from 'node:stream';

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

export async function boundedBody(request, max = 65536) {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        const error = new Error('Request too large.');
        error.status = 413;
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

export async function runApp(handler, request, body, ip = 'unknown') {
  const url = new URL(request.url);
  const req = Readable.from(body.length ? [body] : []);
  req.url = url.pathname + url.search;
  req.method = request.method;
  req.headers = Object.fromEntries(request.headers);
  req.socket = { remoteAddress: ip };
  const headers = new Headers();
  let status = 200;
  let ended = false;
  let data = Buffer.alloc(0);
  const res = {
    headersSent: false,
    setHeader(name, value) { headers.set(name, String(value)); },
    getHeader(name) { return headers.get(name); },
    writeHead(code, values = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers.set(name, String(value));
      this.headersSent = true;
    },
    end(value = '') {
      ended = true;
      data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    }
  };
  await handler(req, res);
  if (!ended) throw new Error('Application did not finish its response.');
  return new Response(request.method === 'HEAD' ? null : data, { status, headers });
}

export function failure(message, status = 503, json = false) {
  return new Response(json ? JSON.stringify({ error: message }) : message, {
    status, headers: { ...securityHeaders, 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8' }
  });
}
