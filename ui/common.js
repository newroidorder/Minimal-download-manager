// Shared helpers for every window: translation, icons, formatting, menus.
// Anything that comes from a web page or server (names, URLs) is rendered
// with textContent only.

import { ICONS } from './icons.js';

export const mdm = window.mdm;
let DICT = {};
export let LANG = 'en';

export function t(key, vars = {}) {
  const s = DICT[key] ?? key;
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

export function setDict(lang, dict) {
  LANG = lang;
  DICT = dict || {};
  document.documentElement.lang = lang;
}

export function applyI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  if (document.body.dataset.title) document.title = t(document.body.dataset.title);
}

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll('[data-icon]')) {
    if (n.querySelector(':scope > svg.i')) continue;
    n.insertAdjacentHTML('afterbegin', icon(n.dataset.icon));
  }
}

// el('div', { class: 'x', onclick: fn }, 'text', otherNode)
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v; // only for our own static markup (icons)
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
}

export function fmtBytes(n, digits = 1) {
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(LANG, { maximumFractionDigits: i ? digits : 0, minimumFractionDigits: i ? digits : 0 })} ${units[i]}`;
}

export const fmtSpeed = (n) => (n ? `${fmtBytes(n)}/s` : '');

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 1) return t('time.lessThanSecond');
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  if (h) return t('time.hm', { h, m });
  if (m) return t('time.ms', { m, s });
  return t('time.s', { s });
}

export function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(LANG, { dateStyle: 'short', timeStyle: 'short' });
}

export function catName(cat) {
  if (!cat) return '';
  return cat.name || t(`cat.${cat.id}`);
}

export function queueName(q) {
  if (!q) return '';
  return q.id === 'main' && !q.name ? t('queue.main') : q.name;
}

export function statusText(item, queues = []) {
  switch (item.status) {
    case 'downloading': return item.size ? `${item.progress || 0}%` : fmtBytes(item.received) || t('status.downloading');
    case 'queued': return item.queueId ? t('status.queuedShort') : t('status.waiting');
    case 'error': return item.retries || item.error ? t('status.errorRetry') : t('status.error');
    default: return t(`status.${item.status}`);
  }
}

export function timeLeft(item) {
  if (item.status !== 'downloading' || !item.speed || !item.size) return '';
  return fmtTime((item.size - item.received) / item.speed);
}

const BADGE = {
  compressed: '#c98a10', documents: '#c4382e', music: '#8a4fd6', programs: '#4c5d73',
  video: '#d43f7a', general: '#6f7782'
};

// A small document shape with a colored band and the file extension.
export function fileBadge(filename, category = 'general') {
  const m = /\.([a-z0-9]{1,5})$/i.exec(filename || '');
  const ext = m ? m[1].toUpperCase().slice(0, 4) : '';
  const color = BADGE[category] || BADGE.general;
  const size = ext.length > 3 ? 6.2 : 7;
  return `<svg class="ficon" viewBox="0 0 22 26" aria-hidden="true">
    <path d="M3 1.5h11l5.5 5.5v16.5a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5v-20.5A1.5 1.5 0 0 1 3 1.5z" fill="var(--surface)" stroke="var(--border-strong)"/>
    <path d="M14 1.5v4a1.5 1.5 0 0 0 1.5 1.5h4" fill="none" stroke="var(--border-strong)"/>
    <rect x="0" y="13" width="18" height="9" rx="2" fill="${color}"/>
    <text x="9" y="20" text-anchor="middle" font-size="${size}" font-weight="700" fill="#fff" font-family="Segoe UI, system-ui, sans-serif">${ext}</text>
  </svg>`;
}

export function applyFont(settings) {
  document.documentElement.style.setProperty('--fs', `${settings?.ui?.fontSize || 13}px`);
}

// Loads state, translation and icons. Every window starts with this.
export async function boot() {
  const state = await mdm.invoke('state');
  setDict(state.lang, state.dict);
  applyFont(state.settings);
  applyI18n();
  hydrateIcons();
  mdm.on('i18n', ({ lang, dict }) => { setDict(lang, dict); applyI18n(); document.dispatchEvent(new Event('i18n')); });
  mdm.on('settings', (s) => applyFont(s));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('dialog') && !document.querySelector('.menu')) mdm.invoke('close');
  });
  return state;
}

export function showError(target, err) {
  const msg = String(err?.message || err).replace(/^Error invoking remote method 'mdm': (Error: )?/, '');
  if (target) { target.textContent = msg; target.hidden = false; }
  fitWindow();
  return msg;
}

// Dialogs size themselves to their content (it changes with language and font).
export function fitWindow() {
  requestAnimationFrame(() => {
    const root = document.querySelector('.view:not([hidden])') || document.body;
    const body = root.querySelector('.dlg-body');
    const foot = root.querySelector('.dlg-footer');
    if (!body) return;
    body.style.flex = 'none';
    const h = body.scrollHeight + (foot ? foot.offsetHeight : 0);
    body.style.flex = '';
    mdm.invoke('fit', h);
  });
}

// ---------- menus ----------

let openMenus = [];
let menuCloseHandler = null;

export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  if (menuCloseHandler) { const fn = menuCloseHandler; menuCloseHandler = null; fn(); }
}

/**
 * items: [{ label, icon, key, checked, radio, disabled, action, submenu: [...] } | '-']
 * Opens at (x, y) or below an anchor rect.
 */
export function showMenu(items, x, y, { onClose, level = 0 } = {}) {
  if (level === 0) { closeMenus(); menuCloseHandler = onClose || null; }
  else { for (const m of openMenus.splice(level)) m.remove(); }
  const menu = el('div', { class: 'menu', role: 'menu' });
  let sub = null;
  const rows = [];
  for (const it of items) {
    if (it === '-' || !it) { menu.append(el('div', { class: 'sep' })); continue; }
    const mark = it.checked ? icon('check') : it.icon ? icon(it.icon) : '';
    const row = el('div', { class: `mi${it.disabled ? ' disabled' : ''}`, role: 'menuitem', tabindex: -1 },
      el('span', { class: 'mark', html: mark }),
      el('span', { class: 'label', text: it.label }),
      it.key ? el('span', { class: 'key', text: it.key }) : null,
      it.submenu ? el('span', { class: 'arrow', html: icon('chevronRight') }) : null);
    const openSub = () => {
      const r = row.getBoundingClientRect();
      sub = showMenu(it.submenu, r.right - 4, r.top - 5, { level: level + 1 });
    };
    row.addEventListener('mouseenter', () => {
      rows.forEach(r => r.classList.remove('hot'));
      row.classList.add('hot');
      if (it.submenu) openSub(); else for (const m of openMenus.splice(level + 1)) m.remove();
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.submenu) return openSub();
      closeMenus();
      it.action?.();
    });
    row._item = it;
    row._openSub = openSub;
    rows.push(row);
    menu.append(row);
  }
  document.body.append(menu);
  openMenus[level] = menu;
  // keep inside the window
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - h - 4))}px`;
  menu._rows = rows;
  return menu;
}

// Keyboard support for open menus.
document.addEventListener('keydown', (e) => {
  if (!openMenus.length) return;
  const menu = openMenus[openMenus.length - 1];
  const rows = menu._rows.filter(r => !r._item.disabled);
  const cur = rows.findIndex(r => r.classList.contains('hot'));
  const hot = (i) => { rows.forEach(r => r.classList.remove('hot')); rows[(i + rows.length) % rows.length]?.classList.add('hot'); };
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (openMenus.length > 1) openMenus.pop().remove(); else closeMenus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); hot(cur + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); hot(cur < 0 ? -1 : cur - 1); }
  else if (e.key === 'ArrowRight' && cur >= 0 && rows[cur]._item.submenu) { e.preventDefault(); rows[cur]._openSub(); openMenus.at(-1)._rows[0]?.classList.add('hot'); }
  else if (e.key === 'ArrowLeft' && openMenus.length > 1) { e.preventDefault(); openMenus.pop().remove(); }
  else if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); rows[cur].click(); }
  else return;
}, true);

document.addEventListener('mousedown', (e) => {
  if (openMenus.length && !e.target.closest('.menu') && !e.target.closest('[data-menu-anchor]')) closeMenus();
});
window.addEventListener('blur', () => closeMenus());
