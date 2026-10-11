'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { download } = require('../lib/downloader');
const { BODY, sha256, tmpDir, startOrigin } = require('./helpers');

const FAST = { retryBaseMs: 10, progressIntervalMs: 20, stateIntervalMs: 50 };
const leftovers = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.part') || f.endsWith('.part.json'));

test('downloader', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  await t.test('ranged file: parallel segments, hash matches, no leftovers', async () => {
    const dir = tmpDir();
    origin.stats.maxOpen = 0;
    const r = await download({ url: `${origin.base}/ranged`, filename: 'big.bin' }, { saveDir: dir, ...FAST });
    assert.equal(r.status, 'done');
    assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
    assert.ok(origin.stats.maxOpen >= 4, `expected >= 4 parallel connections, saw ${origin.stats.maxOpen}`);
    assert.deepEqual(leftovers(dir), []);
  });

  await t.test('dropped connections are retried from the last written byte', async () => {
    const dir = tmpDir();
    const r = await download({ url: `${origin.base}/flaky`, filename: 'flaky.bin' }, { saveDir: dir, ...FAST });
    assert.equal(origin.stats.flakyDrops, 3);
    assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
  });

  await t.test('server that advertises but ignores Range: single stream, correct size', async () => {
    const dir = tmpDir();
    const r = await download({ url: `${origin.base}/ignores-range`, filename: 'big.bin' }, { saveDir: dir, ...FAST });
    assert.equal(fs.statSync(r.dest).size, BODY.length);
    assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
  });

  await t.test('HTTP 404 is an error and leaves nothing on disk', async () => {
    const dir = tmpDir();
    await assert.rejects(download({ url: `${origin.base}/missing`, filename: 'file.zip' }, { saveDir: dir, ...FAST }), /HTTP 404/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  await t.test('cookies are dropped on cross-origin redirects, kept on same-origin', async () => {
    const dir = tmpDir();
    const headers = { Cookie: 'session=SECRET' };
    const cross = await download({ url: `${origin.base}/redirect-cross`, headers }, { saveDir: dir, ...FAST });
    assert.equal(fs.readFileSync(cross.dest, 'utf8'), 'cookie: none');
    const same = await download({ url: `${origin.base}/redirect-same`, headers }, { saveDir: dir, ...FAST });
    assert.equal(fs.readFileSync(same.dest, 'utf8'), 'cookie: session=SECRET');
  });

  await t.test('Content-Disposition filename* is honored', async () => {
    const dir = tmpDir();
    const r = await download({ url: `${origin.base}/attach?id=7` }, { saveDir: dir, ...FAST });
    assert.equal(path.basename(r.dest), 'résumé.pdf');
  });

  await t.test('same name: concurrent and later downloads never overwrite', async () => {
    const dir = tmpDir();
    const job = { url: `${origin.base}/small.txt`, filename: 'same.txt' };
    const results = await Promise.all([1, 2, 3].map(() => download(job, { saveDir: dir, ...FAST })));
    const names = results.map(r => path.basename(r.dest)).sort();
    assert.deepEqual(names, ['same (1).txt', 'same (2).txt', 'same.txt']);
  });

  await t.test('cancel removes the .part file', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    setTimeout(() => ac.abort('cancelled'), 100);
    const r = await download({ url: `${origin.base}/slow`, filename: 'c.bin' }, { saveDir: dir, signal: ac.signal, ...FAST });
    assert.equal(r.status, 'cancelled');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  await t.test('pause keeps progress; resume continues without re-downloading', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    let pausedAt = 0;
    const job = { url: `${origin.base}/slow`, filename: 'p.bin' };
    setTimeout(() => ac.abort('paused'), 250);
    const paused = await download(job, { saveDir: dir, signal: ac.signal, ...FAST, onProgress: p => { pausedAt = p.received; } });
    assert.equal(paused.status, 'paused');
    assert.ok(pausedAt > 0 && pausedAt < BODY.length, `paused mid-way (${pausedAt} bytes)`);
    assert.ok(fs.existsSync(paused.dest + '.part') && fs.existsSync(paused.dest + '.part.json'));

    origin.stats.rangeStarts = [];
    let firstReport = null;
    const done = await download({ ...job, dest: paused.dest }, {
      saveDir: dir, ...FAST, onProgress: p => { firstReport ??= p.received; }
    });
    assert.equal(done.status, 'done');
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
    assert.ok(!origin.stats.rangeStarts.includes(0), 'resume must not restart from byte 0');
    assert.ok(firstReport > 0, 'resume reports the bytes it already had');
    assert.deepEqual(leftovers(dir), []);
  });

  await t.test('error on a ranged download keeps the .part so a retry resumes', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    const job = { url: `${origin.base}/slow`, filename: 'e.bin' };
    // Simulate a fatal mid-download error by aborting with a non-pause reason.
    setTimeout(() => ac.abort(new Error('network down')), 200);
    const err = await download(job, { saveDir: dir, signal: ac.signal, ...FAST }).catch(e => e);
    assert.ok(err instanceof Error);
    assert.ok(err.dest && fs.existsSync(err.dest + '.part.json'));
    const r = await download({ ...job, dest: err.dest }, { saveDir: dir, ...FAST });
    assert.equal(sha256(fs.readFileSync(r.dest)), sha256(BODY));
  });
});
