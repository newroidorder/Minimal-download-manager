// Options: the same tabs as IDM (General, File types, Save to, Downloads,
// Connection, Proxy/Socks, Sites and logins, Retry, Sounds). Edits are kept
// in a working copy and saved together with OK.

import { idm, t, boot, el, catName, showError } from './common.js';

const $ = (id) => document.getElementById(id);
const BROWSERS = ['chrome', 'edge', 'opera', 'brave', 'vivaldi', 'firefox'];
const SOUNDS = ['complete', 'failed', 'queueStart', 'queueEnd'];
let S;              // working copy of the settings
let state;
let selCat = null;
let selException = -1;
let selSite = -1;

const getPath = (obj, p) => p.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, p, v) {
  const keys = p.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = v;
}

// ---------- simple bound fields ----------

function load() {
  for (const n of document.querySelectorAll('[data-path]')) {
    const v = getPath(S, n.dataset.path);
    if (n.type === 'checkbox') n.checked = !!v;
    else n.value = v ?? '';
  }
  for (const n of document.querySelectorAll('[data-list]')) {
    const v = getPath(S, n.dataset.list) || [];
    n.value = ('upper' in n.dataset ? v.map(x => x.toUpperCase()) : v).join(' ');
  }
  for (const n of document.querySelectorAll('[data-lines]')) n.value = (getPath(S, n.dataset.lines) || []).join('\n');
  const mode = document.querySelector(`input[name=proxyMode][value="${S.proxy.mode}"]`);
  if (mode) mode.checked = true;
  renderBrowsers();
  renderCats();
  renderExceptions();
  renderSites();
  renderSounds();
}

function read() {
  for (const n of document.querySelectorAll('[data-path]')) {
    let v;
    if (n.type === 'checkbox') v = n.checked;
    else if (n.type === 'number' || 'number' in n.dataset) v = Number(n.value);
    else v = n.value;
    setPath(S, n.dataset.path, v);
  }
  for (const n of document.querySelectorAll('[data-list]')) setPath(S, n.dataset.list, n.value.split(/[\s,;]+/).filter(Boolean));
  for (const n of document.querySelectorAll('[data-lines]')) setPath(S, n.dataset.lines, n.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  S.proxy.mode = document.querySelector('input[name=proxyMode]:checked')?.value || 'none';
  readCat();
}

// ---------- General: browsers and extension ----------

function renderBrowsers() {
  const seen = state.bridge?.seen || {};
  $('browsers').replaceChildren(...BROWSERS.map((b) => {
    const box = el('input', { type: 'checkbox', checked: S.general.browsers[b] !== false });
    box.addEventListener('change', () => { S.general.browsers[b] = box.checked; });
    const last = seen[b];
    const status = last ? el('span', { class: 'hint ok', text: t('opt.g.seen', { when: new Date(last).toLocaleString() }) }) : el('span', { class: 'hint', text: t('opt.g.notSeen') });
    return el('label', { class: 'check browser-row' }, box, el('span', { class: 'grow', text: t(`browser.${b}`) }), status);
  }));
  const b = state.bridge;
  $('extStatus').textContent = !b.listening && b.error === 'in-use' ? t('status.portBusy', { port: b.port })
    : Object.keys(seen).length ? t('opt.g.extOk') : t('opt.g.extWaiting');
  $('extStatus').className = `hint ${!b.listening ? 'error' : Object.keys(seen).length ? 'ok' : ''}`;
}

// ---------- Save to: categories ----------

function renderCats() {
  $('cats').replaceChildren(...S.save.categories.map((c) => {
    const tr = el('tr', { class: c.id === selCat ? 'sel' : '' },
      el('td', { text: catName(c) }),
      el('td', { class: 'ellipsis', text: c.folder, title: c.folder }),
      el('td', { class: 'ellipsis mono', text: c.id === 'general' ? t('opt.s.everythingElse') : c.exts.join(' ') }));
    tr.addEventListener('click', () => { readCat(); selCat = c.id; renderCats(); });
    return tr;
  }));
  const c = S.save.categories.find(x => x.id === selCat);
  $('catEdit').hidden = !c;
  $('catDelete').disabled = !c || isBuiltin(c);
  if (!c) return;
  $('catName').value = catName(c);
  $('catName').disabled = isBuiltin(c);
  $('catExts').value = c.id === 'general' ? t('opt.s.everythingElse') : c.exts.join(' ');
  $('catExts').disabled = c.id === 'general';
  $('catFolder').value = c.folder;
  $('catRemember').checked = c.rememberLast;
}

const isBuiltin = (c) => ['compressed', 'documents', 'music', 'programs', 'video', 'general'].includes(c.id);

function readCat() {
  const c = S.save.categories.find(x => x.id === selCat);
  if (!c || $('catEdit').hidden) return;
  if (!isBuiltin(c)) c.name = $('catName').value.trim() || c.name;
  if (c.id !== 'general') c.exts = $('catExts').value.split(/[\s,;]+/).map(x => x.replace(/^\*?\./, '').toLowerCase()).filter(Boolean);
  c.folder = $('catFolder').value.trim();
  c.rememberLast = $('catRemember').checked;
}

// ---------- Connection: per-server exceptions ----------

function renderExceptions() {
  $('exceptions').replaceChildren(...S.connection.exceptions.map((e, n) => {
    const tr = el('tr', { class: n === selException ? 'sel' : '' }, el('td', { text: e.host }), el('td', { text: String(e.max) }));
    tr.addEventListener('click', () => { selException = n; $('exHost').value = e.host; $('exMax').value = e.max; renderExceptions(); });
    return tr;
  }));
  $('exRemove').disabled = selException < 0;
}

// ---------- Sites and logins ----------

function renderSites() {
  $('sites').replaceChildren(...S.sites.map((s, n) => {
    const tr = el('tr', { class: n === selSite ? 'sel' : '' }, el('td', { class: 'ellipsis', text: s.site }), el('td', { text: s.user }), el('td', { text: s.pass ? '••••••' : '' }));
    tr.addEventListener('click', () => { selSite = n; $('siteSite').value = s.site; $('siteUser').value = s.user; $('sitePass').value = s.pass; renderSites(); });
    return tr;
  }));
  $('siteRemove').disabled = selSite < 0;
}

// ---------- Sounds ----------

function renderSounds() {
  $('sounds').replaceChildren(...SOUNDS.map((ev) => {
    const s = S.sounds[ev];
    const box = el('input', { type: 'checkbox', checked: s.enabled });
    box.addEventListener('change', () => { s.enabled = box.checked; });
    const file = el('td', { class: 'ellipsis', text: s.file || t('opt.o.builtIn'), title: s.file || '' });
    const browse = el('button', { class: 'btn small', text: t('common.browse') });
    browse.addEventListener('click', async () => { const f = await idm.invoke('pickFile', 'sound'); if (f) { s.file = f; renderSounds(); } });
    const clear = el('button', { class: 'btn small', text: t('opt.o.builtInShort'), disabled: !s.file });
    clear.addEventListener('click', () => { s.file = ''; renderSounds(); });
    const play = el('button', { class: 'btn small', text: t('opt.o.play') });
    play.addEventListener('click', async () => {
      await idm.invoke('settings', { sounds: { [ev]: { file: s.file } } }); // test what is chosen now
      idm.invoke('testSound', ev);
    });
    return el('tr', {}, el('td', {}, el('label', { class: 'check' }, box, el('span', { text: t(`opt.o.${ev}`) }))), file,
      el('td', { class: 'nowrap' }, browse, ' ', clear, ' ', play));
  }));
}

// ---------- navigation ----------

function showSection(sec) {
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.sec === sec);
  for (const s of document.querySelectorAll('section[data-sec]')) s.hidden = s.dataset.sec !== sec;
}

async function main() {
  state = await boot();
  S = structuredClone(state.settings);
  $('extPath').value = await idm.invoke('extensionPath');
  load();
  showSection(['general', 'types', 'save', 'downloads', 'connection', 'proxy', 'sites', 'retry', 'sounds'].includes(idm.params.tab) ? idm.params.tab : 'general');

  for (const b of document.querySelectorAll('#nav button')) b.addEventListener('click', () => showSection(b.dataset.sec));
  for (const b of document.querySelectorAll('[data-reset]')) {
    b.addEventListener('click', async () => {
      const fresh = await idm.invoke('resetSection', b.dataset.reset);
      setPath(S, b.dataset.reset, getPath(fresh, b.dataset.reset));
      const n = document.querySelector(`[data-list="${b.dataset.reset}"]`);
      const v = getPath(S, b.dataset.reset);
      n.value = ('upper' in n.dataset ? v.map(x => x.toUpperCase()) : v).join(' ');
    });
  }
  $('extOpen').addEventListener('click', () => idm.invoke('extensionFolder'));
  $('extCopy').addEventListener('click', () => idm.invoke('copyText', $('extPath').value));

  $('catNew').addEventListener('click', () => {
    readCat();
    const name = t('opt.s.newName');
    const id = `new-${Date.now().toString(36)}`;
    S.save.categories.splice(S.save.categories.length - 1, 0, { id, name, folder: `${state.defaultsBase}${state.platform === 'win32' ? '\\' : '/'}${name}`, exts: [], rememberLast: true, isNew: true });
    selCat = id;
    renderCats();
    $('catName').focus();
    $('catName').select();
  });
  $('catDelete').addEventListener('click', () => {
    S.save.categories = S.save.categories.filter(c => c.id !== selCat);
    selCat = null;
    renderCats();
  });
  $('catBrowse').addEventListener('click', async () => { const p = await idm.invoke('pickFolder', $('catFolder').value); if (p) $('catFolder').value = p; });
  $('avBrowse').addEventListener('click', async () => { const p = await idm.invoke('pickFile', 'program'); if (p) $('avProgram').value = p; });

  $('exAdd').addEventListener('click', () => {
    const host = $('exHost').value.trim().toLowerCase();
    if (!host) return;
    const max = Math.max(1, Math.min(32, Number($('exMax').value) || 1));
    const at = S.connection.exceptions.findIndex(e => e.host === host);
    if (at >= 0) S.connection.exceptions[at].max = max; else S.connection.exceptions.push({ host, max });
    $('exHost').value = '';
    selException = -1;
    renderExceptions();
  });
  $('exRemove').addEventListener('click', () => { S.connection.exceptions.splice(selException, 1); selException = -1; renderExceptions(); });

  $('siteAdd').addEventListener('click', () => {
    const site = $('siteSite').value.trim();
    if (!site) return;
    const entry = { site, user: $('siteUser').value, pass: $('sitePass').value };
    if (selSite >= 0) S.sites[selSite] = entry; else S.sites.push(entry);
    selSite = -1;
    $('siteSite').value = $('siteUser').value = $('sitePass').value = '';
    renderSites();
  });
  $('siteRemove').addEventListener('click', () => { S.sites.splice(selSite, 1); selSite = -1; renderSites(); });

  $('cancel').addEventListener('click', () => idm.invoke('close'));
  $('ok').addEventListener('click', async () => {
    $('error').hidden = true;
    read();
    // New categories are sent by name; the program assigns their id.
    const categories = S.save.categories.map(c => (c.isNew ? { name: c.name, folder: c.folder, exts: c.exts, rememberLast: c.rememberLast } : c));
    try {
      await idm.invoke('settings', { ...S, save: { ...S.save, categories } });
      idm.invoke('close');
    } catch (err) {
      showError($('error'), err);
      if (/folder/i.test(err.message)) showSection('save');
    }
  });
  idm.on('bridge', (b) => { state.bridge = b; renderBrowsers(); });
}

main();
