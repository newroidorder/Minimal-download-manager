'use strict';

// Proxy support, speed limiter and the Site Grabber against local servers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { download, fetchPage } = require('../engine/downloader');
const { createRouter, parseRule } = require('../engine/proxy');
const { Limiter } = require('../engine/limiter');
const { grab, extractLinks } = require('../engine/grabber');
const { BODY, sha256, tmpDir, startOrigin, startHttpProxy, startSocks5 } = require('./helpers');

const FAST = { retryBaseMs: 10, progressIntervalMs: 20, stateIntervalMs: 50 };
const settingsWith = (proxy) => () => ({ proxy: { mode: 'manual', pacUrl: '', user: '', pass: '', ...proxy } });

test('proxies', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  await t.test('HTTP proxy with login (plain HTTP is forwarded)', async () => {
    const proxy = await startHttpProxy({ user: 'p', pass: 'w' });
    t.after(() => proxy.close());
    const route = createRouter(settingsWith({ type: 'http', host: '127.0.0.1', port: proxy.port, user: 'p', pass: 'w' }));
    const r = await download({ url: `${origin.base}/ranged`, filename: 'via-http.bin' }, { saveDir: tmpDir(), route, ...FAST });
    assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
    assert.ok(proxy.stats.forward >= 2, 'every connection went through the proxy');
    assert.equal(proxy.stats.denied, 0);
  });

  await t.test('HTTP proxy rejects a wrong login', async () => {
    const proxy = await startHttpProxy({ user: 'p', pass: 'w' });
    t.after(() => proxy.close());
    const route = createRouter(settingsWith({ type: 'http', host: '127.0.0.1', port: proxy.port, user: 'p', pass: 'nope' }));
    await assert.rejects(download({ url: `${origin.base}/small.txt` }, { saveDir: tmpDir(), route, ...FAST }), /407/);
  });

  await t.test('SOCKS5 proxy with login (tunnel)', async () => {
    const socks = await startSocks5({ user: 'u', pass: 'p' });
    t.after(() => socks.close());
    const route = createRouter(settingsWith({ type: 'socks5', host: '127.0.0.1', port: socks.port, user: 'u', pass: 'p' }));
    const r = await download({ url: `${origin.base}/ranged`, filename: 'via-socks.bin' }, { saveDir: tmpDir(), route, ...FAST });
    assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
    assert.ok(socks.stats.connects >= 2);
  });

  await t.test('system / PAC mode uses the resolver answer', async () => {
    const proxy = await startHttpProxy();
    t.after(() => proxy.close());
    const asked = [];
    const route = createRouter(() => ({ proxy: { mode: 'system' } }), async (url) => { asked.push(url); return `PROXY 127.0.0.1:${proxy.port}; DIRECT`; });
    await download({ url: `${origin.base}/small.txt` }, { saveDir: tmpDir(), route, ...FAST });
    assert.ok(asked.length > 0);
    assert.ok(proxy.stats.forward > 0);
    assert.deepEqual(parseRule('SOCKS5 10.0.0.1:1080'), { type: 'socks5', host: '10.0.0.1', port: 1080 });
    assert.equal(parseRule('DIRECT'), null);
  });

  await t.test('no proxy: direct', async () => {
    const route = createRouter(() => ({ proxy: { mode: 'none' } }));
    assert.equal(await route('http://x/'), null);
  });
});

test('speed limiter slows the whole download', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());
  const limiter = new Limiter(8 * 1024 * 1024); // 8 MB/s for a 20 MB file: ~2.5 s
  const start = Date.now();
  const r = await download({ url: `${origin.base}/ranged`, filename: 'limited.bin' }, { saveDir: tmpDir(), limiter, ...FAST });
  const secs = (Date.now() - start) / 1000;
  assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
  assert.ok(secs >= 1.6, `took ${secs.toFixed(2)} s, expected about 2.5 s`);
  assert.ok(secs < 6, `took ${secs.toFixed(2)} s`);
});

test('site grabber finds files across linked pages', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());
  const fetch = (url) => fetchPage(url);
  const start = `${origin.base}/site/index.html`;

  const shallow = await grab(start, fetch, { depth: 0, exts: ['zip', 'mp3', 'pdf'] });
  assert.deepEqual(shallow.files.map(f => f.name).sort(), ['a.zip', 'b.mp3']);

  const deep = await grab(start, fetch, { depth: 1, exts: ['zip', 'mp3', 'pdf'] });
  assert.deepEqual(deep.files.map(f => f.name).sort(), ['a.zip', 'b.mp3', 'c.pdf'], 'no duplicates, external site not followed');

  const deeper = await grab(start, fetch, { depth: 2, exts: ['zip'] });
  assert.deepEqual(deeper.files.map(f => f.name).sort(), ['a.zip', 'd.zip']);

  assert.deepEqual(extractLinks('<a href="x.zip?a=1&amp;b=2">', 'http://h/dir/'), ['http://h/dir/x.zip?a=1&b=2']);
});
