'use strict';

// Browser bridge: how the Minimal Download Manager extension reaches the
// program. The program itself (windows, list, settings) talks to the manager
// directly, not through here.
//
// 1. Native messaging (the normal way). The browser
//    starts native/host.js for our extension only, and the host talks to the
//    program over a private pipe. Both sides of the pipe prove they know the
//    token in <home>/config.json (see native/protocol.js), so other programs on
//    the PC can't add downloads or read anything through it.
// 2. HTTP on 127.0.0.1 (off by default, Options > General). Kept for
//    browsers where the native host can't be registered. Weaker: any program
//    running on this PC can send an Origin header, so it can add downloads.
//    Requests need the extension's Origin or the bearer token, the Host header
//    must be 127.0.0.1/localhost (no DNS rebinding), there are no CORS headers
//    (web pages never see a response) and only JSON is accepted.

const fs = require('fs');
const http = require('http');
const net = require('net');
const { timingSafeEqual } = require('crypto');
const { captureDecision } = require('./rules');
const P = require('../native/protocol');

const FORWARDED_HEADERS = new Set(['cookie', 'referer', 'user-agent', 'accept-language']);
const KINDS = new Set(['auto', 'click', 'menu', 'detected', 'manual']);
const MAX_BODY = 64 * 1024;
const BROWSER_RE = /^[a-z]{2,12}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * onCapture(result, request): called after a captured download was added
 * (result.item) or found to be a duplicate that needs an answer
 * (result.duplicate). The app opens its windows from there.
 * onSeen(browser): a browser talked to us. onConnections(map): the browsers
 * connected through native messaging right now, { chrome: 1, ... }.
 */
function createBridge({ manager, settings, token, extensionIds = [], version = '0.0.0', onCapture = () => {}, onSeen = () => {}, onConnections = () => {} }) {
  const tokenBuf = Buffer.from(token || '');
  const allowedOrigins = new Set(extensionIds.map(id => `chrome-extension://${id}`));

  // ---------- what the extension can ask, whichever way it connects ----------

  function cleanHeaders(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
      if (FORWARDED_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.length < 16384 && !/[\r\n\0]/.test(v)) out[k] = v;
    }
    return out;
  }

  function config() {
    const s = settings.get();
    return {
      contextMenu: s.general.contextMenu,
      bypassKey: s.general.bypassKey,
      captureExts: s.fileTypes.capture,
      browsers: s.general.browsers,
      sendCookies: s.general.sendCookies
    };
  }

  function capture(b) {
    if (!b || typeof b.url !== 'string') throw fail(400, 'url required');
    const kind = KINDS.has(b.kind) ? b.kind : 'manual';
    const s = settings.get();
    const decision = captureDecision(s, { url: b.url, filename: b.filename, mime: b.mime, browser: b.browser, kind });
    if (!decision.capture) return { accepted: false, reason: decision.reason };

    if (typeof b.browser === 'string' && BROWSER_RE.test(b.browser)) onSeen(b.browser);
    const headers = cleanHeaders(b.headers);
    if (!s.general.sendCookies) for (const k of Object.keys(headers)) if (k.toLowerCase() === 'cookie') delete headers[k];
    const request = {
      url: b.url,
      filename: typeof b.filename === 'string' && b.filename ? b.filename : null,
      headers,
      referrer: typeof b.referrer === 'string' ? b.referrer : '',
      kind,
      interactive: true
    };
    let result;
    try {
      result = manager.add(request);
    } catch (e) {
      throw fail(400, e.message);
    }
    onCapture(result, request);
    return { accepted: true, id: result.item?.id || result.duplicate?.id };
  }

  function ping(browser) {
    if (typeof browser === 'string' && BROWSER_RE.test(browser)) onSeen(browser);
    return { app: 'minimal-download-manager', version };
  }

  // ---------- 1. private pipe for the native messaging host ----------

  const conns = new Set();

  function live() {
    const out = {};
    for (const c of conns) if (c.authed && c.browser) out[c.browser] = (out[c.browser] || 0) + 1;
    return out;
  }

  function onPipeConnection(sock) {
    const c = { sock, authed: false, browser: '', nonce: P.nonce() };
    conns.add(c);
    const timer = setTimeout(() => { if (!c.authed) sock.destroy(); }, 5000);
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(timer);
      conns.delete(c);
      if (c.authed && c.browser) onConnections(live());
    });
    const setBrowser = (b) => {
      if (typeof b !== 'string' || !BROWSER_RE.test(b) || b === c.browser) return;
      c.browser = b;
      onSeen(b);
      onConnections(live());
    };
    P.readLines(sock, (msg) => {
      if (!c.authed) {
        if (msg.type === 'hello' && typeof msg.nonce === 'string' && !c.challenged) {
          c.challenged = true;
          P.writeLine(sock, { type: 'hello', nonce: c.nonce, proof: P.proof(token, 'app', msg.nonce) });
        } else if (msg.type === 'auth' && c.challenged && P.verify(token, 'host', c.nonce, msg.proof)) {
          c.authed = true;
          clearTimeout(timer);
          P.writeLine(sock, { type: 'ready', version, config: config() });
          setBrowser(msg.browser);
        } else {
          sock.destroy();
        }
        return;
      }
      if (msg.type === 'browser') return setBrowser(msg.browser);
      const id = msg.id;
      if (typeof id !== 'number' && typeof id !== 'string') return;
      try {
        let result;
        if (msg.type === 'ping') result = ping(c.browser);
        else if (msg.type === 'config') result = config();
        else if (msg.type === 'capture') result = capture({ ...msg.body, browser: c.browser || msg.body?.browser });
        else throw fail(404, 'unknown request');
        P.writeLine(sock, { id, result });
      } catch (e) {
        P.writeLine(sock, { id, error: e.message });
      }
    });
  }

  const pipeServer = net.createServer(onPipeConnection);
  let pipePath = null;
  const unsubscribe = settings.onChange?.(() => {
    const msg = { type: 'config', config: config() };
    for (const c of conns) if (c.authed) P.writeLine(c.sock, msg);
  });

  // ---------- 2. HTTP on 127.0.0.1 (opt-in) ----------

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
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(fail(415, 'Content-Type must be application/json'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(fail(413, 'body too large')); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { reject(fail(400, 'invalid JSON')); }
      });
      req.on('error', reject);
    });
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
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, ping(fromExtension ? url.searchParams.get('browser') : null));
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, config());
      if (req.method === 'POST' && url.pathname === '/api/capture') return send(res, 200, capture(await readJson(req)));
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
  });

  return {
    server,
    live,
    // HTTP
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    }),
    stopHttp: () => new Promise(resolve => {
      if (!server.listening) return resolve();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    // Pipe
    listenPipe: (p) => new Promise((resolve, reject) => {
      pipePath = p;
      // A socket file left over from a crash (only one copy of the program runs).
      if (process.platform !== 'win32') { try { fs.unlinkSync(p); } catch { /* none */ } }
      pipeServer.once('error', reject);
      pipeServer.listen(p, () => {
        pipeServer.off('error', reject);
        if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o600); } catch { /* best effort */ } }
        resolve(p);
      });
    }),
    close: async () => {
      unsubscribe?.();
      for (const c of conns) c.sock.destroy();
      await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
      await new Promise(resolve => pipeServer.close(() => resolve()));
      if (pipePath && process.platform !== 'win32') { try { fs.unlinkSync(pipePath); } catch { /* gone */ } }
    }
  };
}

module.exports = { createBridge };
