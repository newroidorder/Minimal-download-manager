'use strict';

// Mini IDM: the Windows program. It owns the download engine, the windows,
// the tray icon, and the local bridge the browser extension talks to.

const { app, protocol, net, Tray, Menu, nativeImage, nativeTheme, Notification, dialog, shell, session, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');

const { Settings } = require('../engine/settings');
const { Manager, BUSY } = require('../engine/manager');
const { Scheduler } = require('../engine/scheduler');
const { createBridge } = require('../engine/api');
const { createRouter } = require('../engine/proxy');
const { captureDecision } = require('../engine/rules');
const { loadConfig, EXTENSION_ID } = require('../engine/config');
const windows = require('./windows');
const system = require('./system');
const i18n = require('./i18n');
const { registerIpc } = require('./ipc');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const HIDDEN = process.argv.includes('--hidden');

if (process.env.MINI_IDM_HOME) app.setPath('userData', process.env.MINI_IDM_HOME);
app.setAppUserModelId('com.miniidm.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.on('second-instance', (_e, argv) => { handleArgs(argv); showMain(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('Mini IDM', `Mini IDM could not start:\n\n${err.stack || err}`);
    app.exit(1);
  });
}

const ctx = {
  settings: null, manager: null, scheduler: null, bridge: null, tray: null,
  t: (k) => k, lang: 'en',
  bridgeState: { listening: false, port: 0, error: null, seen: {} },
  pendingDuplicates: new Map(),
  quitting: false
};

function extensionDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(ROOT, '..', 'extension');
}

async function start() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(RENDERER, decodeURIComponent(u.pathname)));
    if (!file.startsWith(RENDERER + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  const home = app.getPath('userData');
  const base = process.env.MINI_IDM_SAVE_DIR || app.getPath('downloads');
  const settings = new Settings(path.join(home, 'settings.json'), base);
  ctx.settings = settings;
  applyLanguage();
  nativeTheme.themeSource = settings.value.ui.theme;
  await applyProxy();

  const route = createRouter(() => settings.value, (url) => session.defaultSession.resolveProxy(url));
  const manager = new Manager({ settings, stateFile: path.join(home, 'downloads.json'), route, runProgram: system.runProgram });
  ctx.manager = manager;
  ctx.scheduler = new Scheduler(settings, manager);
  ctx.scheduler.start();

  registerIpc(ctx, { handleResult, openDownload, playSound, quitApp, extensionDir, applyProxy });
  wireEvents();
  createTray();
  windows.create('main', {}, { show: !HIDDEN });
  windows.get('main').on('close', onMainClose);

  const config = loadConfig(home);
  ctx.bridge = createBridge({
    manager, settings, token: config.token, extensionIds: [EXTENSION_ID], version: app.getVersion(),
    onCapture: (result, request) => handleResult(result, request),
    onSeen: (browser) => {
      const fresh = !ctx.bridgeState.seen[browser] || Date.now() - ctx.bridgeState.seen[browser] > 60_000;
      ctx.bridgeState.seen[browser] = Date.now();
      if (fresh) windows.broadcast('bridge', ctx.bridgeState); // show "Connected" right away
    }
  });
  listenBridge(config.port);

  system.watchClipboard(
    () => settings.value.general.monitorClipboard,
    (url) => captureDecision(settings.value, { url, kind: 'click' }).capture && !manager.findDuplicate(url),
    (url) => handleResult(manager.add({ url, interactive: true, kind: 'clipboard' }))
  );
  syncAutostart();
  if (app.isPackaged) app.setAsDefaultProtocolClient('miniidm');
  handleArgs(process.argv);
  setInterval(keepAwake, 5000).unref?.();
}

function listenBridge(port) {
  ctx.bridge.listen(port).then((p) => {
    Object.assign(ctx.bridgeState, { listening: true, port: p, error: null });
    windows.broadcast('bridge', ctx.bridgeState);
  }, (err) => {
    const inUse = err.code === 'EADDRINUSE';
    Object.assign(ctx.bridgeState, { listening: false, port, error: inUse ? 'in-use' : err.message });
    windows.broadcast('bridge', ctx.bridgeState);
    if (inUse && !ctx.bridgeState.warned) {
      ctx.bridgeState.warned = true;
      notify(ctx.t('notify.portBusyTitle'), ctx.t('notify.portBusy', { port }));
    }
    setTimeout(() => listenBridge(port), 10_000).unref?.();
  });
}

// ---------- results of adding a download ----------

function openDownload(id) {
  return windows.create('download', { id }, { key: `dl:${id}`, onTop: true });
}

function handleResult(result, request = {}) {
  const s = ctx.settings.value;
  if (result.duplicate) {
    const token = randomUUID();
    ctx.pendingDuplicates.set(token, { request, existing: result.duplicate });
    windows.create('duplicate', { token }, { key: `dup:${token}`, onTop: true });
    return;
  }
  const item = result.item;
  if (!item) return;
  if (result.existing) {
    if (item.status === 'done' ? s.downloads.showComplete : s.downloads.showProgress) openDownload(item.id);
    return;
  }
  if (item.status === 'pending' || (s.downloads.showProgress && !item.queueId)) openDownload(item.id);
}

// ---------- events ----------

function wireEvents() {
  const { manager, settings } = ctx;
  manager.on('update', item => windows.broadcast('item', item));
  manager.on('remove', ({ id }) => windows.broadcast('remove', { id }));
  manager.on('queues', list => windows.broadcast('queues', list));
  manager.on('event', onManagerEvent);

  let last = settings.get();
  settings.onChange((v) => {
    windows.broadcast('settings', v);
    if (v.ui.theme !== last.ui.theme) { nativeTheme.themeSource = v.ui.theme; windows.retheme(); }
    if (v.language !== last.language) { applyLanguage(); windows.broadcast('i18n', { lang: ctx.lang, dict: i18n.dict(ctx.lang) }); createTray(); }
    if (JSON.stringify(v.proxy) !== JSON.stringify(last.proxy)) applyProxy();
    if (v.general.startWithWindows !== last.general.startWithWindows) syncAutostart();
    if (v.speedLimit.enabled !== last.speedLimit.enabled) createTray();
    last = v;
  });
  nativeTheme.on('updated', () => windows.retheme());
}

function onManagerEvent(e) {
  const s = ctx.settings.value;
  const t = ctx.t;
  if (e.type === 'complete') {
    playSound('complete');
    if (s.downloads.showComplete) openDownload(e.item.id);
    else notify(t('notify.completeTitle'), e.item.filename, () => shell.showItemInFolder(e.item.dest));
  } else if (e.type === 'failed') {
    playSound('failed');
    if (!windows.get(`dl:${e.item.id}`)) notify(t('notify.failedTitle'), `${e.item.filename}: ${e.item.error}`, showMain);
  } else if (e.type === 'queueStart') {
    playSound('queueStart');
  } else if (e.type === 'queueEnd') {
    playSound('queueEnd');
    afterQueue(e.afterFinish, queueName(e.queue));
  } else if (e.type === 'quota') {
    notify(t('notify.quotaTitle'), t('notify.quota', { time: new Date(e.until).toLocaleTimeString(ctx.lang) }));
  } else if (e.type === 'quotaWarning') {
    notify(t('notify.quotaTitle'), t('notify.quotaWarning', { mb: e.mb, hours: e.hours }));
  }
}

function queueName(q) {
  if (!q) return '';
  return q.id === 'main' && !q.name ? ctx.t('queue.main') : q.name;
}

async function afterQueue(action, name) {
  const t = ctx.t;
  if (action === 'exit') {
    notify(t('notify.queueEndTitle'), t('notify.queueEndExit', { name }));
    setTimeout(quitApp, 5000);
  } else if (action === 'shutdown') {
    system.shutdown(t('notify.shutdownMessage', { name }));
    const r = await dialog.showMessageBox({
      type: 'warning', title: 'Mini IDM', message: t('notify.shutdownTitle'), detail: t('notify.shutdownDetail', { name }),
      buttons: [t('notify.cancelShutdown'), t('common.ok')], defaultId: 0, cancelId: 0
    });
    if (r.response === 0) system.cancelShutdown();
  } else if (action === 'sleep') {
    notify(t('notify.queueEndTitle'), t('notify.queueEndSleep', { name }));
    setTimeout(system.sleep, 5000);
  } else {
    notify(t('notify.queueEndTitle'), t('notify.queueEnd', { name }));
  }
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(ROOT, 'build', 'icon.png'), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

// Sounds play in the main window (it exists even when hidden in the tray).
function playSound(event, force = false) {
  const s = ctx.settings.value.sounds[event];
  if (!s || (!s.enabled && !force)) return;
  const main = windows.get('main');
  if (!main) return;
  let payload = { beep: event };
  if (s.file) {
    try {
      const stat = fs.statSync(s.file);
      if (stat.size < 10 * 1024 * 1024) {
        const ext = path.extname(s.file).toLowerCase();
        const mime = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' }[ext] || 'audio/wav';
        payload = { data: fs.readFileSync(s.file).toString('base64'), mime };
      }
    } catch { /* fall back to the built-in sound */ }
  }
  main.webContents.send('idm:sound', payload);
}

// ---------- system integration ----------

function applyLanguage() {
  ctx.lang = i18n.resolve(ctx.settings.value.language, app.getPreferredSystemLanguages?.() || [app.getLocale()]);
  ctx.t = i18n.translator(ctx.lang);
}

async function applyProxy() {
  const p = ctx.settings.value.proxy;
  const config = p.mode === 'system' ? { mode: 'system' }
    : p.mode === 'pac' && p.pacUrl ? { mode: 'pac_script', pacScript: p.pacUrl }
    : { mode: 'direct' };
  await session.defaultSession.setProxy(config).catch(() => {});
}

function syncAutostart() {
  if (!app.isPackaged) return; // never register a development build
  app.setLoginItemSettings({ openAtLogin: ctx.settings.value.general.startWithWindows, args: ['--hidden'] });
}

let blocker = null;
function keepAwake() {
  const busy = ctx.manager.list().some(i => BUSY.has(i.status));
  if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!busy && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  updateTrayTooltip();
}

function handleArgs(argv) {
  const link = argv.find(a => /^miniidm:\/\//i.test(a));
  if (!link) return;
  try {
    const u = new URL(link);
    const target = u.searchParams.get('url');
    if (u.hostname === 'add' && target) handleResult(ctx.manager.add({ url: target, interactive: true, kind: 'manual' }));
    else showMain();
  } catch { showMain(); }
}

function showMain() {
  const w = windows.get('main') || windows.create('main');
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

let trayHintShown = false;
function onMainClose(e) {
  if (ctx.quitting || !ctx.settings.value.ui.closeToTray) {
    if (!ctx.quitting) { e.preventDefault(); quitApp(); }
    return;
  }
  e.preventDefault();
  windows.get('main').hide();
  if (!trayHintShown) {
    trayHintShown = true;
    notify('Mini IDM', ctx.t('notify.inTray'));
  }
}

function createTray() {
  const t = ctx.t;
  const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'tray.png'));
  if (!ctx.tray) {
    ctx.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    ctx.tray.on('double-click', showMain);
    ctx.tray.on('click', showMain);
  }
  const s = ctx.settings.value;
  ctx.tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.open'), click: showMain },
    { label: t('menu.addUrl'), click: () => windows.create('add', {}, { onTop: true }) },
    { type: 'separator' },
    { label: t('menu.speedLimiter'), type: 'checkbox', checked: s.speedLimit.enabled, click: (m) => ctx.settings.update({ speedLimit: { enabled: m.checked } }) },
    { label: t('menu.startQueue'), click: () => ctx.manager.startQueue('main') },
    { label: t('menu.stopQueue'), click: () => ctx.manager.stopQueue('main') },
    { type: 'separator' },
    { label: t('menu.exit'), click: quitApp }
  ]));
  updateTrayTooltip();
}

function updateTrayTooltip() {
  if (!ctx.tray) return;
  const active = ctx.manager ? ctx.manager.list().filter(i => i.status === 'downloading') : [];
  const speed = active.reduce((n, i) => n + (i.speed || 0), 0);
  const fmt = speed > 1048576 ? `${(speed / 1048576).toFixed(1)} MB/s` : `${Math.round(speed / 1024)} KB/s`;
  ctx.tray.setToolTip(active.length ? `Mini IDM: ${ctx.t('tray.active', { n: active.length })} · ${fmt}` : 'Mini IDM');
}

let cleaned = false;
async function quitApp() {
  if (ctx.quitting) return;
  ctx.quitting = true;
  try {
    ctx.scheduler?.stop();
    await ctx.bridge?.close();
    await ctx.manager?.close();
  } finally {
    cleaned = true;
    ctx.tray?.destroy();
    app.quit();
  }
}

app.on('before-quit', (e) => {
  if (cleaned) return;
  e.preventDefault();
  quitApp();
});
