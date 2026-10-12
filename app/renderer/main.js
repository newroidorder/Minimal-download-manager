// Main window: menu bar, toolbar, category tree, download list, status bar.

import {
  mdm, t, boot, el, icon, hydrateIcons, applyI18n, fmtBytes, fmtSpeed, fmtDate, catName, queueName,
  statusText, timeLeft, fileBadge, showMenu, closeMenus
} from './common.js';

const S = {
  items: new Map(),
  settings: null,
  running: new Set(),
  bridge: {},
  extensionId: '',
  selected: new Set(),
  anchor: null,           // for shift-click ranges
  node: { type: 'all' },  // current tree node
  search: '',
  order: [],              // ids in display order
  expanded: loadJSON('tree', { all: true, queues: true, unfinished: false, finished: false, projects: false })
};
const rows = new Map();   // id -> row element

function loadJSON(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const $ = (id) => document.getElementById(id);
const call = (name, ...args) => mdm.invoke(name, ...args).catch(err => toastError(err));
const sel = () => [...S.selected].filter(id => S.items.has(id));
const selItems = () => sel().map(id => S.items.get(id));
const ACTIVE = new Set(['starting', 'downloading']);

function toastError(err) {
  const msg = String(err?.message || err).replace(/^Error invoking remote method 'mdm': (Error: )?/, '');
  confirmBox({ title: t('common.error'), text: msg, yes: t('common.ok'), noCancel: true });
}

// ---------- columns ----------

const COLS = [
  { id: 'name', key: 'col.name', w: 320, sort: 'name' },
  { id: 'queue', key: 'col.queue', w: 90, sort: 'queue' },
  { id: 'size', key: 'col.size', w: 92, sort: 'size' },
  { id: 'status', key: 'col.status', w: 140, sort: 'status' },
  { id: 'timeLeft', key: 'col.timeLeft', w: 96, sort: 'timeLeft' },
  { id: 'rate', key: 'col.rate', w: 104, sort: 'rate' },
  { id: 'lastTry', key: 'col.lastTry', w: 140, sort: 'lastTry' },
  { id: 'description', key: 'col.description', w: 220, sort: 'description' }
];
const visibleCols = () => COLS.filter(c => S.settings.ui.columns[c.id] !== false);
const colWidth = (c) => S.settings.ui.columnWidths[c.id] || c.w;

function renderHeader() {
  const head = $('thead');
  head.replaceChildren();
  const cols = visibleCols();
  document.documentElement.style.setProperty('--cols', cols.map(c => `${colWidth(c)}px`).join(' ') + ' 1fr');
  for (const c of cols) {
    const sorted = S.settings.ui.sortBy === c.sort;
    const th = el('div', { class: 'th', role: 'columnheader' },
      el('span', { text: t(c.key) }),
      sorted ? el('span', { class: 'sort', html: icon(S.settings.ui.sortDir === 'asc' ? 'up' : 'down') }) : null,
      el('span', { class: 'grip' }));
    th.addEventListener('click', (e) => {
      if (e.target.classList.contains('grip')) return;
      const dir = sorted && S.settings.ui.sortDir === 'asc' ? 'desc' : 'asc';
      call('settings', { ui: { sortBy: c.sort, sortDir: dir } });
    });
    th.querySelector('.grip').addEventListener('mousedown', (e) => startColumnResize(e, c));
    th.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(columnsMenu(), e.clientX, e.clientY); });
    head.append(th);
  }
  head.append(el('div', { class: 'th' }));
}

function startColumnResize(e, col) {
  e.preventDefault();
  const startX = e.clientX, startW = colWidth(col);
  const widths = { ...S.settings.ui.columnWidths };
  const move = (ev) => {
    widths[col.id] = Math.max(48, Math.min(800, startW + ev.clientX - startX));
    S.settings.ui.columnWidths = widths;
    document.documentElement.style.setProperty('--cols', visibleCols().map(c => `${colWidth(c)}px`).join(' ') + ' 1fr');
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    call('settings', { ui: { columnWidths: widths } });
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

function columnsMenu() {
  return COLS.filter(c => c.id !== 'name').map(c => ({
    label: t(c.key), checked: S.settings.ui.columns[c.id] !== false,
    action: () => call('settings', { ui: { columns: { [c.id]: S.settings.ui.columns[c.id] === false } } })
  }));
}

// ---------- list ----------

function matchesNode(i, node = S.node) {
  if (node.type === 'queue') return i.queueId === node.queue;
  if (node.type === 'unfinished' && i.status === 'done') return false;
  if (node.type === 'finished' && i.status !== 'done') return false;
  if (node.cat && i.category !== node.cat) return false;
  return true;
}

function matchesSearch(i) {
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  return (i.filename || '').toLowerCase().includes(q) || (i.url || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q);
}

function sortValue(i, by) {
  switch (by) {
    case 'name': return (i.filename || '').toLowerCase();
    case 'size': return i.size || 0;
    case 'status': return `${i.status === 'done' ? 'z' : i.status}${String(i.progress || 0).padStart(3, '0')}`;
    case 'lastTry': return i.lastTryAt || 0;
    case 'description': return (i.description || '').toLowerCase();
    case 'rate': return i.speed || 0;
    case 'timeLeft': return i.speed && i.size ? (i.size - i.received) / i.speed : Infinity;
    case 'queue': return i.queueId || '';
    case 'category': return i.category || '';
    default: return i.addedAt || 0;
  }
}

function computeOrder() {
  const { sortBy, sortDir } = S.settings.ui;
  const list = [...S.items.values()].filter(i => matchesNode(i) && matchesSearch(i));
  const dir = sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const x = sortValue(a, sortBy), y = sortValue(b, sortBy);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.addedAt - a.addedAt);
  });
  return list.map(i => i.id);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderList(); renderTree(); renderStatus(); updateToolbar(); });
}

function renderList() {
  S.order = computeOrder();
  const body = $('tbody');
  const wanted = S.order.map(id => rowFor(S.items.get(id)));
  body.replaceChildren(...wanted);
  for (const id of [...rows.keys()]) if (!S.items.has(id)) rows.delete(id);
  for (const id of [...S.selected]) if (!S.order.includes(id)) S.selected.delete(id);
  const empty = $('empty');
  empty.hidden = S.order.length > 0;
  empty.textContent = S.search ? t('list.noMatch') : t('list.empty');
}

function rowFor(item) {
  let row = rows.get(item.id);
  if (!row || row._cols !== visibleCols().map(c => c.id).join()) {
    row = el('div', { class: 'row', role: 'row' });
    row._cols = visibleCols().map(c => c.id).join();
    row.dataset.id = item.id;
    for (const c of visibleCols()) row.append(el('div', { class: `cell ${c.id}`, role: 'gridcell' }));
    row.append(el('div', { class: 'cell' }));
    row.addEventListener('mousedown', (e) => onRowMouseDown(e, item.id));
    row.addEventListener('dblclick', () => call('showDownload', item.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!S.selected.has(item.id)) selectOnly(item.id);
      showMenu(itemMenu(), e.clientX, e.clientY);
    });
    rows.set(item.id, row);
  }
  fillRow(row, S.items.get(item.id));
  row.classList.toggle('sel', S.selected.has(item.id));
  return row;
}

function fillRow(row, i) {
  const cells = row.children;
  const queues = S.settings.queues;
  visibleCols().forEach((c, n) => {
    const cell = cells[n];
    switch (c.id) {
      case 'name': {
        if (cell._name !== i.filename || cell._cat !== i.category) {
          cell.innerHTML = fileBadge(i.filename, i.category);
          cell.append(el('span', { class: 'nm', text: i.filename || i.url }));
          cell._name = i.filename; cell._cat = i.category;
        }
        cell.title = i.dest || i.url;
        break;
      }
      case 'queue': cell.textContent = i.queueId ? queueName(queues.find(q => q.id === i.queueId)) : ''; cell.className = 'cell queue muted'; break;
      case 'size': cell.textContent = fmtBytes(i.size) || (i.received ? fmtBytes(i.received) : ''); break;
      case 'status': {
        if (!cell._bar) {
          cell._st = el('span', { class: 'st' });
          cell._bar = el('div', { class: 'bar' }, el('div'));
          cell.append(cell._st, cell._bar);
        }
        cell.className = `cell status ${i.status}`;
        cell._st.textContent = statusText(i, queues);
        cell._st.title = i.error || i.scan || '';
        const showBar = ['downloading', 'starting', 'paused', 'error', 'scanning'].includes(i.status) && i.size;
        cell._bar.hidden = !showBar;
        cell._bar.className = `bar${i.status === 'error' ? ' error' : ''}`;
        cell._bar.firstChild.style.width = `${i.progress || 0}%`;
        break;
      }
      case 'timeLeft': cell.textContent = timeLeft(i); break;
      case 'rate': cell.textContent = i.status === 'downloading' ? fmtSpeed(i.speed) : ''; break;
      case 'lastTry': cell.textContent = fmtDate(i.lastTryAt || i.addedAt); cell.className = 'cell lastTry muted'; break;
      case 'description': cell.textContent = i.description || ''; cell.className = 'cell description muted'; cell.title = i.description || ''; break;
    }
  });
}

function updateRow(item) {
  const row = rows.get(item.id);
  if (!row || !row.isConnected) return false;
  fillRow(row, item);
  return true;
}

// ---------- selection ----------

function selectOnly(id) {
  S.selected = new Set([id]);
  S.anchor = id;
  paintSelection();
}

function onRowMouseDown(e, id) {
  if (e.button === 2 && S.selected.has(id)) return;
  if (e.shiftKey && S.anchor) {
    const a = S.order.indexOf(S.anchor), b = S.order.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!e.ctrlKey) S.selected.clear();
    for (const x of S.order.slice(lo, hi + 1)) S.selected.add(x);
  } else if (e.ctrlKey) {
    if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
    S.anchor = id;
  } else {
    S.selected = new Set([id]);
    S.anchor = id;
  }
  paintSelection();
}

function paintSelection() {
  for (const [id, row] of rows) row.classList.toggle('sel', S.selected.has(id));
  updateToolbar();
}

function moveSelection(delta, extend) {
  if (!S.order.length) return;
  const cur = S.order.indexOf(S.anchor);
  const next = S.order[Math.max(0, Math.min(S.order.length - 1, cur < 0 ? 0 : cur + delta))];
  if (extend) S.selected.add(next); else S.selected = new Set([next]);
  S.anchor = next;
  paintSelection();
  rows.get(next)?.scrollIntoView({ block: 'nearest' });
}

// ---------- tree ----------

function counts() {
  const c = { all: 0, unfinished: 0, finished: 0, cat: {}, ucat: {}, fcat: {}, queue: {} };
  for (const i of S.items.values()) {
    c.all++;
    c.cat[i.category] = (c.cat[i.category] || 0) + 1;
    if (i.status === 'done') { c.finished++; c.fcat[i.category] = (c.fcat[i.category] || 0) + 1; }
    else { c.unfinished++; c.ucat[i.category] = (c.ucat[i.category] || 0) + 1; }
    if (i.queueId) c.queue[i.queueId] = (c.queue[i.queueId] || 0) + 1;
  }
  return c;
}

function sameNode(a, b) {
  return a.type === b.type && (a.cat || null) === (b.cat || null) && (a.queue || null) === (b.queue || null);
}

function treeNode({ node, label, iconName, count, children, expandKey, running, onContext, onOpen }) {
  const li = el('li', { role: 'treeitem' });
  const open = expandKey ? S.expanded[expandKey] : false;
  const tw = el('span', { class: 'tw', html: children ? icon(open ? 'chevronDown' : 'chevronRight') : '' });
  const row = el('div', { class: `node${node && sameNode(node, S.node) ? ' sel' : ''}` },
    tw,
    el('span', { class: 'ni', html: icon(iconName) }),
    el('span', { class: 'nl', text: label }),
    running ? el('span', { class: 'run', title: t('queue.running') }) : null,
    count ? el('span', { class: 'count', text: String(count) }) : null);
  tw.addEventListener('click', (e) => {
    e.stopPropagation();
    S.expanded[expandKey] = !S.expanded[expandKey];
    saveJSON('tree', S.expanded);
    renderTree();
  });
  row.addEventListener('click', () => {
    if (onOpen) return onOpen();
    if (!node) { S.expanded[expandKey] = !S.expanded[expandKey]; saveJSON('tree', S.expanded); renderTree(); return; }
    S.node = node;
    S.selected.clear();
    scheduleRender();
  });
  if (onContext) row.addEventListener('contextmenu', (e) => { e.preventDefault(); onContext(e); });
  li.append(row);
  if (children && open) li.append(el('ul', { role: 'group' }, children));
  return li;
}

function renderTree() {
  const c = counts();
  const cats = S.settings.save.categories;
  const catNodes = (type, map) => cats.map(cat => treeNode({
    node: { type, cat: cat.id }, label: catName(cat), iconName: ['compressed', 'documents', 'music', 'programs', 'video', 'general'].includes(cat.id) ? cat.id : 'category', count: map[cat.id]
  }));
  const queues = S.settings.queues.map(q => treeNode({
    node: { type: 'queue', queue: q.id }, label: queueName(q), iconName: 'queue', count: c.queue[q.id], running: S.running.has(q.id),
    onContext: (e) => showMenu(queueMenu(q), e.clientX, e.clientY)
  }));
  const projects = (S.settings.grabberProjects || []).map(p => treeNode({
    label: p.name, iconName: 'grabber', onOpen: () => call('window', 'grabber', { project: p.id })
  }));
  $('tree').replaceChildren(
    treeNode({ node: { type: 'all' }, label: t('side.all'), iconName: 'all', count: c.all, expandKey: 'all', children: catNodes('all', c.cat) }),
    treeNode({ node: { type: 'unfinished' }, label: t('side.unfinished'), iconName: 'unfinished', count: c.unfinished, expandKey: 'unfinished', children: catNodes('unfinished', c.ucat) }),
    treeNode({ node: { type: 'finished' }, label: t('side.finished'), iconName: 'finished', count: c.finished, expandKey: 'finished', children: catNodes('finished', c.fcat) }),
    treeNode({ label: t('side.projects'), iconName: 'projects', expandKey: 'projects', children: projects.length ? projects : [treeNode({ label: t('side.newProject'), iconName: 'add', onOpen: () => call('window', 'grabber') })] }),
    treeNode({ label: t('side.queues'), iconName: 'queues', expandKey: 'queues', children: queues, onContext: (e) => showMenu([{ label: t('menu.scheduler'), icon: 'scheduler', action: () => call('window', 'scheduler') }], e.clientX, e.clientY) })
  );
}

function queueMenu(q) {
  const running = S.running.has(q.id);
  return [
    { label: t('menu.startQueueNow'), icon: 'startQueue', disabled: running, action: () => call('startQueue', q.id) },
    { label: t('menu.stopQueueNow'), icon: 'stopQueue', disabled: !running, action: () => call('stopQueue', q.id) },
    '-',
    { label: t('menu.editQueue'), icon: 'scheduler', action: () => call('window', 'scheduler', { queue: q.id }) }
  ];
}

// ---------- status bar ----------

function renderStatus() {
  const all = [...S.items.values()];
  const active = all.filter(i => i.status === 'downloading');
  const speed = active.reduce((n, i) => n + (i.speed || 0), 0);
  $('stCount').textContent = t('status.count', { n: all.length, active: active.length });
  const sp = $('stSpeed');
  sp.lastChild?.nodeType === 3 ? (sp.lastChild.textContent = fmtSpeed(speed) || '0 KB/s') : sp.append(fmtSpeed(speed) || '0 KB/s');
  const lim = S.settings.speedLimit;
  const limiter = $('stLimiter');
  limiter.classList.toggle('on', lim.enabled);
  setChipText(limiter, lim.enabled ? t('status.limitOn', { speed: fmtSpeed(lim.kbps * 1024) }) : t('status.limitOff'));

  const b = $('stBridge');
  const names = new Set(Object.keys(S.bridge.live || {}));
  for (const [k, ts] of Object.entries(S.bridge.seen || {})) if (Date.now() - ts < 5 * 60_000) names.add(k);
  const seen = [...names].map(k => t(`browser.${k}`));
  const http = S.bridge.http || {};
  b.className = 'chip';
  b.replaceChildren(el('span', { class: 'dot' }));
  if (seen.length) { b.classList.add('good'); b.append(t('status.browserConnected', { names: seen.join(', ') })); }
  else if (http.enabled && http.error === 'in-use') { b.classList.add('bad'); b.append(t('status.portBusy', { port: http.port })); }
  else if (!S.bridge.listening) { b.append(t('status.bridgeStarting')); }
  else { b.append(t('status.browserWaiting')); }
}

function setChipText(chip, text) {
  const last = chip.lastChild;
  if (last && last.nodeType === 3) last.textContent = text;
  else chip.append(text);
}

// ---------- toolbar & actions ----------

function updateToolbar() {
  const items = selItems();
  const can = {
    resume: items.some(i => ['paused', 'error', 'cancelled', 'queued'].includes(i.status) && !(i.status === 'queued' && !i.queueId)),
    stop: items.some(i => ACTIVE.has(i.status) || i.status === 'queued' || i.status === 'error'),
    remove: items.length > 0,
    removeDone: [...S.items.values()].some(i => i.status === 'done'),
    stopAll: [...S.items.values()].some(i => ACTIVE.has(i.status) || i.status === 'queued')
  };
  for (const b of document.querySelectorAll('.tb[data-act]')) {
    if (b.dataset.act in can) b.disabled = !can[b.dataset.act];
  }
}

const actions = {
  add: () => call('window', 'add'),
  batch: () => call('window', 'batch'),
  grabber: () => call('window', 'grabber'),
  resume: () => call('resume', sel()),
  stop: () => call('pause', sel()),
  stopAll: () => call('stopAll'),
  pauseAll: () => call('pauseAll'),
  remove: () => removeSelected(),
  removeDone: async () => {
    const ok = await confirmBox({ title: t('confirm.removeDoneTitle'), text: t('confirm.removeDone'), yes: t('tb.removeDone') });
    if (ok) call('removeCompleted');
  },
  options: (tab) => call('window', 'options', tab ? { tab } : {}),
  scheduler: () => call('window', 'scheduler'),
  startQueue: () => call('startQueue', 'main'),
  stopQueue: () => call('stopQueue', 'main'),
  startQueueMenu: (anchor) => queuePicker(anchor, 'startQueue'),
  stopQueueMenu: (anchor) => queuePicker(anchor, 'stopQueue'),
  open: () => { const [i] = selItems(); if (i) call('open', i.id); },
  openFolder: () => { const [i] = selItems(); if (i) call('openFolder', i.id); },
  properties: () => { const [i] = selItems(); if (i) call('window', 'properties', { id: i.id }); },
  redownload: () => call('redownload', sel()),
  copyUrl: () => call('copyText', selItems().map(i => i.url).join('\r\n')),
  find: () => { $('search').focus(); $('search').select(); },
  findNext: () => {
    if (!S.order.length) return;
    const cur = S.order.indexOf(S.anchor);
    selectOnly(S.order[(cur + 1) % S.order.length]);
    rows.get(S.anchor)?.scrollIntoView({ block: 'nearest' });
  },
  exportList: async () => { const n = await call('exportList'); if (n) confirmBox({ title: t('menu.export'), text: t('confirm.exported', { n }), yes: t('common.ok'), noCancel: true }); },
  importList: async () => { const n = await call('importList'); if (n != null) confirmBox({ title: t('menu.import'), text: t('confirm.imported', { n }), yes: t('common.ok'), noCancel: true }); },
  exit: () => call('quit'),
  toggleLimiter: () => call('settings', { speedLimit: { enabled: !S.settings.speedLimit.enabled } }),
  about: () => call('window', 'about'),
  help: () => call('external', 'help'),
  issues: () => call('external', 'issues'),
  updates: async () => {
    const r = await call('checkUpdates');
    const text = r?.status === 'newer' ? t('update.newer', { v: r.latest }) : r?.status === 'current' ? t('update.current') : t('update.unknown');
    const go = await confirmBox({ title: t('menu.updates'), text, yes: r?.status === 'newer' ? t('update.download') : t('common.ok'), noCancel: r?.status !== 'newer' });
    if (go && r?.status === 'newer') call('external', 'releases');
  }
};

function queuePicker(anchor, action) {
  const r = anchor.getBoundingClientRect();
  showMenu(S.settings.queues.map(q => ({
    label: queueName(q), icon: 'queue',
    disabled: action === 'startQueue' ? S.running.has(q.id) : !S.running.has(q.id),
    action: () => call(action, q.id)
  })), r.left, r.bottom + 2);
}

async function removeSelected() {
  const items = selItems();
  if (!items.length) return;
  const anyDone = items.some(i => i.status === 'done');
  const text = items.length === 1 ? t('confirm.removeOne', { name: items[0].filename }) : t('confirm.removeMany', { n: items.length });
  const r = await confirmBox({ title: t('confirm.removeTitle'), text, yes: t('tb.remove'), check: anyDone ? t('confirm.deleteFiles') : null });
  if (r) call('remove', items.map(i => i.id), { deleteFile: r === 'checked' });
}

function itemMenu() {
  const items = selItems();
  const one = items.length === 1 ? items[0] : null;
  const queues = S.settings.queues;
  return [
    { label: t('menu.open'), icon: 'file', disabled: !(one && one.status === 'done'), action: actions.open },
    { label: t('menu.openFolder'), icon: 'folderOpen', disabled: !(one && (one.dest || one.dir)), action: actions.openFolder },
    '-',
    { label: t('menu.resume'), icon: 'resume', disabled: !items.some(i => !['done', 'downloading', 'starting'].includes(i.status)), action: actions.resume },
    { label: t('menu.stop'), icon: 'stop', disabled: !items.some(i => ACTIVE.has(i.status) || i.status === 'queued'), action: actions.stop },
    { label: t('menu.redownload'), icon: 'refresh', disabled: !items.length, action: actions.redownload },
    '-',
    { label: t('menu.moveToQueue'), icon: 'queues', disabled: !items.some(i => i.status !== 'done'), submenu: [
      ...queues.map(q => ({ label: queueName(q), checked: one?.queueId === q.id, action: () => call('setQueue', sel(), q.id) })),
      '-',
      { label: t('menu.removeFromQueue'), action: () => call('setQueue', sel(), null) }
    ] },
    { label: t('menu.copyUrl'), icon: 'copy', disabled: !items.length, action: actions.copyUrl },
    { label: t('menu.remove'), icon: 'remove', key: 'Del', disabled: !items.length, action: actions.remove },
    '-',
    { label: t('menu.properties'), icon: 'info', key: 'Alt+Enter', disabled: !one, action: actions.properties }
  ];
}

// ---------- menu bar ----------

function menus() {
  const s = S.settings;
  const items = selItems();
  const queues = s.queues;
  return {
    tasks: [
      { label: t('menu.addUrl'), icon: 'add', key: 'Ctrl+N', action: actions.add },
      { label: t('menu.batch'), icon: 'batch', key: 'Ctrl+B', action: actions.batch },
      { label: t('menu.grabber'), icon: 'grabber', key: 'Ctrl+G', action: actions.grabber },
      '-',
      { label: t('menu.import'), icon: 'download', action: actions.importList },
      { label: t('menu.export'), icon: 'save', action: actions.exportList },
      '-',
      { label: t('menu.exit'), icon: 'exit', action: actions.exit }
    ],
    file: [
      { label: t('menu.resume'), icon: 'resume', disabled: !items.length, action: actions.resume },
      { label: t('menu.stop'), icon: 'stop', disabled: !items.length, action: actions.stop },
      { label: t('menu.redownload'), icon: 'refresh', disabled: !items.length, action: actions.redownload },
      { label: t('menu.remove'), icon: 'remove', key: 'Del', disabled: !items.length, action: actions.remove },
      '-',
      { label: t('menu.open'), icon: 'file', disabled: !(items.length === 1 && items[0].status === 'done'), action: actions.open },
      { label: t('menu.openFolder'), icon: 'folderOpen', disabled: items.length !== 1, action: actions.openFolder },
      { label: t('menu.copyUrl'), icon: 'copy', disabled: !items.length, action: actions.copyUrl },
      '-',
      { label: t('menu.properties'), icon: 'info', key: 'Alt+Enter', disabled: items.length !== 1, action: actions.properties }
    ],
    downloads: [
      { label: t('menu.pauseAll'), icon: 'pause', action: actions.pauseAll },
      { label: t('menu.stopAll'), icon: 'stopAll', action: actions.stopAll },
      '-',
      { label: t('menu.removeDone'), icon: 'removeDone', action: actions.removeDone },
      '-',
      { label: t('menu.find'), icon: 'search', key: 'Ctrl+F', action: actions.find },
      { label: t('menu.findNext'), key: 'F3', action: actions.findNext },
      '-',
      { label: t('menu.scheduler'), icon: 'scheduler', action: actions.scheduler },
      { label: t('menu.startQueue'), icon: 'startQueue', submenu: queues.map(q => ({ label: queueName(q), disabled: S.running.has(q.id), action: () => call('startQueue', q.id) })) },
      { label: t('menu.stopQueue'), icon: 'stopQueue', submenu: queues.map(q => ({ label: queueName(q), disabled: !S.running.has(q.id), action: () => call('stopQueue', q.id) })) },
      '-',
      { label: t('menu.speedLimiter'), icon: 'limiter', submenu: [
        { label: t('menu.limiterOn'), checked: s.speedLimit.enabled, action: () => call('settings', { speedLimit: { enabled: true } }) },
        { label: t('menu.limiterOff'), checked: !s.speedLimit.enabled, action: () => call('settings', { speedLimit: { enabled: false } }) },
        '-',
        { label: t('menu.limiterSettings'), action: () => actions.options('connection') }
      ] },
      { label: t('menu.options'), icon: 'options', action: () => actions.options() }
    ],
    view: [
      { label: t('menu.hideCategories'), checked: s.ui.hideCategories, action: () => call('settings', { ui: { hideCategories: !s.ui.hideCategories } }) },
      { label: t('menu.arrangeBy'), submenu: ['addedAt', 'name', 'size', 'status', 'lastTry', 'description', 'category'].map(k => ({
        label: t(`sort.${k}`), checked: s.ui.sortBy === k, action: () => call('settings', { ui: { sortBy: k } })
      })).concat(['-', { label: t('sort.asc'), checked: s.ui.sortDir === 'asc', action: () => call('settings', { ui: { sortDir: 'asc' } }) },
        { label: t('sort.desc'), checked: s.ui.sortDir === 'desc', action: () => call('settings', { ui: { sortDir: 'desc' } }) }]) },
      { label: t('menu.toolbar'), submenu: ['large', 'small', 'hidden'].map(k => ({ label: t(`toolbar.${k}`), checked: s.ui.toolbar === k, action: () => call('settings', { ui: { toolbar: k } }) })) },
      { label: t('menu.columns'), submenu: columnsMenu() },
      { label: t('menu.trayIcon'), submenu: [
        { label: t('menu.closeToTray'), checked: s.ui.closeToTray, action: () => call('settings', { ui: { closeToTray: !s.ui.closeToTray } }) }
      ] },
      '-',
      { label: t('menu.theme'), icon: 'moon', submenu: ['system', 'light', 'dark'].map(k => ({ label: t(`theme.${k}`), checked: s.ui.theme === k, action: () => call('settings', { ui: { theme: k } }) })) },
      { label: t('menu.font'), submenu: [[12, 'font.small'], [13, 'font.normal'], [15, 'font.large'], [17, 'font.larger']].map(([n, k]) => ({ label: t(k), checked: s.ui.fontSize === n, action: () => call('settings', { ui: { fontSize: n } }) })) },
      { label: t('menu.language'), icon: 'globe', submenu: [['auto', 'lang.auto'], ['en', 'lang.en'], ['pt-BR', 'lang.ptBR']].map(([v, k]) => ({ label: t(k), checked: s.language === v, action: () => call('settings', { language: v }) })) }
    ],
    help: [
      { label: t('menu.helpContents'), icon: 'help', key: 'F1', action: actions.help },
      { label: t('menu.reportProblem'), icon: 'external', action: actions.issues },
      '-',
      { label: t('menu.updates'), icon: 'refresh', action: actions.updates },
      '-',
      { label: t('menu.about'), icon: 'info', action: actions.about }
    ]
  };
}

function openMenubar(btn) {
  for (const b of document.querySelectorAll('.menubar button')) b.classList.toggle('open', b === btn);
  const r = btn.getBoundingClientRect();
  showMenu(menus()[btn.dataset.menu], r.left, r.bottom + 2, {
    onClose: () => document.querySelectorAll('.menubar button.open').forEach((b) => { b.classList.remove('open'); b.blur(); })
  });
}

// ---------- confirm overlay ----------

function confirmBox({ title, text, yes, check = null, noCancel = false }) {
  return new Promise((resolve) => {
    $('cfTitle').textContent = title;
    $('cfText').textContent = text;
    $('cfYes').textContent = yes;
    $('cfNo').hidden = noCancel;
    $('cfCheckRow').hidden = !check;
    $('cfCheck').checked = false;
    $('cfCheckLabel').textContent = check || '';
    $('confirm').hidden = false;
    $('cfYes').focus();
    const done = (v) => {
      $('confirm').hidden = true;
      $('cfYes').onclick = $('cfNo').onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', onKey, true);
    $('cfYes').onclick = () => done(check && $('cfCheck').checked ? 'checked' : true);
    $('cfNo').onclick = () => done(false);
  });
}

// ---------- sounds ----------

let audioCtx = null;
function beep(kind) {
  audioCtx ||= new AudioContext();
  const notes = { complete: [660, 880], failed: [330, 220], queueStart: [523], queueEnd: [523, 659, 784] }[kind] || [600];
  notes.forEach((f, n) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const at = audioCtx.currentTime + n * 0.16;
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start(at);
    o.stop(at + 0.16);
  });
}

function playSound(p) {
  if (p.data) {
    const bytes = Uint8Array.from(atob(p.data), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: p.mime }));
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    a.play().catch(() => beep('complete'));
  } else {
    beep(p.beep);
  }
}

// ---------- layout preferences ----------

function applyLayout() {
  const ui = S.settings.ui;
  document.body.classList.toggle('no-side', ui.hideCategories);
  document.body.classList.toggle('tb-small', ui.toolbar === 'small');
  document.body.classList.toggle('tb-hidden', ui.toolbar === 'hidden');
  const w = Number(localStorage.getItem('sideWidth')) || 230;
  document.documentElement.style.setProperty('--side-w', `${w}px`);
}

function setupSplitter() {
  $('splitter').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      const w = Math.max(160, Math.min(420, ev.clientX));
      document.documentElement.style.setProperty('--side-w', `${w}px`);
      try { localStorage.setItem('sideWidth', String(w)); } catch { /* ignore */ }
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

// ---------- keyboard ----------

function onKey(e) {
  if (!$('confirm').hidden || document.querySelector('.menu')) return;
  const inInput = e.target.matches('input, textarea, select');
  const k = e.key;
  if (e.ctrlKey && k.toLowerCase() === 'n') { e.preventDefault(); actions.add(); }
  else if (e.ctrlKey && k.toLowerCase() === 'b') { e.preventDefault(); actions.batch(); }
  else if (e.ctrlKey && k.toLowerCase() === 'g') { e.preventDefault(); actions.grabber(); }
  else if (e.ctrlKey && k.toLowerCase() === 'f') { e.preventDefault(); actions.find(); }
  else if (k === 'F3') { e.preventDefault(); actions.findNext(); }
  else if (k === 'F1') { e.preventDefault(); actions.help(); }
  else if (inInput) { if (k === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); $('list').focus(); } }
  else if (e.ctrlKey && k.toLowerCase() === 'a') { e.preventDefault(); S.selected = new Set(S.order); paintSelection(); }
  else if (k === 'Delete') { e.preventDefault(); actions.remove(); }
  else if (k === 'Enter' && e.altKey) { e.preventDefault(); actions.properties(); }
  else if (k === 'Enter') { const [i] = selItems(); if (i) call('showDownload', i.id); }
  else if (k === 'ArrowDown') { e.preventDefault(); moveSelection(1, e.shiftKey); }
  else if (k === 'ArrowUp') { e.preventDefault(); moveSelection(-1, e.shiftKey); }
}

// ---------- start ----------

async function main() {
  const state = await boot();
  S.settings = state.settings;
  S.bridge = state.bridge;
  S.extensionId = state.extensionId;
  S.running = new Set(state.queues);
  for (const i of state.items) S.items.set(i.id, i);
  applyLayout();
  renderHeader();
  scheduleRender();
  setupSplitter();

  for (const b of document.querySelectorAll('.menubar button')) {
    b.addEventListener('click', () => (b.classList.contains('open') ? closeMenus() : openMenubar(b)));
    b.addEventListener('mouseenter', () => { if (document.querySelector('.menubar button.open') && !b.classList.contains('open')) openMenubar(b); });
  }
  for (const b of document.querySelectorAll('[data-act]')) {
    b.addEventListener('click', () => actions[b.dataset.act]?.(b));
  }
  $('hideSide').addEventListener('click', () => call('settings', { ui: { hideCategories: true } }));
  $('search').addEventListener('input', (e) => { S.search = e.target.value.trim(); scheduleRender(); });
  $('stLimiter').addEventListener('click', actions.toggleLimiter);
  $('stBridge').addEventListener('click', () => actions.options('general'));
  $('list').addEventListener('mousedown', (e) => { if (!e.target.closest('.row') && !e.target.closest('.thead')) { S.selected.clear(); paintSelection(); } });
  document.addEventListener('keydown', onKey);

  mdm.on('item', (item) => {
    const prev = S.items.get(item.id);
    S.items.set(item.id, item);
    // Structure changes (new item, status, category, queue) need a full re-render.
    const structural = !prev || prev.status !== item.status || prev.category !== item.category || prev.queueId !== item.queueId || prev.filename !== item.filename;
    if (structural || !updateRow(item)) scheduleRender();
    else { renderStatusThrottled(); }
  });
  mdm.on('remove', ({ id }) => { S.items.delete(id); S.selected.delete(id); scheduleRender(); });
  mdm.on('queues', (list) => { S.running = new Set(list); scheduleRender(); });
  mdm.on('settings', (s) => {
    const headerChanged = JSON.stringify([s.ui.columns, s.ui.sortBy, s.ui.sortDir]) !== JSON.stringify([S.settings.ui.columns, S.settings.ui.sortBy, S.settings.ui.sortDir]);
    S.settings = s;
    applyLayout();
    if (headerChanged) { rows.clear(); renderHeader(); }
    scheduleRender();
  });
  mdm.on('bridge', (b) => { S.bridge = b; renderStatus(); });
  mdm.on('sound', playSound);
  document.addEventListener('i18n', () => { rows.clear(); renderHeader(); scheduleRender(); });
  setInterval(async () => { S.bridge = await mdm.invoke('bridge'); renderStatus(); }, 15_000);
}

let statusTimer = null;
function renderStatusThrottled() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = null; renderStatus(); updateToolbar(); }, 250);
}

main();
