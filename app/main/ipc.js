'use strict';

// Everything a window can ask the program to do. Calls arrive as
// idm.invoke(name, ...args) through the 'idm' channel, only from our own
// app://mini-idm pages.

const { app, ipcMain, dialog, shell, clipboard, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const windows = require('./windows');
const i18n = require('./i18n');
const { expand } = require('../engine/batch');
const { grab } = require('../engine/grabber');
const { fetchPage } = require('../engine/downloader');
const { credentialsFor } = require('../engine/rules');
const { EXTENSION_ID } = require('../engine/config');

const REPO = 'newroidorder/mini-idm';
const LINKS = {
  home: `https://github.com/${REPO}`,
  help: `https://github.com/${REPO}#readme`,
  issues: `https://github.com/${REPO}/issues`,
  releases: `https://github.com/${REPO}/releases`
};

function existingAncestor(dir) {
  let d = dir ? path.resolve(dir) : '';
  while (d && !fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return d || undefined;
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function registerIpc(ctx, { handleResult, openDownload, playSound, quitApp, extensionDir, applyProxy }) {
  const grabs = new Map(); // webContents id -> AbortController

  const handlers = {
    state: () => ({
      items: ctx.manager.list(),
      settings: ctx.settings.get(),
      queues: [...ctx.manager.runningQueues],
      lang: ctx.lang,
      dict: i18n.dict(ctx.lang),
      version: app.getVersion(),
      bridge: ctx.bridgeState,
      extensionId: EXTENSION_ID,
      platform: process.platform,
      defaultsBase: ctx.settings.baseDir
    }),
    item: (_e, id) => ctx.manager.get(id),
    bridge: () => ctx.bridgeState,
    clipboardUrl: () => { const v = String(clipboard.readText() || '').trim(); return /^https?:\/\/\S+$/i.test(v) && v.length < 4000 ? v : ''; },

    // Add URL window and other manual adds.
    add: (_e, o = {}) => {
      const headers = {};
      if (o.user) headers.Authorization = 'Basic ' + Buffer.from(`${o.user}:${o.pass || ''}`).toString('base64');
      const request = {
        url: String(o.url || '').trim(), filename: o.filename || null, description: o.description,
        headers, interactive: o.interactive !== false, kind: 'manual', start: o.start !== false, queueId: o.queueId
      };
      const result = ctx.manager.add(request);
      handleResult(result, request);
      return { id: result.item?.id || null, duplicate: !!result.duplicate };
    },
    // Batch, grabber and import: many links at once, no dialogs.
    addMany: (_e, urls = [], o = {}) => {
      let n = 0;
      for (const url of urls.slice(0, 10_000)) {
        try {
          const r = ctx.manager.add({ url, kind: 'manual', start: o.start !== false, queueId: o.queueId, duplicate: 'number', dir: o.dir || undefined });
          if (r.item) n++;
        } catch { /* skip bad lines */ }
      }
      return n;
    },
    confirm: (_e, id, data) => ctx.manager.confirm(id, data),
    pause: (_e, ids) => ids.forEach(id => ctx.manager.pause(id)),
    resume: (_e, ids) => ids.forEach(id => ctx.manager.resume(id)),
    cancel: async (_e, ids) => { for (const id of ids) await ctx.manager.cancel(id); },
    redownload: async (_e, ids) => { for (const id of ids) await ctx.manager.redownload(id); },
    remove: async (_e, ids, o = {}) => { for (const id of ids) await ctx.manager.remove(id, o); },
    removeCompleted: () => ctx.manager.removeCompleted(),
    pauseAll: () => ctx.manager.list().filter(i => i.status === 'downloading' || i.status === 'starting').forEach(i => ctx.manager.pause(i.id)),
    stopAll: () => ctx.manager.stopAll(),
    edit: (_e, id, patch) => ctx.manager.edit(id, patch),
    open: (_e, id) => {
      const i = ctx.manager.get(id);
      if (i?.status === 'done' && i.dest && fs.existsSync(i.dest)) return shell.openPath(i.dest);
      return 'missing';
    },
    openFolder: (_e, id) => {
      const i = ctx.manager.get(id);
      if (i?.dest && fs.existsSync(i.dest)) shell.showItemInFolder(i.dest);
      else if (i?.dir && fs.existsSync(i.dir)) shell.openPath(i.dir);
      else return 'missing';
      return 'ok';
    },
    showDownload: (_e, id) => { openDownload(id); },

    setQueue: (_e, ids, qid) => ctx.manager.setQueue(ids, qid),
    reorderQueue: (_e, qid, ids) => ctx.manager.reorderQueue(qid, ids),
    startQueue: (_e, qid) => ctx.manager.startQueue(qid),
    stopQueue: (_e, qid) => ctx.manager.stopQueue(qid),
    deleteQueue: (_e, qid) => ctx.manager.deleteQueue(qid),

    settings: (_e, patch) => ctx.settings.update(patch),
    resetSection: (_e, section) => {
      const { defaults } = require('../engine/settings');
      const d = defaults(ctx.settings.baseDir);
      if (section === 'fileTypes.capture') return ctx.settings.update({ fileTypes: { capture: d.fileTypes.capture } });
      if (section === 'fileTypes.excludeSites') return ctx.settings.update({ fileTypes: { excludeSites: d.fileTypes.excludeSites } });
      return ctx.settings.get();
    },
    pickFolder: async (e, initial) => {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'], defaultPath: existingAncestor(initial)
      });
      return r.canceled ? null : r.filePaths[0];
    },
    pickFile: async (e, kind) => {
      const filters = kind === 'sound' ? [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'm4a'] }]
        : kind === 'program' ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'com'] }, { name: '*', extensions: ['*'] }]
        : [{ name: 'Text', extensions: ['txt'] }, { name: '*', extensions: ['*'] }];
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters });
      return r.canceled ? null : r.filePaths[0];
    },
    testSound: (_e, event) => playSound(event, true),

    exportList: async (e) => {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
        defaultPath: 'mini-idm-downloads.txt', filters: [{ name: 'Text', extensions: ['txt'] }]
      });
      if (r.canceled || !r.filePath) return 0;
      const urls = ctx.manager.list().map(i => i.url);
      await fsp.writeFile(r.filePath, urls.join('\r\n') + '\r\n');
      return urls.length;
    },
    importList: async (e) => {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt'] }, { name: '*', extensions: ['*'] }]
      });
      if (r.canceled) return 0;
      const text = await fsp.readFile(r.filePaths[0], 'utf8');
      const urls = text.split(/\r?\n/).map(l => l.trim()).filter(l => /^https?:\/\//i.test(l));
      return handlers.addMany(e, urls, { start: false, queueId: 'main' });
    },

    batchExpand: (_e, pattern, from, to, width) => expand(pattern, from, to, Number(width) || 0),

    grab: async (e, { url, depth = 1, exts = [], sameSite = true }) => {
      handlers.grabStop(e);
      const ac = new AbortController();
      grabs.set(e.sender.id, ac);
      const s = ctx.settings.value;
      const page = (u) => {
        const headers = { 'User-Agent': s.downloads.userAgent };
        const auth = credentialsFor(s.sites, u);
        if (auth) headers.Authorization = auth;
        return fetchPage(u, { headers, signal: ac.signal, route: ctx.manager.route });
      };
      try {
        return await grab(url, page, {
          depth: Math.min(3, Math.max(0, Number(depth) || 0)), exts, sameSite, signal: ac.signal,
          onPage: (u, found) => !e.sender.isDestroyed() && e.sender.send('idm:grab', { url: u, found })
        });
      } finally {
        grabs.delete(e.sender.id);
      }
    },
    grabStop: (e) => { grabs.get(e.sender.id)?.abort(); grabs.delete(e.sender.id); },

    duplicate: (_e, token, action, remember) => {
      const p = ctx.pendingDuplicates.get(token);
      ctx.pendingDuplicates.delete(token);
      if (!p || action === 'cancel') return;
      if (remember) ctx.settings.update({ downloads: { duplicate: action } });
      const result = ctx.manager.add({ ...p.request, duplicate: action });
      handleResult(result, p.request);
    },
    duplicateInfo: (_e, token) => ctx.pendingDuplicates.get(token) || null,

    window: (e, kind, params = {}) => {
      if (!windows.KINDS[kind] || kind === 'main') return;
      const key = params.id ? `${kind}:${params.id}` : kind;
      const modal = kind === 'options' || kind === 'about';
      windows.create(kind, params, { key, modal, parent: BrowserWindow.fromWebContents(e.sender) || undefined });
    },
    close: (e) => BrowserWindow.fromWebContents(e.sender)?.close(),
    fit: (e, height) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w || w.isMaximized()) return;
      const [width] = w.getContentSize();
      w.setContentSize(width, Math.round(Math.min(Math.max(Number(height) || 0, 160), 900)));
    },
    minimize: (e) => BrowserWindow.fromWebContents(e.sender)?.minimize(),
    quit: () => quitApp(),
    external: (_e, which) => { if (LINKS[which]) shell.openExternal(LINKS[which]); },
    extensionFolder: () => shell.openPath(extensionDir()),
    extensionPath: () => extensionDir(),
    copyText: (_e, text) => clipboard.writeText(String(text).slice(0, 10_000)),
    proxyTest: () => applyProxy(),

    checkUpdates: async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
        if (!r.ok) return { status: 'unknown' };
        const rel = await r.json();
        const newer = compareVersions(rel.tag_name, app.getVersion()) > 0;
        return { status: newer ? 'newer' : 'current', latest: String(rel.tag_name).replace(/^v/, '') };
      } catch {
        return { status: 'unknown' };
      }
    }
  };

  ipcMain.handle('idm', async (e, name, ...args) => {
    if (!e.senderFrame || !e.senderFrame.url.startsWith('app://mini-idm/')) throw new Error('not allowed');
    const fn = handlers[name];
    if (!fn) throw new Error(`unknown action ${name}`);
    return fn(e, ...args);
  });
}

module.exports = { registerIpc, compareVersions };
