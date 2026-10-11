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

  await t.test('the Mini IDM extension needs no setup; everyone else is refused', async () => {
    assert.deepEqual((await request(port, { path: '/api/ping', headers: { Origin: EXT } })).json, { app: 'mini-idm', version: '2.0.0' });
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
    assert.equal(item.status, 'pending', '"Download File Info" will open');
    assert.deepEqual(captured.at(-1).req.headers, { Cookie: 'a=1' }, 'only whitelisted headers');

    const page = await capture({ url: `${origin.base}/site/index.html`, kind: 'auto', browser: 'opera' });
    assert.equal(page.json.accepted, false, 'HTML pages stay in the browser');
    settings.update({ general: { browsers: { opera: false } } });
    const off = await capture({ url: `${origin.base}/x.exe`, kind: 'auto', browser: 'opera' });
    assert.equal(off.json.accepted, false, 'browser switched off in Options');
    const menu = await capture({ url: `${origin.base}/site/index.html`, kind: 'menu', browser: 'opera' });
    assert.equal(menu.json.accepted, true, 'right-click "Download with Mini IDM" always works');
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
