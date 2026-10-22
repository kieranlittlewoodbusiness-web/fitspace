import http from 'node:http';
import handler from '../netlify/functions/platform.mjs';
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method, headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: bytes } : {})
    });
    const response = await handler(request, { ip: req.socket.remoteAddress });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500); res.end('Could not serve preview.');
  }
}).listen(port, '127.0.0.1', () => console.log(`Private preview at http://localhost:${port}`));
