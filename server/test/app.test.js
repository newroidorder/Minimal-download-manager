'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../lib/app');
const { BODY, sha256, tmpDir, startOrigin } = require('./helpers');

const TOKEN = 'test-token-0123456789abcdef';

// Raw request so tests control Host and Origin exactly (fetch would not allow that).
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function startApp(opts = {}) {
  const home = tmpDir();
  const saveDir = path.join(home, 'downloads');
  const app = createApp({ token: TOKEN, home, saveDir, downloadOptions: { retryBaseMs: 10 }, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { app, home, saveDir, port: app.server.address().port };
}

async function waitFor(fn, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

test('server', async (t) => {
  const origin = await startOrigin();
  const { app, port, saveDir } = await startApp();
  t.after(async () => { await app.close(); await origin.close(); });

  await t.test('API requires the token', async () => {
    assert.equal((await request(port, { path: '/api/queue' })).status, 401);
    assert.equal((await request(port, { path: '/api/queue', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request(port, { path: '/api/queue', headers: auth })).status, 200);
  });

  await t.test('foreign Origin is rejected, even with a valid token', async () => {
    const r = await request(port, { method: 'POST', path: '/api/downloads', headers: { ...auth, Origin: 'https://evil.example' }, body: { url: `${origin.base}/small.txt` } });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  await t.test('preflight from a web page gets no CORS grant', async () => {
    const r = await request(port, { method: 'OPTIONS', path: '/api/downloads', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.notEqual(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  await t.test('extension origin is accepted', async () => {
    const r = await request(port, { path: '/api/health', headers: { ...auth, Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
    assert.equal(r.status, 200);
  });

  await t.test('DNS rebinding: wrong Host header is rejected', async () => {
    const r = await request(port, { path: '/', headers: { Host: `evil.example:${port}` } });
    assert.equal(r.status, 421);
  });

  await t.test('text/plain "simple" POST cannot slip past the JSON check', async () => {
    const r = await request(port, { method: 'POST', path: '/api/downloads', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' }, body: '{"url":"http://x"}' });
    assert.equal(r.status, 415);
  });

  await t.test('only http(s) URLs are accepted', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'not a url']) {
      const r = await request(port, { method: 'POST', path: '/api/downloads', headers: auth, body: { url } });
      assert.equal(r.status, 400, url);
    }
  });

  await t.test('UI is served with a strict CSP', async () => {
    const r = await request(port, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.match(r.body, new RegExp(`content="${TOKEN}"`));
  });

  await t.test('download via API completes; only whitelisted headers are forwarded', async () => {
    const r = await request(port, {
      method: 'POST', path: '/api/downloads', headers: auth,
      body: { url: `${origin.base}/ranged`, filename: 'api.bin', headers: { Cookie: 'a=1', 'X-Evil': 'nope', Host: 'evil' } }
    });
    assert.equal(r.status, 201);
    const id = r.json.id;
    const done = await waitFor(async () => {
      const q = (await request(port, { path: '/api/queue', headers: auth })).json;
      const item = q.find(i => i.id === id);
      return item.status === 'done' && item;
    });
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
    assert.equal(path.dirname(done.dest), saveDir);
    assert.equal(JSON.stringify(done).includes('a=1'), false, 'cookies never appear in queue data');
  });

  await t.test('pause, resume and remove through the API', async () => {
    const add = await request(port, { method: 'POST', path: '/api/downloads', headers: auth, body: { url: `${origin.base}/slow`, filename: 'pr.bin' } });
    const id = add.json.id;
    const item = () => request(port, { path: '/api/queue', headers: auth }).then(r => r.json.find(i => i.id === id));
    await waitFor(async () => (await item()).received > 0);
    await request(port, { method: 'POST', path: `/api/downloads/${id}/pause`, headers: auth });
    const paused = await waitFor(async () => { const i = await item(); return i.status === 'paused' && i; });
    assert.ok(fs.existsSync(paused.dest + '.part'));
    await request(port, { method: 'POST', path: `/api/downloads/${id}/resume`, headers: auth });
    const done = await waitFor(async () => { const i = await item(); return i.status === 'done' && i; });
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
    assert.equal((await request(port, { method: 'DELETE', path: `/api/downloads/${id}`, headers: auth })).status, 204);
    assert.equal(await item(), undefined);
  });

  await t.test('SSE stream sends a snapshot and updates', async () => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/api/events?token=${TOKEN}`, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => events.push(...[...c.matchAll(/^event: (\w+)$/gm)].map(m => m[1])));
    });
    await waitFor(() => events.includes('snapshot'));
    await request(port, { method: 'POST', path: '/api/downloads', headers: auth, body: { url: `${origin.base}/small.txt` } });
    await waitFor(() => events.includes('update'));
    req.destroy();
  });
});

test('queue limits concurrency and survives a restart', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());
  const first = await startApp({ maxActive: 2 });
  const { port } = first;

  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await request(port, { method: 'POST', path: '/api/downloads', headers: auth, body: { url: `${origin.base}/slow`, filename: `q${i}.bin` } });
    ids.push(r.json.id);
  }
  const statuses = async () => (await request(port, { path: '/api/queue', headers: auth })).json.map(i => i.status);
  await waitFor(async () => (await statuses()).filter(s => s === 'downloading').length === 2);
  assert.ok((await statuses()).filter(s => s === 'starting' || s === 'downloading').length <= 2);

  // Restart: running downloads come back paused, with their progress kept on disk.
  await first.app.close();
  const second = createApp({ token: TOKEN, home: first.home, saveDir: first.saveDir, maxActive: 2 });
  await new Promise(r => second.server.listen(0, '127.0.0.1', r));
  t.after(() => second.close());
  const restored = second.queue.list();
  assert.equal(restored.length, 4);
  const paused = restored.filter(i => i.status === 'paused');
  assert.ok(paused.length >= 2, `expected the interrupted downloads to be paused, got ${restored.map(i => i.status)}`);
  for (const i of paused.filter(i => i.dest)) assert.ok(fs.existsSync(i.dest + '.part.json'));
});
