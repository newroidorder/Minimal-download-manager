'use strict';

// Local HTTP server that reproduces the server behaviours a download manager
// has to survive: ranged and non-ranged files, dropped connections, lying
// Accept-Ranges, errors, redirects, Content-Disposition and slow streams.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BODY = crypto.randomBytes(20 * 1024 * 1024);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpDir(prefix = 'mini-idm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startOrigin() {
  const stats = { open: 0, maxOpen: 0, rangeStarts: [], flakyDrops: 0, cookies: [] };

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
    switch (req.url) {
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
      case '/page.html':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=httponly-secret; HttpOnly; Path=/' });
        return res.end(`<!doctype html><title>e2e</title>
          <a id="zip" href="/files/archive.zip">archive</a>
          <a id="dl" href="/dl?id=1">report</a>
          <video id="v" src="/files/video.mp4" muted preload="auto"></video>`);
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

module.exports = { BODY, sha256, tmpDir, startOrigin };
