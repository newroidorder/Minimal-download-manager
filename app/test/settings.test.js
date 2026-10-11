'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Settings } = require('../engine/settings');
const { captureDecision, credentialsFor, hostMatches } = require('../engine/rules');
const { expand } = require('../engine/batch');
const { tmpDir } = require('./helpers');

const BASE = path.resolve('/downloads');

test('categories sort files into IDM-style folders', () => {
  const s = new Settings(null, BASE);
  const folder = (name, mime) => s.categorize(name, mime).folder;
  assert.equal(folder('song.mp3'), path.join(BASE, 'Music'));
  assert.equal(folder('Setup.EXE'), path.join(BASE, 'Programs'));
  assert.equal(folder('movie.mkv'), path.join(BASE, 'Video'));
  assert.equal(folder('backup.tar.gz'), path.join(BASE, 'Compressed'));
  assert.equal(folder('report.pdf'), path.join(BASE, 'Documents'));
  assert.equal(folder('data.dat'), BASE, 'unknown types go to General');
  assert.equal(folder('stream', 'video/mp4'), path.join(BASE, 'Video'), 'MIME type is the fallback');
});

test('custom categories can be added, edited and removed; built-ins stay', () => {
  const s = new Settings(null, BASE);
  const cats = s.get().save.categories;
  s.update({ save: { categories: [...cats, { name: 'Ebooks', exts: 'epub mobi azw3', folder: path.join(BASE, 'Books') }] } });
  assert.equal(s.categorize('novel.azw3').name, 'Ebooks');
  assert.equal(s.categorize('novel.azw3').folder, path.join(BASE, 'Books'));
  assert.equal(s.get().save.categories.at(-1).id, 'general', 'General stays last');
  s.update({ save: { categories: [] } });
  const ids = s.get().save.categories.map(c => c.id);
  assert.deepEqual(ids, ['compressed', 'documents', 'music', 'programs', 'video', 'general']);
});

test('settings are validated, clamped and saved', () => {
  const home = tmpDir();
  const file = path.join(home, 'settings.json');
  const s = new Settings(file, BASE);
  const music = path.join(home, 'My Music');
  s.update({
    save: { categories: [{ id: 'music', folder: music, exts: '.MP3, *.flac  ogg, b@d!, mp3' }] },
    connection: { maxConnections: 99, maxActive: 0, exceptions: [{ host: 'Slow.Example.com', max: 50 }, { host: '' }] },
    proxy: { mode: 'bogus', port: 70000 },
    retry: { attempts: -3, delay: 0 },
    ui: { theme: 'dark', columns: { name: false, size: false } },
    language: 'pt-BR',
    queues: [{ id: 'nightly', name: 'Nightly', maxConcurrent: 2, schedule: { enabled: true, startTime: '25:00', days: [1, 9, 1, 3] } }]
  });
  const v = s.get();
  assert.deepEqual(v.save.categories.find(c => c.id === 'music').exts, ['mp3', 'flac', 'ogg']);
  assert.equal(v.connection.maxConnections, 32, "IDM's maximum is 32");
  assert.equal(v.connection.maxActive, 1);
  assert.deepEqual(v.connection.exceptions, [{ host: 'slow.example.com', max: 32 }]);
  assert.equal(v.proxy.mode, 'none');
  assert.equal(v.proxy.port, 65535);
  assert.deepEqual(v.retry, { attempts: 0, delay: 1 });
  assert.equal(v.ui.columns.name, true, 'the name column cannot be hidden');
  assert.equal(v.ui.columns.size, false);
  assert.equal(v.language, 'pt-BR');
  assert.deepEqual(v.queues.map(q => q.id), ['main', 'nightly'], 'the main queue always exists');
  const nightly = v.queues[1];
  assert.equal(nightly.schedule.startTime, '03:00', 'invalid time keeps the old value');
  assert.deepEqual(nightly.schedule.days, [1, 3]);

  assert.throws(() => s.update({ save: { categories: [{ id: 'video', folder: 'relative/path' }] } }), /full path/);
  assert.equal(new Settings(file, BASE).categorize('a.mp3').folder, music, 'saved to disk');
  assert.ok(fs.existsSync(file));
});

test('Windows paths are accepted as full paths', () => {
  const s = new Settings(null, BASE);
  s.update({ save: { categories: [{ id: 'video', folder: 'D:\\Filmes\\' }] } });
  assert.equal(s.categorize('a.mkv').folder, 'D:\\Filmes');
});

test('version 1 settings are migrated', () => {
  const home = tmpDir();
  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ askWhereToSave: false, showDialog: false, maxActive: 5, maxConnections: 16 }));
  const v = new Settings(file, BASE).get();
  assert.equal(v.downloads.showFileInfo, false);
  assert.equal(v.connection.maxActive, 5);
  assert.equal(v.connection.maxConnections, 16);
});

test('capture rules follow the File types tab', () => {
  const s = new Settings(null, BASE).get();
  const d = (o) => captureDecision(s, { kind: 'auto', browser: 'opera', ...o }).capture;
  assert.equal(d({ url: 'https://x.com/setup.exe' }), true);
  assert.equal(d({ url: 'https://x.com/page.html' }), false, 'HTML is not a download type');
  assert.equal(d({ url: 'https://x.com/dl?id=1', filename: 'report.zip' }), true, 'name from the browser counts');
  assert.equal(d({ url: 'https://x.com/dl?id=1', mime: 'application/pdf' }), true, 'MIME type counts');
  assert.equal(d({ url: 'https://x.com/dl?id=1', mime: 'application/octet-stream' }), true, 'generic binary counts');
  assert.equal(d({ url: 'https://dl.update.microsoft.com/a.exe' }), false, 'excluded site');
  assert.equal(captureDecision(s, { url: 'https://x.com/page.html', kind: 'menu' }).capture, true, 'explicit actions always count');
  const off = structuredClone(s);
  off.general.browsers.opera = false;
  assert.equal(captureDecision(off, { url: 'https://x.com/a.zip', kind: 'auto', browser: 'opera' }).capture, false);
  off.fileTypes.excludeUrls = ['https://x.com/private/*'];
  assert.equal(captureDecision(off, { url: 'https://x.com/private/a.zip', kind: 'auto' }).capture, false);
});

test('site logins match host, wildcard and path', () => {
  const sites = [
    { site: 'files.example.com', user: 'a', pass: '1' },
    { site: '*.example.org', user: 'b', pass: '2' },
    { site: 'example.net/private/', user: 'c', pass: '3' }
  ];
  const who = (url) => {
    const h = credentialsFor(sites, url);
    return h && Buffer.from(h.slice(6), 'base64').toString().split(':')[0];
  };
  assert.equal(who('https://files.example.com/x.zip'), 'a');
  assert.equal(who('https://other.example.com/x.zip'), null);
  assert.equal(who('https://cdn.example.org/x.zip'), 'b');
  assert.equal(who('https://example.org/x.zip'), 'b');
  assert.equal(who('https://example.net/private/x.zip'), 'c');
  assert.equal(who('https://example.net/public/x.zip'), null);
  assert.equal(hostMatches('*.example.org', 'evil-example.org'), false);
});

test('batch download patterns', () => {
  assert.deepEqual(expand('http://x/img*.jpg', 1, 3), ['http://x/img1.jpg', 'http://x/img2.jpg', 'http://x/img3.jpg']);
  assert.deepEqual(expand('http://x/*.png', 8, 10, 3), ['http://x/008.png', 'http://x/009.png', 'http://x/010.png']);
  assert.deepEqual(expand('http://x/part-*.zip', 'a', 'c'), ['http://x/part-a.zip', 'http://x/part-b.zip', 'http://x/part-c.zip']);
  assert.throws(() => expand('http://x/no-star', 1, 2), /\*/);
  assert.throws(() => expand('http://x/*', 0, 20000), /at most/);
});
