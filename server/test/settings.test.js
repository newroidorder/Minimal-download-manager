'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Settings } = require('../lib/settings');
const { tmpDir } = require('./helpers');

test('categories sort files into IDM-style folders', () => {
  const base = path.resolve('/downloads');
  const s = new Settings(null, base);
  const folder = (name, mime) => s.categorize(name, mime).folder;
  assert.equal(folder('song.mp3'), path.join(base, 'Music'));
  assert.equal(folder('Setup.EXE'), path.join(base, 'Programs'));
  assert.equal(folder('movie.mkv'), path.join(base, 'Video'));
  assert.equal(folder('backup.tar.gz'), path.join(base, 'Compressed'));
  assert.equal(folder('report.pdf'), path.join(base, 'Documents'));
  assert.equal(folder('data.dat'), base, 'unknown types go to General (the base folder)');
  assert.equal(folder('stream', 'video/mp4'), path.join(base, 'Video'), 'MIME type is the fallback');
});

test('settings are validated and saved', () => {
  const home = tmpDir();
  const file = path.join(home, 'settings.json');
  const base = path.resolve(home, 'dl');
  const s = new Settings(file, base);

  const music = path.resolve(home, 'My Music');
  s.update({ categories: [{ id: 'music', folder: music, exts: '.MP3, *.flac  ogg, b@d!, mp3' }], maxConnections: 99, maxActive: 0 });
  const v = s.get();
  assert.equal(v.categories.find(c => c.id === 'music').folder, music);
  assert.deepEqual(v.categories.find(c => c.id === 'music').exts, ['mp3', 'flac', 'ogg']);
  assert.equal(v.maxConnections, 32, 'clamped to IDM\'s maximum of 32');
  assert.equal(v.maxActive, 1);

  assert.throws(() => s.update({ categories: [{ id: 'video', folder: 'relative/path' }] }), /full path/);

  const reloaded = new Settings(file, base);
  assert.equal(reloaded.categorize('a.mp3').folder, music);
  assert.ok(fs.existsSync(file));
});
