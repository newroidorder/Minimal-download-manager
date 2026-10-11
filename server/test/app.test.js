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

test('categories, "Download File Info" dialog flow, and OS actions', async (t) => {
  const origin = await startOrigin();
  const calls = [];
  const os = {
    pickFolder: async (initial) => { calls.push(['pick', initial]); return '/picked/folder'; },
    openFile: (p) => calls.push(['open', p]),
    showInFolder: (p) => calls.push(['folder', p])
  };
  const { app, port, saveDir, home } = await startApp({ os });
  t.after(async () => { await app.close(); await origin.close(); });
  const post = (p, body) => request(port, { method: 'POST', path: p, headers: auth, body });
  const get = (id) => request(port, { path: `/api/downloads/${id}`, headers: auth }).then(r => r.json);

  await t.test('automatic downloads go to the category folder', async () => {
    const r = await post('/api/downloads', { url: `${origin.base}/small.txt`, filename: 'song.mp3' });
    assert.equal(r.json.dialogUrl, null, 'API callers that are not interactive get no dialog');
    const done = await waitFor(async () => { const i = await get(r.json.id); return i.status === 'done' && i; });
    assert.equal(done.dest, path.join(saveDir, 'Music', 'song.mp3'));
    assert.equal(done.category, 'music');
  });

  await t.test('interactive capture waits in "pending" with file info for the dialog', async () => {
    const r = await post('/api/downloads', { url: `${origin.base}/attach?id=7`, interactive: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'pending');
    assert.equal(r.json.dialogUrl, `/dialog.html#${r.json.id}`);
    const info = await waitFor(async () => { const i = await get(r.json.id); return !i.inspecting && i; });
    assert.equal(info.filename, 'résumé.pdf');
    assert.equal(info.size, 5);
    assert.equal(info.category, 'documents');
    assert.equal(info.dir, path.join(saveDir, 'Documents'));
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await get(r.json.id)).status, 'pending', 'nothing downloads before the user answers');
  });

  await t.test('confirm with a chosen folder and name downloads there', async () => {
    const r = await post('/api/downloads', { url: `${origin.base}/ranged`, interactive: true });
    const chosen = path.join(home, 'Chosen Folder');
    assert.equal((await post(`/api/downloads/${r.json.id}/confirm`, { dir: 'relative/dir' })).status, 400);
    const c = await post(`/api/downloads/${r.json.id}/confirm`, { dir: chosen, filename: 'my-file.bin', start: true });
    assert.equal(c.status, 200);
    const done = await waitFor(async () => { const i = await get(r.json.id); return i.status === 'done' && i; });
    assert.equal(done.dest, path.join(chosen, 'my-file.bin'));
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
    assert.equal((await post(`/api/downloads/${r.json.id}/confirm`, { dir: chosen })).status, 409, 'only pending downloads can be confirmed');
  });

  await t.test('"Download Later" parks it as paused', async () => {
    const r = await post('/api/downloads', { url: `${origin.base}/small.txt`, interactive: true });
    await post(`/api/downloads/${r.json.id}/confirm`, { dir: saveDir, start: false });
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await get(r.json.id)).status, 'paused');
    await post(`/api/downloads/${r.json.id}/resume`);
    await waitFor(async () => (await get(r.json.id)).status === 'done');
  });

  await t.test('with "ask where to save" off, interactive captures start right away', async () => {
    const s = await request(port, { method: 'PUT', path: '/api/settings', headers: auth, body: { askWhereToSave: false } });
    assert.equal(s.json.askWhereToSave, false);
    const r = await post('/api/downloads', { url: `${origin.base}/small.txt`, filename: 'tool.exe', interactive: true });
    assert.notEqual(r.json.status, 'pending');
    assert.equal(r.json.dialogUrl, `/dialog.html#${r.json.id}`, 'the progress window still opens');
    const done = await waitFor(async () => { const i = await get(r.json.id); return i.status === 'done' && i; });
    assert.equal(done.dest, path.join(saveDir, 'Programs', 'tool.exe'));
    await request(port, { method: 'PUT', path: '/api/settings', headers: auth, body: { askWhereToSave: true } });
  });

  await t.test('settings API validates input', async () => {
    const bad = await request(port, { method: 'PUT', path: '/api/settings', headers: auth, body: { categories: [{ id: 'music', folder: 'not/absolute' }] } });
    assert.equal(bad.status, 400);
    assert.equal((await request(port, { path: '/api/settings' })).status, 401);
  });

  await t.test('folder picker and open actions go through the OS layer', async () => {
    const p = await post('/api/pick-folder', { initial: '/start/here' });
    assert.deepEqual(p.json, { path: '/picked/folder' });
    assert.deepEqual(calls.at(-1), ['pick', '/start/here']);

    const done = app.queue.list().find(i => i.status === 'done');
    await post(`/api/downloads/${done.id}/open`);
    await post(`/api/downloads/${done.id}/open-folder`);
    assert.deepEqual(calls.slice(-2), [['open', done.dest], ['folder', done.dest]]);

    const pending = (await post('/api/downloads', { url: `${origin.base}/small.txt`, interactive: true })).json;
    assert.equal((await post(`/api/downloads/${pending.id}/open`)).status, 409, 'only finished files can be opened');
  });

  await t.test('dialog page is served with CSP and the token', async () => {
    const r = await request(port, { path: '/dialog.html' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.match(r.body, /Download File Info/);
  });
});

test('queue limits concurrency and survives a restart', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());
  const first = await startApp({ settings: { maxActive: 2 } });
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
  const second = createApp({ token: TOKEN, home: first.home, saveDir: first.saveDir, settings: { maxActive: 2 } });
  await new Promise(r => second.server.listen(0, '127.0.0.1', r));
  t.after(() => second.close());
  const restored = second.queue.list();
  assert.equal(restored.length, 4);
  const paused = restored.filter(i => i.status === 'paused');
  assert.ok(paused.length >= 2, `expected the interrupted downloads to be paused, got ${restored.map(i => i.status)}`);
  for (const i of paused.filter(i => i.dest)) assert.ok(fs.existsSync(i.dest + '.part.json'));
});
