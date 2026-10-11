'use strict';

// Download queue: limits concurrency, tracks state, persists to disk.
// Request headers (cookies) are kept in memory only and never written to disk.
//
// Statuses: pending (waiting for the "Download File Info" dialog), queued,
// starting, downloading, paused, done, error, cancelled.

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { download, inspect, filenameFromUrl, sanitize } = require('./downloader');
const { Settings } = require('./settings');

const ACTIVE = new Set(['starting', 'downloading']);

class Queue extends EventEmitter {
  constructor({ saveDir, stateFile, settings, downloadOptions = {} }) {
    super();
    this.saveDir = saveDir;
    this.stateFile = stateFile;
    this.settings = settings || new Settings(null, saveDir);
    this.downloadOptions = downloadOptions;
    this.items = new Map();
    this.secrets = new Map();      // id -> request headers
    this.controllers = new Map();  // id -> AbortController
    this.persistTimer = null;
    fs.mkdirSync(saveDir, { recursive: true });
    this.load();
  }

  load() {
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return; }
    for (const item of saved) {
      // Interrupted by a restart: hold it so the user can resume. The headers are gone.
      if (ACTIVE.has(item.status)) Object.assign(item, { status: 'paused', speed: 0, connections: 0 });
      item.inspecting = false;
      this.items.set(item.id, item);
    }
    setImmediate(() => this.pump());
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id) {
    return this.items.get(id);
  }

  // interactive: added from the browser or UI, so the "Download File Info"
  // dialog is shown first when that setting is on.
  add({ url, filename, headers, interactive = false }) {
    const u = new URL(url); // throws on garbage
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https URLs are supported');
    const ask = interactive && this.settings.get().askWhereToSave;
    const id = randomUUID();
    const name = filename ? sanitize(filename) : (filenameFromUrl(u.href) || u.hostname);
    const item = {
      id,
      url: u.href,
      requestedName: filename ? sanitize(filename) : null,
      filename: name,
      category: this.settings.categorize(name).id,
      dir: null,
      dest: null,
      mime: '',
      status: ask ? 'pending' : 'queued',
      inspecting: ask,
      inspectError: null,
      size: 0,
      received: 0,
      progress: 0,
      speed: 0,
      connections: 0,
      error: null,
      addedAt: Date.now(),
      finishedAt: null
    };
    this.items.set(id, item);
    if (headers && Object.keys(headers).length) this.secrets.set(id, headers);
    this.emit('update', { ...item });
    this.persist();
    if (ask) this.inspectItem(item);
    else this.pump();
    return { ...item };
  }

  // Fills in name, size, type, category and folder for the dialog.
  async inspectItem(item) {
    const patch = { inspecting: false };
    try {
      const info = await inspect(item.url, { headers: this.secrets.get(item.id) });
      Object.assign(patch, { size: info.size, mime: info.mime });
      if (!item.requestedName) patch.filename = info.filename;
    } catch (err) {
      patch.inspectError = err.message;
    }
    const cat = this.settings.categorize(patch.filename || item.filename, patch.mime || item.mime);
    if (!this.items.has(item.id) || item.status !== 'pending') return;
    this.update(item, { ...patch, category: cat.id, dir: item.dir || cat.folder });
  }

  // The user's answer to the dialog: name, folder, and start now or later.
  confirm(id, { filename, dir, category, start = true } = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.status !== 'pending') throw Object.assign(new Error('download is not waiting for confirmation'), { status: 409 });
    if (typeof dir !== 'string' || !path.isAbsolute(dir.trim())) throw Object.assign(new Error('choose a full folder path'), { status: 400 });
    const patch = { dir: path.normalize(dir.trim()), status: start ? 'queued' : 'paused', inspecting: false };
    if (typeof filename === 'string' && filename.trim()) {
      patch.requestedName = sanitize(filename.trim());
      patch.filename = patch.requestedName;
    }
    if (typeof category === 'string' && this.settings.get().categories.some(c => c.id === category)) patch.category = category;
    this.update(item, patch);
    this.pump();
    return { ...item };
  }

  update(item, patch, persist = true) {
    Object.assign(item, patch);
    this.emit('update', { ...item });
    if (persist) this.persist();
  }

  activeCount() {
    return [...this.items.values()].filter(i => ACTIVE.has(i.status)).length;
  }

  pump() {
    const queued = [...this.items.values()].filter(i => i.status === 'queued').sort((a, b) => a.addedAt - b.addedAt);
    let free = this.settings.get().maxActive - this.activeCount();
    for (const item of queued) {
      if (free-- <= 0) break;
      this.run(item);
    }
  }

  async run(item) {
    const ac = new AbortController();
    this.controllers.set(item.id, ac);
    this.update(item, { status: 'starting', error: null, speed: 0 });
    try {
      const result = await download(
        { url: item.url, filename: item.requestedName, headers: this.secrets.get(item.id), dir: item.dir, dest: item.dest },
        {
          maxConnections: this.settings.get().maxConnections,
          ...this.downloadOptions,
          saveDir: this.saveDir,
          resolveDir: (name, mime) => this.settings.categorize(name, mime).folder,
          signal: ac.signal,
          onProgress: (p) => {
            const first = item.dest !== p.dest;
            const patch = { status: 'downloading', ...p };
            if (first) {
              patch.dir = path.dirname(p.dest);
              patch.category = item.dir ? item.category : this.settings.categorize(p.filename).id;
            }
            this.update(item, patch, first);
          }
        }
      );
      if (result.status === 'done') {
        this.update(item, {
          status: 'done', dest: result.dest, filename: path.basename(result.dest),
          size: result.size, received: result.size, progress: 100, speed: 0, connections: 0,
          finishedAt: Date.now()
        });
        this.secrets.delete(item.id);
      } else if (result.status === 'paused') {
        this.update(item, { status: 'paused', dest: result.dest, speed: 0, connections: 0 });
      } else {
        this.update(item, { status: 'cancelled', dest: null, speed: 0, connections: 0, progress: 0, received: 0 });
        this.secrets.delete(item.id);
      }
    } catch (err) {
      this.update(item, { status: 'error', error: err.message, dest: err.dest || null, speed: 0, connections: 0 });
    } finally {
      this.controllers.delete(item.id);
      this.pump();
    }
  }

  pause(id) {
    const item = this.items.get(id);
    if (!item) return null;
    if (ACTIVE.has(item.status)) this.controllers.get(id)?.abort('paused');
    else if (item.status === 'queued') this.update(item, { status: 'paused' });
    return { ...item };
  }

  resume(id) {
    const item = this.items.get(id);
    if (!item) return null;
    if (['paused', 'error', 'cancelled'].includes(item.status)) {
      this.update(item, { status: 'queued', error: null });
      this.pump();
    }
    return { ...item };
  }

  async cancel(id) {
    const item = this.items.get(id);
    if (!item) return null;
    if (ACTIVE.has(item.status)) {
      this.controllers.get(id)?.abort('cancelled');
    } else if (item.status !== 'done' && item.status !== 'cancelled') {
      await this.discardPart(item);
      this.update(item, { status: 'cancelled', dest: null, progress: 0, received: 0 });
      this.secrets.delete(id);
    }
    return { ...item };
  }

  async remove(id) {
    const item = this.items.get(id);
    if (!item) return false;
    if (ACTIVE.has(item.status)) {
      const ac = this.controllers.get(id);
      const finished = new Promise(resolve => {
        const onUpdate = (u) => { if (u.id === id && !ACTIVE.has(u.status)) { this.off('update', onUpdate); resolve(); } };
        this.on('update', onUpdate);
      });
      ac?.abort('cancelled');
      await finished;
    } else if (item.status !== 'done') {
      await this.discardPart(item);
    }
    this.items.delete(id);
    this.secrets.delete(id);
    this.emit('remove', { id });
    this.persist();
    return true;
  }

  async discardPart(item) {
    if (!item.dest) return;
    await fsp.unlink(item.dest + '.part').catch(() => {});
    await fsp.unlink(item.dest + '.part.json').catch(() => {});
  }

  // Debounced atomic write of the queue (without headers).
  persist() {
    if (!this.stateFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush().catch(() => {});
    }, 200);
    this.persistTimer.unref();
  }

  async flush() {
    if (!this.stateFile) return;
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    // segments and inspecting are live-only details
    const items = this.list().map(({ segments, inspecting, ...rest }) => rest);
    await fsp.writeFile(tmp, JSON.stringify(items, null, 2));
    await fsp.rename(tmp, this.stateFile);
  }

  async close() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const running = [...this.controllers.keys()];
    const done = running.map(id => new Promise(resolve => {
      const onUpdate = (u) => { if (u.id === id && !ACTIVE.has(u.status)) { this.off('update', onUpdate); resolve(); } };
      this.on('update', onUpdate);
    }));
    for (const id of running) this.controllers.get(id).abort('paused');
    await Promise.all(done);
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.flush();
  }
}

module.exports = { Queue };
