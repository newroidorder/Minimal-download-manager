'use strict';

// Local HTTP server that reproduces the server behaviours a download manager
// has to survive: ranged and non-ranged files, dropped connections, lying
// Accept-Ranges, errors, redirects, Content-Disposition and slow streams.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BODY = crypto.randomBytes(20 * 1024 * 1024);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpDir(prefix = 'mdm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startOrigin() {
  const stats = { open: 0, maxOpen: 0, rangeStarts: [], flakyDrops: 0, cookies: [], failHits: 0, auth: [], ua: [], hits: {} };

  function serveRange(req, res, opts = {}) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const headers = { ETag: '"v1"', 'Accept-Ranges': 'bytes' };
    if (!m) {
      res.writeHead(200, { ...headers, 'Content-Length': BODY.length });
      return res.end(BODY);
    }
    const start = +m[1];
    const end = m[2] ? Math.min(+m[2], BODY.length - 1) : BODY.length - 1;
    stats.rangeStarts.push(start);
    stats.open++;
    stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    res.on('close', () => stats.open--);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${BODY.length}`, 'Content-Length': end - start + 1 });
    const slice = BODY.subarray(start, end + 1);

    if (opts.flaky && stats.flakyDrops < 3) {
      stats.flakyDrops++;
      res.write(slice.subarray(0, 100_000));
      return setTimeout(() => res.destroy(), 20);
    }
    // Throttled so connections overlap and pause/cancel can land mid-stream.
    const step = opts.slow ? 32 * 1024 : 256 * 1024;
    const delay = opts.slow ? 10 : 2;
    let off = 0;
    (function pump() {
      if (res.destroyed) return;
      if (off >= slice.length) return res.end();
      res.write(slice.subarray(off, off += step));
      setTimeout(pump, delay);
    })();
  }

  const server = http.createServer((req, res) => {
    const port = server.address().port;
    stats.hits[req.url] = (stats.hits[req.url] || 0) + 1;
    const html = (body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
    switch (req.url) {
      case '/fail-twice':
        if (++stats.failHits <= 2) { res.writeHead(503); return res.end('busy'); }
        res.writeHead(200, { 'Content-Length': 2 });
        return res.end('ok');
      case '/needs-auth':
        stats.auth.push(req.headers.authorization || null);
        if (req.headers.authorization !== 'Basic ' + Buffer.from('me:secret').toString('base64')) { res.writeHead(401); return res.end(); }
        res.writeHead(200, { 'Content-Length': 7 });
        return res.end('private');
      case '/echo-ua.bin':
        stats.ua.push(req.headers['user-agent']);
        res.writeHead(200, { 'Content-Length': 2 });
        return res.end('ua');
      case '/lastmod.bin':
        res.writeHead(200, { 'Content-Length': 4, 'Last-Modified': 'Wed, 01 Jan 2020 10:00:00 GMT' });
        return res.end('date');
      case '/site/index.html':
        return html(`<a href="a.zip">a</a> <a href='b.mp3'>b</a> <img src="/site/pic.png"> <a href="sub/page.html">more</a>
          <a href="https://elsewhere.example/x.html">ext</a> <a href="mailto:x@y">m</a> <a href="a.zip#again">dup</a>`);
      case '/site/sub/page.html':
        return html('<a href="../a.zip">same</a><a href="c.pdf">c</a><a href="deeper.html">deeper</a>');
      case '/site/sub/deeper.html':
        return html('<a href="d.zip">d</a>');
      case '/ranged': return serveRange(req, res);
      case '/slow': return serveRange(req, res, { slow: true });
      case '/flaky': return serveRange(req, res, { flaky: true });
      case '/ignores-range':
        res.writeHead(200, { 'Content-Length': BODY.length, 'Accept-Ranges': 'bytes' });
        return res.end(BODY);
      case '/missing':
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<h1>Not found</h1>');
      case '/redirect-cross':
        res.writeHead(302, { Location: `http://127.0.0.2:${port}/echo-cookie` });
        return res.end();
      case '/redirect-same':
        res.writeHead(302, { Location: '/echo-cookie' });
        return res.end();
      case '/echo-cookie':
        stats.cookies.push(req.headers.cookie || null);
        res.writeHead(200);
        return res.end(`cookie: ${req.headers.cookie || 'none'}`);
      case '/attach?id=7':
        res.writeHead(200, { 'Content-Disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'Content-Length': 5 });
        return res.end('%PDF-');
      case '/small.txt':
        res.writeHead(200, { 'Content-Length': 5 });
        return res.end('hello');
      // Pages and files for the browser end-to-end test.
      // Opens like a normal visit and clicks a link by itself (no automation attached).
      case (req.url.startsWith('/auto-click?') ? req.url : null): {
        const href = new URL(req.url, 'http://x').searchParams.get('href') || '/';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><a id="go" href="${href.replace(/[<>"&]/g, '')}">go</a><script>setTimeout(() => document.getElementById('go').click(), 1500)</script>`);
      }
      case '/page.html':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=httponly-secret; HttpOnly; Path=/' });
        return res.end(`<!doctype html><title>e2e</title>
          <a id="zip" href="/files/archive.zip">archive</a>
          <a id="dl" href="/dl?id=1">report</a>
          <a id="noname" href="/get/82ec09e7-20a2-4e0f">project</a>
          <video id="v" src="/files/video.mp4" muted preload="auto"></video>`);
      // Like GitHub release assets and S3: an ID in the address, the real name
      // only in Content-Disposition, and a generic type.
      case '/get/82ec09e7-20a2-4e0f':
        res.setHeader('Content-Disposition', 'attachment; filename="project.zip"');
        res.setHeader('Content-Type', 'binary/octet-stream');
        return serveRange(req, res);
      case '/files/archive.zip':
      case '/files/video.mp4':
      case '/dl?id=1': {
        stats.cookies.push(req.headers.cookie || null);
        if (req.url === '/dl?id=1') res.setHeader('Content-Disposition', 'attachment; filename="report.bin"');
        res.setHeader('Content-Type', req.url.endsWith('.mp4') ? 'video/mp4' : 'application/zip');
        return serveRange(req, res);
      }
      default:
        res.writeHead(404);
        return res.end();
    }
  });

  return new Promise(resolve => {
    // All interfaces, so 127.0.0.2 works as a second "origin" for redirect tests.
    server.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base, stats, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

// HTTP proxy: absolute-URI requests (plain HTTP) and CONNECT tunnels.
function startHttpProxy({ user, pass } = {}) {
  const stats = { forward: 0, connect: 0, denied: 0 };
  const expected = user ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
  const server = http.createServer((req, res) => {
    if (expected && req.headers['proxy-authorization'] !== expected) { stats.denied++; res.writeHead(407); return res.end(); }
    stats.forward++;
    const u = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    if (expected && req.headers['proxy-authorization'] !== expected) { stats.denied++; sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    stats.connect++;
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, stats, close: () => new Promise(c => { server.closeAllConnections?.(); server.close(c); }) })));
}

// Minimal SOCKS5 server (no auth or username/password), CONNECT only.
function startSocks5({ user, pass } = {}) {
  const stats = { connects: 0 };
  const sockets = new Set();
  const server = net.createServer((c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    c.on('error', () => {});
    let stage = 'hello';
    let buf = Buffer.alloc(0);
    c.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (stage === 'hello' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        const m = user ? 2 : 0;
        if (!methods.includes(m)) return c.end(Buffer.from([5, 0xff]));
        c.write(Buffer.from([5, m]));
        stage = user ? 'auth' : 'request';
      }
      if (stage === 'auth' && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        const ok = buf.subarray(2, 2 + ul).toString() === user && buf.subarray(3 + ul, 3 + ul + pl).toString() === pass;
        buf = buf.subarray(3 + ul + pl);
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return c.end();
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 5 && buf[3] === 3 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString();
        const port = buf.readUInt16BE(5 + buf[4]);
        const rest = buf.subarray(7 + buf[4]);
        stage = 'tunnel';
        c.off('data', onData);
        stats.connects++;
        const up = net.connect(port, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) up.write(rest);
          up.pipe(c);
          c.pipe(up);
        });
        up.on('error', () => c.destroy());
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port, stats,
    close: () => new Promise(cb => { for (const s of sockets) s.destroy(); server.close(cb); })
  })));
}

async function waitFor(fn, timeoutMs = 10_000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

module.exports = { BODY, sha256, tmpDir, startOrigin, startHttpProxy, startSocks5, waitFor };
