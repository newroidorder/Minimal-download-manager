'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Settings } = require('../engine/settings');
const { Manager } = require('../engine/manager');
const { Scheduler } = require('../engine/scheduler');
const { BODY, sha256, tmpDir, startOrigin, waitFor } = require('./helpers');

function make(opts = {}) {
  const home = opts.home || tmpDir();
  const base = path.join(home, 'Downloads');
  const settings = new Settings(path.join(home, 'settings.json'), base, opts.settings);
  const m = new Manager({
    settings,
    stateFile: path.join(home, 'list.json'),
    downloadOptions: { retryBaseMs: 10, progressIntervalMs: 20, stateIntervalMs: 50 },
    runProgram: opts.runProgram,
    now: opts.now
  });
  const events = [];
  m.on('event', e => events.push(e));
  const status = (id, s) => waitFor(() => { const i = m.get(id); return i && i.status === s && i; }, 15_000, `status ${s}`);
  return { m, settings, home, base, events, status };
}

test('manager', async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());
  const U = (p) => origin.base + p;

  await t.test('automatic downloads go to their category folder', async () => {
    const { m, base, status, events } = make();
    const { item } = m.add({ url: U('/small.txt'), filename: 'song.mp3' });
    const done = await status(item.id, 'done');
    assert.equal(done.dest, path.join(base, 'Music', 'song.mp3'));
    assert.equal(done.category, 'music');
    assert.ok(done.lastTryAt && done.finishedAt);
    assert.equal(events.find(e => e.type === 'complete')?.item.id, item.id, 'complete event for the sound / window');
  });

  await t.test('"Download File Info": pending until confirmed, folder remembered per category', async () => {
    const { m, settings, home, status } = make();
    const { item } = m.add({ url: U('/attach?id=7'), interactive: true });
    assert.equal(item.status, 'pending');
    const info = await waitFor(() => { const i = m.get(item.id); return !i.inspecting && i; });
    assert.equal(info.filename, 'résumé.pdf');
    assert.equal(info.size, 5);
    assert.equal(info.category, 'documents');
    assert.throws(() => m.confirm(item.id, { dir: 'relative' }), /full folder path/);
    const chosen = path.join(home, 'Papers');
    m.confirm(item.id, { dir: chosen, filename: 'cv.pdf', description: 'my CV' });
    const done = await status(item.id, 'done');
    assert.equal(done.dest, path.join(chosen, 'cv.pdf'));
    assert.equal(done.description, 'my CV');
    assert.equal(settings.categorize('x.pdf').folder, chosen, 'remember the last folder used for Documents');
  });

  await t.test('"Download Later" puts it in the main queue; starting the queue runs files in order', async () => {
    const { m, status, events } = make();
    const a = m.add({ url: U('/small.txt'), filename: 'a.txt', start: false }).item;
    const b = m.add({ url: U('/attach?id=7'), filename: 'b.pdf', start: false }).item;
    assert.equal(a.queueId, 'main');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(m.get(a.id).status, 'queued', 'waits while the queue is stopped');
    const order = [];
    m.on('update', u => { if (u.status === 'starting') order.push(u.id); });
    m.startQueue('main');
    await status(a.id, 'done');
    await status(b.id, 'done');
    assert.deepEqual(order, [a.id, b.id], 'one at a time, in queue order');
    await waitFor(() => events.some(e => e.type === 'queueEnd'));
    assert.deepEqual(events.filter(e => e.type.startsWith('queue')).map(e => e.type), ['queueStart', 'queueEnd']);
    assert.equal(m.runningQueues.size, 0, 'the queue stops when it is done');
  });

  await t.test('queue: N files at once, stop pauses them', async () => {
    const { m, settings, status } = make();
    settings.update({ queues: [...settings.get().queues, { id: 'night', name: 'Night', maxConcurrent: 2 }] });
    const ids = [1, 2, 3].map(n => m.add({ url: U('/slow'), filename: `n${n}.bin`, start: false, queueId: 'night', duplicate: 'number' }).item.id);
    m.startQueue('night');
    await waitFor(() => ids.filter(id => ['starting', 'downloading'].includes(m.get(id).status)).length === 2);
    assert.equal(m.get(ids[2]).status, 'queued');
    m.stopQueue('night');
    await status(ids[0], 'paused');
    await status(ids[1], 'paused');
    assert.equal(m.get(ids[2]).status, 'queued');
    await m.close();
  });

  await t.test('scheduler starts and stops queues at the set times', async () => {
    let clock = new Date(2026, 9, 12, 2, 59, 30); // a Monday
    const { m, settings } = make({ now: () => clock.getTime() });
    settings.update({ queues: [{ id: 'main', schedule: { enabled: true, startMode: 'daily', startTime: '03:00', days: [1], stopEnabled: true, stopTime: '05:30' } }] });
    m.add({ url: U('/slow'), filename: 's.bin', start: false });
    const sched = new Scheduler(settings, m, () => clock);
    sched.tick();
    assert.equal(m.runningQueues.has('main'), false);
    clock = new Date(2026, 9, 12, 3, 0, 5);
    sched.tick();
    assert.equal(m.runningQueues.has('main'), true, 'started at 03:00 on Monday');
    clock = new Date(2026, 9, 12, 5, 30, 1);
    sched.tick();
    assert.equal(m.runningQueues.has('main'), false, 'stopped at 05:30');
    clock = new Date(2026, 9, 13, 3, 0, 0); // Tuesday: not a scheduled day
    sched.tick();
    assert.equal(m.runningQueues.has('main'), false);
    await m.close();
  });

  await t.test('failed downloads retry after the configured delay; 404s do not', async () => {
    const { m, status } = make({ settings: { retry: { attempts: 3, delay: 1 } } });
    const { item } = m.add({ url: U('/fail-twice'), filename: 'retry.bin' });
    await status(item.id, 'done');
    assert.equal(origin.stats.failHits, 3, 'two failures, then success');
    const missing = m.add({ url: U('/missing'), filename: 'x.zip' }).item;
    await status(missing.id, 'error');
    await new Promise(r => setTimeout(r, 1300));
    assert.equal(m.get(missing.id).status, 'error');
    assert.equal(m.get(missing.id).retries, 0);
  });

  await t.test('duplicate links: ask, numbered copy, overwrite, resume', async () => {
    const { m, base, status } = make();
    const first = m.add({ url: U('/small.txt'), filename: 'dup.txt' }).item;
    await status(first.id, 'done');
    const ask = m.add({ url: U('/small.txt') });
    assert.equal(ask.duplicate?.id, first.id, 'default rule asks');
    const numbered = m.add({ url: U('/small.txt'), filename: 'dup.txt', duplicate: 'number' }).item;
    assert.equal(path.basename((await status(numbered.id, 'done')).dest), 'dup (1).txt');
    const resumed = m.add({ url: U('/small.txt'), duplicate: 'resume' });
    assert.equal(resumed.existing, true);
    fs.writeFileSync(path.join(base, 'dup.txt'), 'old content');
    const over = m.add({ url: U('/attach?id=7'), filename: 'over.pdf' }).item;
    await status(over.id, 'done');
    const replaced = m.add({ url: U('/attach?id=7'), duplicate: 'overwrite' }).item;
    const r = await status(replaced.id, 'done');
    assert.equal(path.basename(r.dest), 'over.pdf', 'same name, old file replaced');
    assert.equal(m.get(over.id), null, 'the old entry is replaced');
  });

  await t.test('site logins and the default user agent are sent', async () => {
    const plain = make({ settings: { sites: [{ site: '127.0.0.1', user: 'me', pass: 'secret' }] } });
    const refused = plain.m.add({ url: U('/needs-auth'), filename: 'refused.txt' }).item;
    await plain.status(refused.id, 'error');
    assert.equal(origin.stats.auth.at(-1), null, 'a login saved without http:// is never sent over plain HTTP');

    const { m, status } = make({ settings: { sites: [{ site: 'http://127.0.0.1', user: 'me', pass: 'secret' }] } });
    const { item } = m.add({ url: U('/needs-auth'), filename: 'private.txt' });
    const done = await status(item.id, 'done');
    assert.equal(fs.readFileSync(done.dest, 'utf8'), 'private');
    const ua = m.add({ url: U('/echo-ua.bin') }).item;
    await status(ua.id, 'done');
    assert.match(origin.stats.ua.at(-1), /Mozilla\/5\.0/);
  });

  await t.test('per-server connection limit', async () => {
    const { m, status } = make({ settings: { connection: { exceptions: [{ host: '127.0.0.1', max: 2 }] } } });
    origin.stats.maxOpen = 0;
    const { item } = m.add({ url: U('/ranged'), filename: 'two.bin' });
    const done = await status(item.id, 'done');
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
    assert.ok(origin.stats.maxOpen <= 2, `used ${origin.stats.maxOpen} connections`);
  });

  await t.test('download quota pauses everything and warns', async () => {
    const { m, events, status } = make({ settings: { connection: { quota: { enabled: true, mb: 2, hours: 1, warn: true } } } });
    const { item } = m.add({ url: U('/slow'), filename: 'quota.bin' });
    await waitFor(() => events.some(e => e.type === 'quota'), 15_000);
    assert.ok(events.some(e => e.type === 'quotaWarning'));
    await status(item.id, 'queued');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(m.get(item.id).status, 'queued', 'held until the quota period ends');
    m.settings.update({ connection: { quota: { enabled: false } } }); // or it would trip again
    m.unblockQuota();
    await status(item.id, 'done');
    assert.equal(sha256(fs.readFileSync(m.get(item.id).dest)), sha256(BODY), 'resumed, not restarted');
  });

  await t.test('file date from the server and antivirus check', async () => {
    const scanned = [];
    const { m, status } = make({
      settings: { save: { setFileDate: true }, downloads: { antivirus: { enabled: true, program: 'scanner.exe', args: '/scan "%f"' } } },
      runProgram: async (program, args, file) => { scanned.push([program, args, file]); return 0; }
    });
    const { item } = m.add({ url: U('/lastmod.bin') });
    const done = await status(item.id, 'done');
    assert.equal(fs.statSync(done.dest).mtime.toISOString(), '2020-01-01T10:00:00.000Z');
    assert.deepEqual(scanned, [['scanner.exe', '/scan "%f"', done.dest]]);
    assert.equal(done.scan, 'clean');
  });

  await t.test('stop all, redownload, remove completed, edit', async () => {
    const { m, status } = make();
    const a = m.add({ url: U('/slow'), filename: 'a.bin' }).item;
    const b = m.add({ url: U('/slow'), filename: 'b.bin', duplicate: 'number' }).item;
    await waitFor(() => m.get(a.id).received > 0 && m.get(b.id).received > 0);
    m.stopAll();
    await status(a.id, 'paused');
    await status(b.id, 'paused');
    assert.throws(() => m.edit(a.id, { url: 'ftp://x' }), /http/);
    m.edit(a.id, { url: U('/ranged'), description: 'moved' });
    m.resume(a.id);
    const done = await status(a.id, 'done');
    assert.equal(done.description, 'moved');
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
    await m.redownload(a.id);
    await status(a.id, 'done');
    assert.equal(m.removeCompleted(), 1);
    assert.equal(m.get(a.id), null);
    await m.remove(b.id);
    assert.equal(m.list().length, 0);
  });

  await t.test('the list survives a restart; interrupted downloads come back paused', async () => {
    const home = tmpDir();
    const first = make({ home });
    const { item } = first.m.add({ url: U('/slow'), filename: 'restart.bin' });
    await waitFor(() => first.m.get(item.id).received > 0);
    await first.m.close();
    const second = make({ home });
    const back = second.m.get(item.id);
    assert.equal(back.status, 'paused');
    assert.ok(fs.existsSync(back.dest + '.part.json'));
    second.m.resume(item.id);
    const done = await second.status(item.id, 'done');
    assert.equal(sha256(fs.readFileSync(done.dest)), sha256(BODY));
  });
});
