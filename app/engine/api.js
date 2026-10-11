'use strict';

// Browser bridge: the small local HTTP API the Mini IDM extension talks to.
// It plays the role of IDM's IDMMsgHost.exe. The program itself (windows,
// list, settings) talks to the manager directly, not through here.
//
// Security model:
// - binds to 127.0.0.1 only
// - accepts requests from the Mini IDM extension, identified by its fixed ID
//   (browsers set the Origin header; web pages cannot fake it), or with the
//   bearer token from <home>/config.json (for scripts and tests)
// - Host must be 127.0.0.1:PORT or localhost:PORT (blocks DNS rebinding)
// - no CORS headers: web pages can never read a response
// - POST bodies must be JSON (no "simple" cross-site form posts)

const http = require('http');
const { timingSafeEqual } = require('crypto');
const { captureDecision } = require('./rules');

const FORWARDED_HEADERS = new Set(['cookie', 'referer', 'user-agent', 'accept-language']);
const KINDS = new Set(['auto', 'click', 'menu', 'detected', 'manual']);
const MAX_BODY = 64 * 1024;

/**
 * onCapture(result, request): called after a captured download was added
 * (result.item) or found to be a duplicate that needs an answer
 * (result.duplicate). The app opens its windows from there.
 */
function createBridge({ manager, settings, token, extensionIds = [], version = '0.0.0', onCapture = () => {} }) {
  const tokenBuf = Buffer.from(token || '');
  const allowedOrigins = new Set(extensionIds.map(id => `chrome-extension://${id}`));

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  function hasToken(req) {
    const auth = req.headers.authorization || '';
    if (!tokenBuf.length || !auth.startsWith('Bearer ')) return false;
    const buf = Buffer.from(auth.slice(7));
    return buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
        return reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
      }
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
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
      if (FORWARDED_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.length < 16384 && !/[\r\n\0]/.test(v)) out[k] = v;
    }
    return out;
  }

  async function capture(req, res) {
    const b = await readJson(req);
    if (typeof b.url !== 'string') return send(res, 400, { error: 'url required' });
    const kind = KINDS.has(b.kind) ? b.kind : 'manual';
    const s = settings.get();
    const decision = captureDecision(s, { url: b.url, filename: b.filename, mime: b.mime, browser: b.browser, kind });
    if (!decision.capture) return send(res, 200, { accepted: false, reason: decision.reason });

    const request = {
      url: b.url,
      filename: typeof b.filename === 'string' && b.filename ? b.filename : null,
      headers: cleanHeaders(b.headers),
      referrer: typeof b.referrer === 'string' ? b.referrer : '',
      kind,
      interactive: true
    };
    let result;
    try {
      result = manager.add(request);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    onCapture(result, request);
    return send(res, 200, { accepted: true, id: result.item?.id || result.duplicate?.id });
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      return send(res, 421, { error: 'unexpected Host header' });
    }
    const origin = req.headers.origin;
    const fromExtension = !!origin && allowedOrigins.has(origin);
    if (origin && !fromExtension) return send(res, 403, { error: 'origin not allowed' });
    if (!fromExtension && !hasToken(req)) return send(res, 401, { error: 'not allowed' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { app: 'mini-idm', version });
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const s = settings.get();
        return send(res, 200, {
          contextMenu: s.general.contextMenu,
          bypassKey: s.general.bypassKey,
          captureExts: s.fileTypes.capture,
          browsers: s.general.browsers
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/capture') return await capture(req, res);
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
  });

  return {
    server,
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

module.exports = { createBridge };
