'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { Settings } = require('../engine/settings');
const { Manager } = require('../engine/manager');
const { createBridge } = require('../engine/api');
const { EXTENSION_ID } = require('../engine/config');
const { tmpDir, startOrigin, waitFor } = require('./helpers');

const TOKEN = 'script-token-0123456789';
const EXT = `chrome-extension://${EXTENSION_ID}`;

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('browser bridge', async (t) => {
  const origin = await startOrigin();
  const home = tmpDir();
  const settings = new Settings(path.join(home, 'settings.json'), path.join(home, 'Downloads'));
  const manager = new Manager({ settings, stateFile: path.join(home, 'list.json') });
  const captured = [];
  const bridge = createBridge({ manager, settings, token: TOKEN, extensionIds: [EXTENSION_ID], version: '2.0.0', onCapture: (r, req) => captured.push({ r, req }) });
  const port = await bridge.listen(0);
  t.after(async () => { await bridge.close(); await manager.close(); await origin.close(); });

  const ext = { Origin: EXT, 'Content-Type': 'application/json' };
  const capture = (body, headers = ext) => request(port, { method: 'POST', path: '/api/capture', headers, body });

  await t.test('the Minimal Download Manager extension needs no setup; everyone else is refused', async () => {
    assert.deepEqual((await request(port, { path: '/api/ping', headers: { Origin: EXT } })).json, { app: 'minimal-download-manager', version: '2.0.0' });
    assert.equal((await request(port, { path: '/api/ping' })).status, 401, 'no origin, no token');
    assert.equal((await request(port, { path: '/api/ping', headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } })).status, 403, 'another extension');
    assert.equal((await request(port, { path: '/api/ping', headers: { Origin: 'https://evil.example' } })).status, 403, 'a web page');
    assert.equal((await request(port, { path: '/api/ping', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200, 'scripts with the token');
    const r = await request(port, { path: '/api/ping', headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 403, 'a web page with a stolen token is still refused');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  await t.test('DNS rebinding and non-JSON posts are refused', async () => {
    assert.equal((await request(port, { path: '/api/ping', headers: { Origin: EXT, Host: `evil.example:${port}` } })).status, 421);
    assert.equal((await capture('{"url":"http://x/a.zip"}', { Origin: EXT, 'Content-Type': 'text/plain' })).status, 415);
  });

  await t.test('extension config comes from the app', async () => {
    const r = await request(port, { path: '/api/config', headers: { Origin: EXT } });
    assert.equal(r.json.contextMenu, true);
    assert.equal(r.json.bypassKey, 'alt');
    assert.ok(r.json.captureExts.includes('exe'));
  });

  await t.test('captures follow the File types rules', async () => {
    const yes = await capture({ url: `${origin.base}/files/archive.zip`, kind: 'click', browser: 'opera', headers: { Cookie: 'a=1', 'X-Evil': 'no' } });
    assert.deepEqual(Object.keys(yes.json).sort(), ['accepted', 'id']);
    assert.equal(yes.json.accepted, true);
    const item = manager.get(yes.json.id);
    assert.equal(item.status, 'pending', 'the "New download" window will open');
    assert.deepEqual(captured.at(-1).req.headers, { Cookie: 'a=1' }, 'only whitelisted headers');

    const page = await capture({ url: `${origin.base}/site/index.html`, kind: 'auto', browser: 'opera' });
    assert.equal(page.json.accepted, false, 'HTML pages stay in the browser');
    settings.update({ general: { browsers: { opera: false } } });
    const off = await capture({ url: `${origin.base}/x.exe`, kind: 'auto', browser: 'opera' });
    assert.equal(off.json.accepted, false, 'browser switched off in Options');
    const menu = await capture({ url: `${origin.base}/site/index.html`, kind: 'menu', browser: 'opera' });
    assert.equal(menu.json.accepted, true, 'right-click "Download with Minimal Download Manager" always works');
    settings.update({ general: { browsers: { opera: true } } });
  });

  await t.test('a duplicate link is handed to the app to ask', async () => {
    const before = captured.length;
    const again = await capture({ url: `${origin.base}/files/archive.zip`, kind: 'click' });
    assert.equal(again.json.accepted, true);
    assert.ok(captured[before].r.duplicate, 'the app gets the duplicate to ask about');
    await waitFor(() => !manager.get(captured[0].r.item.id).inspecting);
  });
});

// ---------- native messaging: browser ⇄ native/host.js ⇄ pipe ⇄ program ----------

const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const P = require('../native/protocol');

// Plays the browser: starts the host the way Chrome does and speaks its framing.
function startHost(home, env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'native', 'host.js'), `${EXT}/`], {
    env: { ...process.env, MDM_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'inherit']
  });
  const inbox = [];
  P.readNative(child.stdout, m => inbox.push(m));
  let seq = 0;
  return {
    inbox,
    send: (m) => child.stdin.write(P.encodeNative(m)),
    request: async (type, body) => {
      const id = ++seq;
      child.stdin.write(P.encodeNative({ id, type, body }));
      return waitFor(() => inbox.find(m => m.id === id), 10_000, `reply to ${type}`);
    },
    last: (type) => inbox.filter(m => m.type === type).at(-1),
    stop: () => new Promise(r => { child.once('exit', r); child.stdin.end(); })
  };
}

test('native messaging bridge', async (t) => {
  const origin = await startOrigin();
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ token: TOKEN }));
  const settings = new Settings(path.join(home, 'settings.json'), path.join(home, 'Downloads'));
  const manager = new Manager({ settings, stateFile: path.join(home, 'list.json') });
  const captured = [];
  const connections = [];
  const bridge = createBridge({
    manager, settings, token: TOKEN, version: '2.2.0',
    onCapture: (r, req) => captured.push({ r, req }), onConnections: m => connections.push(m)
  });
  const pipe = P.pipePath(home);
  t.after(async () => { await bridge.close(); await manager.close(); await origin.close(); });

  await t.test('the host tells the extension when the program is not running', async () => {
    const host = startHost(home);
    await waitFor(() => host.last('status'), 10_000, 'status');
    assert.equal(host.last('status').running, false);
    const r = await host.request('capture', { url: `${origin.base}/files/a.zip`, kind: 'click' });
    assert.equal(r.error, 'not-running', 'so the browser keeps the download');
    await host.stop();
  });

  await bridge.listenPipe(pipe);

  await t.test('it connects, shows the browser as connected and captures', async () => {
    const host = startHost(home);
    host.send({ type: 'hello', browser: 'opera' });
    await waitFor(() => host.last('status')?.running, 10_000, 'connected');
    assert.equal(host.last('status').version, '2.2.0');
    assert.ok(host.last('config').config.captureExts.includes('zip'), 'the program sends its settings on connect');
    await waitFor(() => bridge.live().opera === 1, 5000, 'live connection');

    const r = await host.request('capture', { url: `${origin.base}/files/native.zip`, kind: 'click', headers: { Cookie: 'sid=1', 'X-Evil': '1' } });
    assert.equal(r.result.accepted, true);
    assert.deepEqual(captured.at(-1).req.headers, { Cookie: 'sid=1' });
    assert.equal((await host.request('ping')).result.app, 'minimal-download-manager');

    // Settings changes reach the extension right away.
    settings.update({ general: { sendCookies: false } });
    await waitFor(() => host.last('config')?.config?.sendCookies === false, 5000, 'config push');
    await host.request('capture', { url: `${origin.base}/files/nocookie.zip`, kind: 'menu', headers: { Cookie: 'sid=1' } });
    assert.deepEqual(captured.at(-1).req.headers, {}, 'cookies not passed on when switched off');
    settings.update({ general: { sendCookies: true } });

    await host.stop();
    await waitFor(() => !bridge.live().opera, 5000, 'disconnect seen');
    await waitFor(() => manager.list().every(i => !i.inspecting), 10_000);
  });

  await t.test('other programs on the PC cannot use the pipe', async () => {
    const before = manager.list().length;
    const sock = net.connect(pipe);
    const lines = [];
    P.readLines(sock, m => lines.push(m));
    const closed = new Promise(r => sock.on('close', r));
    sock.on('error', () => {});
    sock.write(JSON.stringify({ type: 'hello', nonce: 'abc' }) + '\n');
    await waitFor(() => lines.length, 5000, 'challenge');
    sock.write(JSON.stringify({ type: 'auth', proof: 'guess' }) + '\n');
    sock.write(JSON.stringify({ id: 1, type: 'capture', body: { url: `${origin.base}/files/evil.zip`, kind: 'menu' } }) + '\n');
    await closed;
    assert.equal(lines.some(m => m.id === 1), false);
    assert.equal(manager.list().length, before, 'nothing was added');

    const silent = net.connect(pipe);
    silent.on('error', () => {});
    silent.write(JSON.stringify({ id: 2, type: 'capture', body: { url: `${origin.base}/files/evil2.zip`, kind: 'menu' } }) + '\n');
    await new Promise(r => silent.on('close', r));
    assert.equal(manager.list().length, before, 'no requests before the handshake');
  });

  await t.test('the host does not talk to a program that does not know the token', async () => {
    const fake = tmpDir();
    fs.writeFileSync(path.join(fake, 'config.json'), JSON.stringify({ token: 'another-token-9876543210' }));
    const host = startHost(fake, { MDM_PIPE: pipe }); // the right pipe, the wrong secret
    host.send({ type: 'hello', browser: 'chrome' });
    await waitFor(() => host.last('status'), 10_000, 'status');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(host.last('status').running, false);
    assert.equal(bridge.live().chrome, undefined);
    await host.stop();
  });

  await t.test('HTTP stays closed unless switched on', async () => {
    assert.equal(bridge.server.listening, false);
  });
});
