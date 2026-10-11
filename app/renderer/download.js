// One window per download, like IDM: "Download File Info" (name, folder,
// category), then progress, then "Download complete".

import { idm, t, boot, el, fmtBytes, fmtSpeed, fmtTime, catName, queueName, fileBadge, showError, fitWindow } from './common.js';

const ID = idm.params.id;
const $ = (id) => document.getElementById(id);
let settings = null;
let item = null;
let view = null;
let edited = { folder: false, category: false, filename: false };
let rate = [];

function show(name) {
  if (view === name) return;
  view = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== name;
  fitWindow();
}

const cats = () => settings.save.categories;

function categoryFor(filename) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(filename || '');
  const ext = m ? m[1].toLowerCase() : '';
  return cats().find(c => c.id !== 'general' && ext && c.exts.includes(ext)) || cats().find(c => c.id === 'general');
}

// ---------- Download File Info ----------

function fillSelects() {
  $('category').replaceChildren(...cats().map(c => el('option', { value: c.id, text: catName(c) })));
  $('laterQueue').replaceChildren(...settings.queues.map(q => el('option', { value: q.id, text: queueName(q) })));
}

function setCategory(id) {
  const cat = cats().find(c => c.id === id) || cats().at(-1);
  $('category').value = cat.id;
  $('rememberLabel').textContent = t('dl.remember', { cat: catName(cat) });
  $('remember').checked = cat.rememberLast;
  if (!edited.folder) $('folder').value = cat.folder;
}

function renderAsk() {
  show('ask');
  document.title = t('dl.infoTitle');
  $('askUrl').value = item.url;
  if (!edited.filename && document.activeElement !== $('filename')) $('filename').value = item.filename;
  if (!edited.category) setCategory(item.category || categoryFor(item.filename).id);
  if (!edited.folder && item.dir) $('folder').value = item.dir;
  if (document.activeElement !== $('description') && !$('description').value) $('description').value = item.description || '';
  $('askInfo').textContent = item.inspecting ? t('dl.inspecting')
    : [t('dl.sizeIs', { size: item.size ? fmtBytes(item.size, 2) : t('dl.unknown') }), item.mime].filter(Boolean).join(' · ');
  if (item.inspectError) showError($('askError'), t('dl.inspectError', { error: item.inspectError }));
}

async function confirm(start) {
  $('askError').hidden = true;
  const category = $('category').value;
  const cat = cats().find(c => c.id === category);
  try {
    if (cat && $('remember').checked !== cat.rememberLast) {
      settings = await idm.invoke('settings', { save: { categories: cats().map(c => (c.id === cat.id ? { ...c, rememberLast: $('remember').checked } : c)) } });
    }
    item = await idm.invoke('confirm', ID, {
      filename: $('filename').value.trim(), dir: $('folder').value.trim(), category, start,
      queueId: start ? undefined : $('laterQueue').value, description: $('description').value
    });
    if (!start || !settings.downloads.showProgress) idm.invoke('close');
    else render();
  } catch (err) {
    showError($('askError'), err);
  }
}

$('category').addEventListener('change', () => { edited.category = true; edited.folder = false; setCategory($('category').value); });
$('folder').addEventListener('input', () => { edited.folder = true; });
$('filename').addEventListener('input', () => {
  edited.filename = true;
  if (!edited.category) setCategory(categoryFor($('filename').value).id);
});
$('browse').addEventListener('click', async () => {
  const p = await idm.invoke('pickFolder', $('folder').value);
  if (p) { $('folder').value = p; edited.folder = true; }
});
$('start').addEventListener('click', () => confirm(true));
$('later').addEventListener('click', () => confirm(false));
$('cancelAsk').addEventListener('click', async () => { await idm.invoke('remove', [ID]).catch(() => {}); idm.invoke('close'); });
for (const id of ['filename', 'folder', 'description']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(true); });

// ---------- progress ----------

function drawSegments() {
  const canvas = $('segments');
  const w = canvas.clientWidth;
  if (!w) return;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(16 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--track');
  ctx.fillRect(0, 0, w, 16);
  if (!item.size) return;
  const x = (b) => b / item.size * w;
  ctx.fillStyle = css.getPropertyValue('--accent');
  for (const [start, written] of item.segments || []) ctx.fillRect(x(start), 0, Math.max(x(written) - x(start), 0), 16);
  ctx.fillStyle = css.getPropertyValue('--surface');
  for (const [start] of item.segments || []) if (start > 0) ctx.fillRect(x(start), 0, 1.5, 16);
}

function renderProgress() {
  show('progress');
  const pct = item.progress || 0;
  const name = item.filename || item.url;
  document.title = item.status === 'downloading' ? `${pct}% ${name}` : name;
  $('progName').textContent = name;
  $('progUrl').textContent = item.url;
  $('progUrl').title = item.url;
  $('progFill').style.width = `${pct}%`;
  $('progFill').parentElement.className = `bar big${item.status === 'error' ? ' error' : ''}`;
  const statusKey = { queued: item.queueId ? 'dl.st.inQueue' : 'dl.st.waiting', starting: 'dl.st.connecting', downloading: 'dl.st.receiving',
    paused: 'dl.st.paused', error: 'dl.st.error', cancelled: 'dl.st.cancelled', scanning: 'dl.st.scanning' }[item.status] || `status.${item.status}`;
  $('progStatus').textContent = t(statusKey, { pct });
  $('progSize').textContent = item.size ? fmtBytes(item.size, 2) : t('dl.unknown');
  $('progDone').textContent = item.size ? `${fmtBytes(item.received, 2)} (${pct}%)` : fmtBytes(item.received, 2) || '—';
  if (item.status === 'downloading') { rate.push(item.speed || 0); if (rate.length > 8) rate.shift(); } else rate = [];
  const avg = rate.length ? rate.reduce((a, b) => a + b, 0) / rate.length : 0;
  $('progSpeed').textContent = fmtSpeed(avg) || '—';
  $('progEta').textContent = avg && item.size ? fmtTime((item.size - item.received) / avg) : '—';
  $('progResume').textContent = item.resumable == null ? '—' : t(item.resumable ? 'common.yes' : 'common.no');
  $('progConns').textContent = item.status === 'downloading' ? t('dl.connections', { n: item.connections || 0 }) : '';
  $('progError').hidden = !item.error;
  $('progError').textContent = item.error || '';
  const running = ['queued', 'starting', 'downloading'].includes(item.status);
  $('pauseResume').textContent = running ? t('dl.pause') : t(item.status === 'paused' ? 'dl.resume' : 'dl.retry');
  $('pauseResume').disabled = item.status === 'scanning';
  $('cancelDl').hidden = item.status === 'cancelled' || item.status === 'scanning';
  drawSegments();
}

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== b.dataset.tab;
    if (b.dataset.tab === 'status') drawSegments();
  });
}
$('pauseResume').addEventListener('click', () => {
  const running = ['queued', 'starting', 'downloading'].includes(item.status);
  idm.invoke(running ? 'pause' : 'resume', [ID]);
});
$('cancelDl').addEventListener('click', async () => { await idm.invoke('cancel', [ID]); idm.invoke('close'); });
$('hide').addEventListener('click', () => idm.invoke('close'));
$('limApply').addEventListener('click', () => idm.invoke('settings', { speedLimit: { enabled: $('limOn').checked, kbps: Number($('limKbps').value) || 1 } }));
$('limOn').addEventListener('change', () => idm.invoke('settings', { speedLimit: { enabled: $('limOn').checked, kbps: Number($('limKbps').value) || 1 } }));
$('showComplete').addEventListener('change', () => idm.invoke('settings', { downloads: { showComplete: $('showComplete').checked } }));

// ---------- complete ----------

function renderComplete() {
  show('complete');
  document.title = t('dl.completeTitle');
  $('doneIcon').innerHTML = fileBadge(item.filename, item.category);
  $('doneName').textContent = item.filename;
  $('doneSize').textContent = fmtBytes(item.size, 2);
  $('donePath').textContent = item.dest || '';
  $('doneUrl').textContent = item.url;
  $('doneScanLabel').hidden = $('doneScan').hidden = !item.scan;
  $('doneScan').textContent = item.scan ? t(item.scan === 'clean' ? 'dl.scanClean' : 'dl.scanWarning', { detail: item.scan }) : '';
}

const fileAction = async (name) => {
  const r = await idm.invoke(name, ID);
  if (r === 'missing') return showError($('doneError'), t('dl.missing'));
  if (r && r !== 'ok') return showError($('doneError'), r);
  idm.invoke('close');
};
$('openFile').addEventListener('click', () => fileAction('open'));
$('openFolder').addEventListener('click', () => fileAction('openFolder'));
$('closeDone').addEventListener('click', () => idm.invoke('close'));
$('closeGone').addEventListener('click', () => idm.invoke('close'));
$('dontShow').addEventListener('change', () => idm.invoke('settings', { downloads: { showComplete: !$('dontShow').checked } }));

// ---------- wiring ----------

function syncSettingsControls() {
  $('limOn').checked = settings.speedLimit.enabled;
  if (document.activeElement !== $('limKbps')) $('limKbps').value = settings.speedLimit.kbps;
  $('showComplete').checked = settings.downloads.showComplete;
  $('dontShow').checked = !settings.downloads.showComplete;
}

function render() {
  if (!item) return show('gone');
  if (item.status === 'pending') return renderAsk();
  if (item.status === 'done') return renderComplete();
  return renderProgress();
}

async function main() {
  const state = await boot();
  settings = state.settings;
  fillSelects();
  syncSettingsControls();
  item = await idm.invoke('item', ID);
  render();
  if (view === 'ask') $('filename').focus();
  idm.on('item', (d) => { if (d.id === ID) { item = d; render(); } });
  idm.on('remove', (d) => { if (d.id === ID) { item = null; render(); } });
  idm.on('settings', (s) => { settings = s; syncSettingsControls(); if (view === 'ask') { const c = $('category').value; fillSelects(); $('category').value = c; } });
  document.addEventListener('i18n', render);
  addEventListener('resize', () => view === 'progress' && drawSegments());
}

main();
