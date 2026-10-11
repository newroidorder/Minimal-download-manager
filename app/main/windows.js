'use strict';

// Creates and tracks every window. Pages are served from app://mini-idm/ so
// they get a real origin (ES modules, strict CSP) instead of file://.

const { BrowserWindow, nativeTheme, shell } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

// width, height, resizable
const KINDS = {
  main: [1180, 720, true],
  add: [600, 330, false],
  download: [600, 540, false],
  options: [960, 700, true],
  scheduler: [920, 720, true],
  properties: [620, 600, false],
  batch: [660, 600, true],
  grabber: [980, 680, true],
  about: [480, 460, false],
  duplicate: [600, 380, false]
};

const open = new Map(); // key -> BrowserWindow

const bg = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1f' : '#f6f7f9');

function create(kind, params = {}, { key = kind, parent, modal = false, show = true, onTop = false } = {}) {
  const existing = open.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  const [width, height, resizable] = KINDS[kind];
  const isMain = kind === 'main';
  const win = new BrowserWindow({
    width, height, resizable,
    minWidth: isMain ? 780 : Math.min(width, 480),
    minHeight: isMain ? 480 : Math.min(height, 300),
    show: false,
    parent: modal ? parent : undefined,
    modal,
    minimizable: isMain || !modal,
    maximizable: resizable,
    backgroundColor: bg(),
    icon: ICON,
    autoHideMenuBar: true,
    title: 'Minimal Download Manager',
    ...(isMain ? { titleBarStyle: 'hidden', titleBarOverlay: overlay() } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: !isMain // the main window plays sounds while hidden
    }
  });
  win.setMenu(null);
  const query = new URLSearchParams(params).toString();
  win.loadURL(`app://mini-idm/${kind}.html${query ? `?${query}` : ''}`);
  win.once('ready-to-show', () => {
    if (!show) return;
    win.show();
    if (onTop) {
      // Captured from the browser: come to the front once, like IDM's dialogs.
      win.setAlwaysOnTop(true, 'floating');
      win.focus();
      setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 1500);
    }
  });
  // Pages never navigate away; links go to the default browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  open.set(key, win);
  win.on('closed', () => { if (open.get(key) === win) open.delete(key); });
  return win;
}

function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#202024' : '#ffffff', symbolColor: dark ? '#e8e8ea' : '#1f2328', height: 40 };
}

function get(key) {
  const w = open.get(key);
  return w && !w.isDestroyed() ? w : null;
}

function all() {
  return [...open.values()].filter(w => !w.isDestroyed());
}

function broadcast(event, data) {
  for (const w of all()) w.webContents.send(`idm:${event}`, data);
}

function retheme() {
  for (const w of all()) w.setBackgroundColor(bg());
  const main = get('main');
  if (main) main.setTitleBarOverlay?.(overlay());
}

module.exports = { create, get, all, broadcast, retheme, KINDS };
