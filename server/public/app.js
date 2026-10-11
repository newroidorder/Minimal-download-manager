'use strict';

// Filenames and URLs come from untrusted servers and pages: render them only
// with textContent, never innerHTML.

const TOKEN = document.querySelector('meta[name="mini-idm-token"]').content;
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const connEl = document.getElementById('conn');
const formErr = document.getElementById('formError');
const tpl = document.getElementById('rowTpl');
const items = new Map();   // id -> item
const rows = new Map();    // id -> <tr>

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

function fmtBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function button(label, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost' + (danger ? ' danger' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const act = (id, action) => () => api(`/api/downloads/${id}/${action}`, { method: 'POST' });
const remove = (id) => () => api(`/api/downloads/${id}`, { method: 'DELETE' });
const openDialog = (id) => window.open(`/dialog.html#${id}`, `mini-idm-${id}`, 'popup,width=560,height=520');

function renderRow(d) {
  let tr = rows.get(d.id);
  if (!tr) {
    tr = tpl.content.firstElementChild.cloneNode(true);
    rows.set(d.id, tr);
  }
  tr.querySelector('.name').textContent = d.filename || d.url;
  tr.querySelector('.name').title = d.dest || d.filename || '';
  tr.querySelector('.src').textContent = d.dest || d.url;
  tr.querySelector('.src').title = d.url;

  const fill = tr.querySelector('.fill');
  fill.style.width = `${d.progress || 0}%`;
  fill.className = 'fill' + (d.status === 'done' ? ' done' : d.status === 'error' ? ' error' : '');
  const conns = d.status === 'downloading' && d.connections ? ` · ${d.connections} conn` : '';
  tr.querySelector('.pct').textContent = d.size ? `${d.progress || 0}%${conns}` : (d.received ? fmtBytes(d.received) + conns : '');
  tr.querySelector('.size').textContent = fmtBytes(d.size);
  tr.querySelector('.speed').textContent = d.status === 'downloading' && d.speed ? `${fmtBytes(d.speed)}/s` : '';

  const badge = tr.querySelector('.badge');
  badge.textContent = d.status;
  badge.className = `badge ${d.status}`;
  tr.querySelector('.err').textContent = d.error || '';

  // Rebuild buttons only when the status changes, so progress ticks don't eat clicks.
  if (tr.dataset.status === d.status) return tr;
  tr.dataset.status = d.status;
  const actions = tr.querySelector('.actions');
  actions.replaceChildren();
  if (d.status === 'pending') actions.append(button('Choose folder…', () => openDialog(d.id)));
  if (d.status === 'done') actions.append(button('Open', act(d.id, 'open')), button('Open folder', act(d.id, 'open-folder')));
  if (d.status === 'downloading' || d.status === 'starting' || d.status === 'queued') actions.append(button('Pause', act(d.id, 'pause')));
  if (d.status === 'paused') actions.append(button('Resume', act(d.id, 'resume')));
  if (d.status === 'error' || d.status === 'cancelled') actions.append(button('Retry', act(d.id, 'resume')));
  if (!['done', 'cancelled', 'pending'].includes(d.status)) actions.append(button('Cancel', act(d.id, 'cancel'), true));
  actions.append(button('Remove', remove(d.id)));
  return tr;
}

function renderAll() {
  const sorted = [...items.values()].sort((a, b) => b.addedAt - a.addedAt);
  rowsEl.replaceChildren(...sorted.map(renderRow));
  emptyEl.hidden = sorted.length > 0;
}

document.getElementById('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  formErr.hidden = true;
  const url = document.getElementById('url').value.trim();
  const filename = document.getElementById('name').value.trim() || undefined;
  try {
    const r = await api('/api/downloads', { method: 'POST', body: JSON.stringify({ url, filename, interactive: true }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    e.target.reset();
    if (body.dialogUrl) openDialog(body.id);
  } catch (err) {
    formErr.textContent = `Could not add download: ${err.message}`;
    formErr.hidden = false;
  }
});

function connect() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('open', () => { connEl.textContent = 'Connected'; connEl.className = 'conn online'; });
  es.addEventListener('error', () => { connEl.textContent = 'Server offline, retrying…'; connEl.className = 'conn'; });
  es.addEventListener('snapshot', (e) => {
    items.clear();
    rows.clear();
    for (const d of JSON.parse(e.data)) items.set(d.id, d);
    renderAll();
  });
  es.addEventListener('update', (e) => {
    const d = JSON.parse(e.data);
    const isNew = !items.has(d.id);
    items.set(d.id, d);
    if (isNew) renderAll(); else renderRow(d);
  });
  es.addEventListener('remove', (e) => {
    const { id } = JSON.parse(e.data);
    items.delete(id);
    rows.delete(id);
    renderAll();
  });
}

// ---------- Settings ----------

const settingsForm = document.getElementById('settings');

function field(value, opts = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  Object.assign(input, opts);
  return input;
}

async function loadSettings() {
  const s = await (await api('/api/settings')).json();
  const grid = document.getElementById('catGrid');
  grid.querySelectorAll(':not(.head)').forEach(n => n.remove());
  for (const c of s.categories) {
    const label = document.createElement('span');
    label.textContent = c.name;
    const folder = field(c.folder, { spellcheck: false });
    folder.dataset.cat = c.id;
    folder.dataset.kind = 'folder';
    folder.setAttribute('aria-label', `${c.name} folder`);
    const exts = c.id === 'general'
      ? field('everything else', { disabled: true })
      : field(c.exts.join(', '), { spellcheck: false });
    exts.dataset.cat = c.id;
    exts.dataset.kind = 'exts';
    exts.setAttribute('aria-label', `${c.name} file types`);
    grid.append(label, folder, exts);
  }
  document.getElementById('askWhereToSave').checked = s.askWhereToSave;
  document.getElementById('showDialog').checked = s.showDialog;
  document.getElementById('maxActive').value = s.maxActive;
  document.getElementById('maxConnections').value = s.maxConnections;
}

document.getElementById('toggleSettings').addEventListener('click', async () => {
  if (settingsForm.hidden) await loadSettings();
  settingsForm.hidden = !settingsForm.hidden;
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('settingsError');
  const saved = document.getElementById('settingsSaved');
  err.hidden = true;
  const categories = {};
  for (const input of settingsForm.querySelectorAll('[data-cat]:not(:disabled)')) {
    categories[input.dataset.cat] ??= { id: input.dataset.cat };
    categories[input.dataset.cat][input.dataset.kind] = input.value;
  }
  const body = {
    categories: Object.values(categories),
    askWhereToSave: document.getElementById('askWhereToSave').checked,
    showDialog: document.getElementById('showDialog').checked,
    maxActive: document.getElementById('maxActive').value,
    maxConnections: document.getElementById('maxConnections').value
  };
  const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
  const res = await r.json();
  if (!r.ok) {
    err.textContent = res.error;
    err.hidden = false;
    return;
  }
  await loadSettings();
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
});

renderAll();
connect();
