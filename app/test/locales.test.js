'use strict';

// Every text key used by the windows and the program exists in both languages.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const en = require('../locales/en.json');
const pt = require('../locales/pt-BR.json');

function sources() {
  const out = [];
  for (const dir of ['renderer', 'main']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (/\.(js|html)$/.test(f) && f !== 'icons.js') out.push(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'));
  }
  return out.join('\n');
}

test('all used keys are translated', () => {
  const src = sources();
  const keys = new Set();
  for (const m of src.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([\w.]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bt\('([\w.]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/data-title="([\w.]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\[\s*\d+,\s*'(font\.\w+)'\s*\]/g)) keys.add(m[1]);
  for (const m of src.matchAll(/'(dl\.st\.\w+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/key: '(col\.\w+)'/g)) keys.add(m[1]);
  // keys built at runtime
  for (const p of ['browser.chrome', 'browser.edge', 'browser.opera', 'browser.brave', 'browser.vivaldi', 'browser.firefox',
    'cat.compressed', 'cat.documents', 'cat.music', 'cat.programs', 'cat.video', 'cat.general',
    'opt.o.complete', 'opt.o.failed', 'opt.o.queueStart', 'opt.o.queueEnd',
    'theme.system', 'theme.light', 'theme.dark', 'toolbar.large', 'toolbar.small', 'toolbar.hidden',
    'status.pending', 'status.starting', 'status.scanning', 'status.paused', 'status.done', 'status.cancelled',
    'sort.addedAt', 'sort.name', 'sort.size', 'sort.status', 'sort.lastTry', 'sort.description', 'sort.category']) keys.add(p);
  assert.ok(keys.size > 300, `found ${keys.size} keys`);
  const missingEn = [...keys].filter(k => !(k in en));
  const missingPt = [...keys].filter(k => !(k in pt));
  assert.deepEqual(missingEn, [], 'missing in en.json');
  assert.deepEqual(missingPt, [], 'missing in pt-BR.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort(), 'both languages have the same keys');
});
