'use strict';

// HTTP API + web UI. The security model:
// - binds to 127.0.0.1 only
// - every /api request needs the bearer token from config.json
// - Host must be 127.0.0.1:PORT or localhost:PORT (blocks DNS rebinding)
// - no CORS headers at all: the extension has host permissions and doesn't need
//   them, and web pages must not be able to read responses
// - requests with a foreign Origin are rejected before any work is done

const http = require('http');
const fs = require('fs');
const path = require('path');
const { timingSafeEqual } = require('crypto');
const { Queue } = require('./queue');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FORWARDED_HEADERS = new Set(['cookie', 'referer', 'user-agent', 'accept-language']);
const MAX_BODY = 64 * 1024;

function createApp({ token, saveDir, home, maxActive = 3, downloadOptions }) {
  const queue = new Queue({ saveDir, stateFile: path.join(home, 'queue.json'), maxActive, downloadOptions });
  const sseClients = new Set();
  const tokenBuf = Buffer.from(token);

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  queue.on('update', item => broadcast('update', item));
  queue.on('remove', ({ id }) => broadcast('remove', { id }));

  const keepAlive = setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25_000);
  keepAlive.unref();

  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__TOKEN__', token);

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string';
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...headers
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function authorized(req, url) {
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || '';
    const buf = Buffer.from(given);
    return buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf);
  }

  function originAllowed(req, port) {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser cross-origin request
    if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
    return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^moz-extension:\/\/[0-9a-f-]{36}$/.test(origin);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
        return reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
      }
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function cleanHeaders(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
      if (FORWARDED_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.length < 16384 && !/[\r\n\0]/.test(v)) {
        out[k] = v;
      }
    }
    return out;
  }

  async function handleApi(req, res, url) {
    const m = /^\/api\/downloads\/([\w-]+)(?:\/(pause|resume|cancel))?$/.exec(url.pathname);

    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, app: 'mini-idm' });
    if (req.method === 'GET' && url.pathname === '/api/queue') return send(res, 200, queue.list());

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(queue.list())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/downloads') {
      const body = await readJson(req);
      if (typeof body.url !== 'string') return send(res, 400, { error: 'url required' });
      try {
        const filename = typeof body.filename === 'string' ? body.filename : null;
        return send(res, 201, queue.add({ url: body.url, filename, headers: cleanHeaders(body.headers) }));
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    if (m && req.method === 'POST' && m[2]) {
      const item = m[2] === 'pause' ? queue.pause(m[1]) : m[2] === 'resume' ? queue.resume(m[1]) : await queue.cancel(m[1]);
      return item ? send(res, 200, item) : send(res, 404, { error: 'not found' });
    }

    if (m && req.method === 'DELETE' && !m[2]) {
      return (await queue.remove(m[1])) ? send(res, 204, '') : send(res, 404, { error: 'not found' });
    }

    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      return send(res, 421, 'unexpected Host header');
    }
    if (!originAllowed(req, port)) return send(res, 403, { error: 'origin not allowed' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return send(res, 401, { error: 'missing or invalid token' });
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, indexHtml, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
      }
      const file = STATIC[url.pathname];
      if (file) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, file[0]), 'utf8'), { 'Content-Type': file[1] });
      }
      return send(res, 404, 'not found');
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
  });

  async function close() {
    clearInterval(keepAlive);
    for (const res of sseClients) res.end();
    await new Promise(resolve => server.close(resolve));
    await queue.close();
  }

  return { server, queue, close };
}

module.exports = { createApp };
