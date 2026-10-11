'use strict';

// One window per download, like IDM: "Download File Info" (choose name and
// folder), then progress, then "Download complete" with Open / Open folder.
// The download id is in the URL hash: /dialog.html#<id>

const TOKEN = document.querySelector('meta[name="mini-idm-token"]').content;
const ID = location.hash.slice(1);
const $ = (id) => document.getElementById(id);

let settings = null;
let item = null;
let view = null;
let folderEdited = false;
let categoryEdited = false;
let rateSamples = [];

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  }).then(async (r) => {
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
    return body;
  });
}

function fmtBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 1) return '< 1 s';
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}

function show(name) {
  if (view === name) return;
  view = name;
  for (const s of ['ask', 'progress', 'complete', 'gone']) $(s).hidden = s !== name;
}

const closeWindow = () => window.close();

// ---------- Download File Info ----------

function categoryFor(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return settings.categories.find(c => c.id !== 'general' && filename.includes('.') && c.exts.includes(ext))
    || settings.categories.find(c => c.id === 'general');
}

function setCategory(id) {
  const cat = settings.categories.find(c => c.id === id);
  $('category').value = cat.id;
  $('rememberCat').textContent = cat.name;
  if (!folderEdited) $('folder').value = cat.folder;
}

function renderAsk() {
  show('ask');
  document.title = 'Download File Info';
  $('askUrl').textContent = item.url;
  $('askUrl').title = item.url;
  if (document.activeElement !== $('filename') && !$('filename').dataset.edited) $('filename').value = item.filename;
  if (!categoryEdited) setCategory(item.category || categoryFor(item.filename).id);
  if (!folderEdited && item.dir) $('folder').value = item.dir;

  const info = [];
  if (item.inspecting) info.push('Getting file info…');
  else {
    info.push(`Size: ${item.size ? fmtBytes(item.size) : 'unknown'}`);
    if (item.mime) info.push(item.mime);
  }
  $('askInfo').textContent = info.join(' · ');
  if (item.inspectError) {
    $('askError').textContent = `The server answered: ${item.inspectError}. You can still try to download it.`;
    $('askError').hidden = false;
  }
}

async function confirm(start) {
  const folder = $('folder').value.trim();
  const filename = $('filename').value.trim();
  const category = $('category').value;
  $('askError').hidden = true;
  try {
    if ($('remember').checked) {
      settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ categories: [{ id: category, folder }] }) });
    }
    item = await api(`/api/downloads/${ID}/confirm`, { method: 'POST', body: JSON.stringify({ filename, dir: folder, category, start }) });
    if (!start || !settings.showDialog) closeWindow();
    render();
  } catch (err) {
    $('askError').textContent = err.message;
    $('askError').hidden = false;
  }
}

$('category').addEventListener('change', () => { categoryEdited = true; setCategory($('category').value); });
$('folder').addEventListener('input', () => { folderEdited = true; });
$('filename').addEventListener('input', () => {
  $('filename').dataset.edited = '1';
  if (!categoryEdited) setCategory(categoryFor($('filename').value).id);
});
$('browse').addEventListener('click', async () => {
  $('browse').disabled = true;
  try {
    const { path } = await api('/api/pick-folder', { method: 'POST', body: JSON.stringify({ initial: $('folder').value }) });
    if (path) { $('folder').value = path; folderEdited = true; }
  } catch (err) {
    $('askError').textContent = err.message;
    $('askError').hidden = false;
  } finally {
    $('browse').disabled = false;
  }
});
$('start').addEventListener('click', () => confirm(true));
$('later').addEventListener('click', () => confirm(false));
$('cancelAsk').addEventListener('click', async () => {
  await api(`/api/downloads/${ID}`, { method: 'DELETE' }).catch(() => {});
  closeWindow();
});
$('filename').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(true); });

// ---------- Progress ----------

function drawSegments() {
  const canvas = $('segments');
  const w = canvas.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(14 * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--track');
  ctx.fillRect(0, 0, w, 14);
  if (!item.size) return;
  const x = (b) => b / item.size * w;
  if (item.status === 'done') {
    ctx.fillStyle = css.getPropertyValue('--ok');
    ctx.fillRect(0, 0, w, 14);
    return;
  }
  ctx.fillStyle = css.getPropertyValue('--accent');
  for (const [start, written] of item.segments || []) ctx.fillRect(x(start), 0, Math.max(x(written) - x(start), 0), 14);
  ctx.fillStyle = css.getPropertyValue('--bg');
  for (const [start] of item.segments || []) ctx.fillRect(x(start), 0, 1, 14); // start-position marks
}

function renderProgress() {
  show('progress');
  const pct = item.progress || 0;
  const name = item.filename || item.url;
  document.title = item.status === 'downloading' ? `${pct}% ${name}` : name;
  $('progTitle').textContent = { queued: 'Waiting in queue', starting: 'Connecting…', downloading: 'Downloading',
    paused: 'Paused', error: 'Download failed', cancelled: 'Cancelled' }[item.status] || item.status;
  $('progName').textContent = name;
  $('progUrl').textContent = item.url;
  $('progFill').style.width = `${pct}%`;
  $('progFill').className = 'fill' + (item.status === 'error' ? ' error' : '');
  $('progStatus').textContent = item.status === 'downloading' ? `Receiving data… ${pct}%` : item.status;
  $('progSize').textContent = item.size ? fmtBytes(item.size) : 'unknown';
  $('progDone').textContent = item.size ? `${fmtBytes(item.received)} (${pct}%)` : fmtBytes(item.received);

  // Smooth the rate over the last few updates, like IDM's transfer rate.
  if (item.status === 'downloading') {
    rateSamples.push(item.speed || 0);
    if (rateSamples.length > 8) rateSamples.shift();
  } else rateSamples = [];
  const rate = rateSamples.length ? rateSamples.reduce((a, b) => a + b, 0) / rateSamples.length : 0;
  $('progSpeed').textContent = rate ? `${fmtBytes(rate)}/s` : '—';
  $('progEta').textContent = rate && item.size ? fmtTime((item.size - item.received) / rate) : '—';
  $('progConns').textContent = item.status === 'downloading' ? String(item.connections || 0) : '—';

  $('progError').hidden = !item.error;
  $('progError').textContent = item.error || '';
  const running = ['queued', 'starting', 'downloading'].includes(item.status);
  $('pauseResume').textContent = running ? 'Pause' : (item.status === 'paused' ? 'Resume' : 'Retry');
  $('cancelDl').hidden = item.status === 'cancelled';
  drawSegments();
}

$('pauseResume').addEventListener('click', () => {
  const running = ['queued', 'starting', 'downloading'].includes(item.status);
  api(`/api/downloads/${ID}/${running ? 'pause' : 'resume'}`, { method: 'POST' }).catch(() => {});
});
$('cancelDl').addEventListener('click', async () => {
  await api(`/api/downloads/${ID}/cancel`, { method: 'POST' }).catch(() => {});
  closeWindow();
});
$('hide').addEventListener('click', closeWindow);

// ---------- Complete ----------

function renderComplete() {
  show('complete');
  document.title = 'Download complete';
  $('doneName').textContent = item.filename;
  $('doneSize').textContent = fmtBytes(item.size);
  $('donePath').textContent = item.dest;
  $('donePath').title = item.dest;
}

$('openFile').addEventListener('click', () => api(`/api/downloads/${ID}/open`, { method: 'POST' }).then(closeWindow, () => {}));
$('openFolder').addEventListener('click', () => api(`/api/downloads/${ID}/open-folder`, { method: 'POST' }).then(closeWindow, () => {}));
$('closeDone').addEventListener('click', closeWindow);
$('closeGone').addEventListener('click', closeWindow);

// ---------- Wiring ----------

function render() {
  if (!item) return show('gone');
  if (item.status === 'pending') return renderAsk();
  if (item.status === 'done') return renderComplete();
  return renderProgress();
}

async function init() {
  try {
    settings = await api('/api/settings');
    const select = $('category');
    select.replaceChildren(...settings.categories.map((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      return o;
    }));
    item = await api(`/api/downloads/${ID}`);
  } catch {
    item = null;
  }
  render();

  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('update', (e) => {
    const d = JSON.parse(e.data);
    if (d.id !== ID) return;
    item = d;
    render();
  });
  es.addEventListener('remove', (e) => {
    if (JSON.parse(e.data).id !== ID) return;
    item = null;
    render();
  });
}

window.addEventListener('resize', () => { if (view === 'progress') drawSegments(); });
init();
