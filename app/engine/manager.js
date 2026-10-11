'use strict';

// The download manager: the list, queues, limits, retries and the rules from
// Options. The desktop UI and the browser API both drive it.
//
// Statuses: pending (waiting for "Download File Info"), queued, starting,
// downloading, scanning (antivirus), paused, done, error, cancelled.
// Request headers (cookies) live in memory only and are never written to disk.

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { download, inspect, filenameFromUrl, sanitize, HttpError } = require('./downloader');
const { Limiter } = require('./limiter');
const { credentialsFor, hostMatches } = require('./rules');

const ACTIVE = new Set(['starting', 'downloading']);
const BUSY = new Set(['starting', 'downloading', 'scanning']);
const LIVE_ONLY = ['segments', 'inspecting', 'speed', 'connections'];

class Manager extends EventEmitter {
  /**
   * settings: Settings instance. stateFile: where the list is saved.
   * route: proxy router (proxy.js). runProgram(file, args) -> exit code (antivirus).
   */
  constructor({ settings, stateFile, downloadOptions = {}, route, runProgram, now = () => Date.now() }) {
    super();
    this.setMaxListeners(100);
    this.settings = settings;
    this.stateFile = stateFile;
    this.downloadOptions = downloadOptions;
    this.route = route;
    this.runProgram = runProgram;
    this.now = now;
    this.items = new Map();
    this.secrets = new Map();       // id -> request headers
    this.controllers = new Map();   // id -> AbortController
    this.retryTimers = new Map();   // id -> timeout
    this.runningQueues = new Set();
    this.limiter = new Limiter();
    this.quota = { windowStart: now(), bytes: 0, blocked: false, warned: false, timer: null };
    this.persistTimer = null;
    this.applyLimits();
    settings.onChange(() => { this.applyLimits(); this.pump(); });
    this.load();
  }

  s() {
    return this.settings.value; // read-only view, cheaper than get()
  }

  applyLimits() {
    const sl = this.s().speedLimit;
    this.limiter.set(sl.enabled ? sl.kbps * 1024 : 0);
  }

  // ---------- list ----------

  load() {
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return; }
    if (!Array.isArray(saved)) return;
    for (const item of saved) {
      if (!item || typeof item.id !== 'string') continue;
      // Interrupted by a restart: hold it so the user can resume. Cookies are gone.
      if (ACTIVE.has(item.status)) item.status = 'paused';
      if (item.status === 'scanning') item.status = 'done';
      Object.assign(item, { speed: 0, connections: 0, inspecting: false });
      this.items.set(item.id, item);
    }
    setImmediate(() => this.pump());
  }

  list() {
    return [...this.items.values()].map(i => ({ ...i })).sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id) {
    const i = this.items.get(id);
    return i ? { ...i } : null;
  }

  update(item, patch, persist = true) {
    Object.assign(item, patch);
    this.emit('update', { ...item });
    if (persist) this.persist();
  }

  // ---------- adding ----------

  findDuplicate(url) {
    return [...this.items.values()].find(i => i.url === url && i.status !== 'cancelled');
  }

  /**
   * opts: { url, filename, headers, referrer, description, interactive, kind,
   *         dir, queueId, start = true, duplicate }
   * Returns { item } or, when the duplicate rule is "ask" and no answer was
   * given, { duplicate: existingItem } so the UI can ask.
   */
  add(opts) {
    const u = new URL(opts.url); // throws on garbage
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https addresses are supported');
    const s = this.s();

    const existing = this.findDuplicate(u.href);
    let overwriteOf = null;
    if (existing) {
      const action = opts.duplicate || s.downloads.duplicate;
      if (action === 'ask') return { duplicate: { ...existing } };
      if (action === 'resume') {
        if (existing.status !== 'done') this.resume(existing.id);
        if (opts.headers) this.secrets.set(existing.id, opts.headers);
        return { item: { ...existing }, existing: true };
      }
      if (action === 'overwrite') overwriteOf = existing;
    }

    const id = randomUUID();
    const requested = opts.filename ? sanitize(opts.filename) : (overwriteOf ? overwriteOf.filename : null);
    const name = requested || filenameFromUrl(u.href) || u.hostname;
    const ask = !!opts.interactive && s.downloads.showFileInfo;
    const later = opts.start === false;
    const item = {
      id,
      url: u.href,
      referrer: typeof opts.referrer === 'string' ? opts.referrer.slice(0, 2000) : '',
      requestedName: requested,
      filename: name,
      category: this.settings.categorize(name).id,
      dir: opts.dir || (overwriteOf ? overwriteOf.dir : null),
      dest: null,
      mime: '',
      status: ask ? 'pending' : 'queued',
      queueId: !ask && later ? (opts.queueId || 'main') : (opts.queueId || null),
      queueOrder: 0,
      inspecting: ask,
      inspectError: null,
      size: 0,
      received: 0,
      progress: 0,
      speed: 0,
      connections: 0,
      error: null,
      description: typeof opts.description === 'string' ? opts.description.slice(0, 500) : '',
      kind: opts.kind || 'manual',
      retries: 0,
      addedAt: this.now(),
      lastTryAt: null,
      finishedAt: null,
      overwrite: !!overwriteOf
    };
    if (item.queueId) item.queueOrder = this.nextOrder(item.queueId);
    if (overwriteOf) {
      // "Add the duplicate and overwrite the existing file"
      if (overwriteOf.dest) for (const f of [overwriteOf.dest, overwriteOf.dest + '.part', overwriteOf.dest + '.part.json']) fs.rmSync(f, { force: true });
      if (BUSY.has(overwriteOf.status)) this.controllers.get(overwriteOf.id)?.abort('cancelled');
      this.forget(overwriteOf.id);
    }
    this.items.set(id, item);
    if (opts.headers && Object.keys(opts.headers).length) this.secrets.set(id, { ...opts.headers });
    this.emit('update', { ...item });
    this.persist();
    if (ask) this.inspectItem(item);
    else this.pump();
    return { item: { ...item } };
  }

  nextOrder(queueId) {
    let max = 0;
    for (const i of this.items.values()) if (i.queueId === queueId) max = Math.max(max, i.queueOrder || 0);
    return max + 1;
  }

  headersFor(item) {
    const h = { ...(this.secrets.get(item.id) || {}) };
    const has = (name) => Object.keys(h).some(k => k.toLowerCase() === name);
    if (!has('user-agent')) h['User-Agent'] = this.s().downloads.userAgent;
    if (!has('referer') && item.referrer) h.Referer = item.referrer;
    if (!has('authorization')) {
      const auth = credentialsFor(this.s().sites, item.url);
      if (auth) h.Authorization = auth;
    }
    return h;
  }

  connectionsFor(url) {
    const c = this.s().connection;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    const ex = c.exceptions.find(e => hostMatches(e.host, host));
    return ex ? ex.max : c.maxConnections;
  }

  // Fills in name, size, type, category and folder for "Download File Info".
  async inspectItem(item) {
    const patch = { inspecting: false };
    try {
      const info = await inspect(item.url, { headers: this.headersFor(item), route: this.route, ...this.downloadOptions });
      Object.assign(patch, { size: info.size, mime: info.mime });
      if (!item.requestedName) patch.filename = info.filename;
    } catch (err) {
      patch.inspectError = err.message;
    }
    if (!this.items.has(item.id) || item.status !== 'pending') return;
    const cat = this.settings.categorize(patch.filename || item.filename, patch.mime || item.mime);
    this.update(item, { ...patch, category: cat.id, dir: item.dir || cat.folder });
  }

  // The answer to "Download File Info": name, folder, start now or later.
  confirm(id, { filename, dir, category, start = true, queueId, description } = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.status !== 'pending') throw Object.assign(new Error('this download is not waiting for confirmation'), { status: 409 });
    const folder = typeof dir === 'string' ? dir.trim() : '';
    if (!path.isAbsolute(folder) && !/^[a-zA-Z]:[\\/]/.test(folder)) throw Object.assign(new Error('choose a full folder path'), { status: 400 });
    const patch = { dir: folder, status: 'queued', inspecting: false, queueId: null };
    if (typeof filename === 'string' && filename.trim()) {
      patch.requestedName = sanitize(filename.trim());
      patch.filename = patch.requestedName;
    }
    const cats = this.s().save.categories;
    const cat = cats.find(c => c.id === category) || cats.find(c => c.id === item.category);
    if (cat) patch.category = cat.id;
    if (typeof description === 'string') patch.description = description.slice(0, 500);
    if (!start) {
      patch.queueId = queueId && this.settings.queue(queueId) ? queueId : 'main';
      patch.queueOrder = this.nextOrder(patch.queueId);
    }
    // "Remember the last folder used for this category"
    if (cat && cat.rememberLast && cat.folder !== folder) {
      this.settings.update({ save: { categories: cats.map(c => (c.id === cat.id ? { ...c, folder } : c)) } });
    }
    this.update(item, patch);
    this.pump();
    return { ...item };
  }

  // ---------- running ----------

  activeIn(queueId) {
    let n = 0;
    for (const i of this.items.values()) if (BUSY.has(i.status) && (i.queueId || null) === queueId) n++;
    return n;
  }

  pump() {
    if (this.quota.blocked) return;
    const all = [...this.items.values()];
    const queued = (qid) => all.filter(i => i.status === 'queued' && (i.queueId || null) === qid && !this.retryTimers.has(i.id));

    // Downloads outside queues start right away, up to "downloads at once".
    let free = this.s().connection.maxActive - this.activeIn(null);
    for (const item of queued(null).sort((a, b) => a.addedAt - b.addedAt)) {
      if (free-- <= 0) break;
      this.run(item);
    }
    // Each running queue downloads its files in order, N at a time.
    for (const qid of [...this.runningQueues]) {
      const q = this.settings.queue(qid);
      if (!q) { this.runningQueues.delete(qid); continue; }
      let qfree = q.maxConcurrent - this.activeIn(qid);
      const waiting = queued(qid).sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0));
      for (const item of waiting) {
        if (qfree-- <= 0) break;
        this.run(item);
      }
      const left = all.some(i => i.queueId === qid && (BUSY.has(i.status) || i.status === 'queued'));
      if (!left) this.finishQueue(qid);
    }
  }

  async run(item) {
    this.clearRetry(item.id);
    const ac = new AbortController();
    this.controllers.set(item.id, ac);
    this.update(item, { status: 'starting', error: null, speed: 0, lastTryAt: this.now() });
    const s = this.s();
    try {
      const result = await download(
        { url: item.url, filename: item.requestedName, headers: this.headersFor(item), dir: item.dir, dest: item.dest },
        {
          maxConnections: this.connectionsFor(item.url),
          limiter: this.limiter,
          onBytes: (n) => this.countBytes(n),
          route: this.route,
          ...this.downloadOptions,
          saveDir: this.settings.baseDir,
          resolveDir: (name, mime) => this.settings.categorize(name, mime).folder,
          signal: ac.signal,
          onProgress: (p) => {
            const first = item.dest !== p.dest;
            const patch = { status: 'downloading', ...p };
            if (first) {
              patch.dir = path.dirname(p.dest);
              if (!item.dir) patch.category = this.settings.categorize(p.filename).id;
            }
            this.update(item, patch, first);
          }
        }
      );
      if (result.status === 'done') {
        await this.finish(item, result, s);
      } else if (result.status === 'paused') {
        this.update(item, { status: item.quotaPaused ? 'queued' : 'paused', dest: result.dest, speed: 0, connections: 0 });
      } else {
        this.update(item, { status: 'cancelled', dest: null, speed: 0, connections: 0, progress: 0, received: 0, segments: [] });
        this.secrets.delete(item.id);
      }
    } catch (err) {
      this.fail(item, err);
    } finally {
      this.controllers.delete(item.id);
      this.pump();
    }
  }

  async finish(item, result, s) {
    if (s.save.setFileDate && result.lastModified) {
      const t = new Date(result.lastModified);
      if (!Number.isNaN(t.getTime())) await fsp.utimes(result.dest, t, t).catch(() => {});
    }
    const done = {
      status: 'done', dest: result.dest, filename: path.basename(result.dest), dir: path.dirname(result.dest),
      size: result.size, received: result.size, progress: 100, speed: 0, connections: 0, segments: [],
      finishedAt: this.now(), retries: 0, error: null
    };
    const av = s.downloads.antivirus;
    if (av.enabled && av.program && this.runProgram) {
      this.update(item, { ...done, status: 'scanning' });
      try {
        const code = await this.runProgram(av.program, av.args, result.dest);
        done.scan = code === 0 ? 'clean' : `warning (exit code ${code})`;
      } catch (err) {
        done.scan = `could not run the antivirus: ${err.message}`;
      }
    }
    this.update(item, done);
    this.secrets.delete(item.id);
    this.emit('event', { type: 'complete', item: { ...item } });
  }

  fail(item, err) {
    const s = this.s();
    const retryable = !(err instanceof HttpError) || err.status >= 500 || err.status === 408 || err.status === 429;
    const attempts = s.retry.attempts;
    const canRetry = retryable && (attempts === 0 || item.retries < attempts);
    this.update(item, { status: 'error', error: err.message, dest: err.dest || item.dest || null, speed: 0, connections: 0 });
    if (item.retries === 0) this.emit('event', { type: 'failed', item: { ...item } });
    if (canRetry) {
      const timer = setTimeout(() => {
        this.retryTimers.delete(item.id);
        const cur = this.items.get(item.id);
        if (cur && cur.status === 'error') {
          this.update(cur, { status: 'queued', retries: (cur.retries || 0) + 1 });
          this.pump();
        }
      }, s.retry.delay * 1000);
      timer.unref?.();
      this.retryTimers.set(item.id, timer);
    }
  }

  clearRetry(id) {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
  }

  // ---------- download quota ("Download limits") ----------

  countBytes(n) {
    const q = this.s().connection.quota;
    if (!q.enabled) return;
    const now = this.now();
    const windowMs = q.hours * 3600_000;
    if (now - this.quota.windowStart >= windowMs) Object.assign(this.quota, { windowStart: now, bytes: 0, warned: false });
    this.quota.bytes += n;
    const limit = q.mb * 1024 * 1024;
    if (q.warn && !this.quota.warned && this.quota.bytes >= limit * 0.9) {
      this.quota.warned = true;
      this.emit('event', { type: 'quotaWarning', mb: q.mb, hours: q.hours });
    }
    if (!this.quota.blocked && this.quota.bytes >= limit) {
      this.quota.blocked = true;
      const until = this.quota.windowStart + windowMs;
      for (const item of this.items.values()) {
        if (ACTIVE.has(item.status)) {
          item.quotaPaused = true;
          this.controllers.get(item.id)?.abort('paused');
        }
      }
      this.emit('event', { type: 'quota', until });
      this.quota.timer = setTimeout(() => this.unblockQuota(), Math.max(0, until - now));
      this.quota.timer.unref?.();
    }
  }

  unblockQuota() {
    Object.assign(this.quota, { blocked: false, bytes: 0, warned: false, windowStart: this.now() });
    for (const item of this.items.values()) if (item.quotaPaused) delete item.quotaPaused;
    this.pump();
  }

  // ---------- actions ----------

  pause(id) {
    const item = this.items.get(id);
    if (!item) return null;
    this.clearRetry(id);
    if (ACTIVE.has(item.status)) this.controllers.get(id)?.abort('paused');
    else if (item.status === 'queued' || item.status === 'error') this.update(item, { status: 'paused' });
    return { ...item };
  }

  resume(id) {
    const item = this.items.get(id);
    if (!item) return null;
    this.clearRetry(id);
    if (['paused', 'error', 'cancelled'].includes(item.status)) {
      this.update(item, { status: 'queued', error: null, retries: 0 });
      // Resuming a download that sits in a stopped queue starts it now.
      if (item.queueId && !this.runningQueues.has(item.queueId)) this.update(item, { queueId: null });
      this.pump();
    }
    return { ...item };
  }

  async cancel(id) {
    const item = this.items.get(id);
    if (!item) return null;
    this.clearRetry(id);
    if (ACTIVE.has(item.status)) {
      this.controllers.get(id)?.abort('cancelled');
    } else if (!['done', 'cancelled', 'scanning'].includes(item.status)) {
      await this.discardPart(item);
      this.update(item, { status: 'cancelled', dest: null, progress: 0, received: 0, segments: [] });
      this.secrets.delete(id);
    }
    return { ...item };
  }

  waitIdle(id) {
    return new Promise((resolve) => {
      const item = this.items.get(id);
      if (!item || !BUSY.has(item.status)) return resolve();
      const onUpdate = (u) => {
        if (u.id === id && !BUSY.has(u.status)) { this.off('update', onUpdate); resolve(); }
      };
      this.on('update', onUpdate);
    });
  }

  // deleteFile: also delete the downloaded file from disk.
  async remove(id, { deleteFile = false } = {}) {
    const item = this.items.get(id);
    if (!item) return false;
    this.clearRetry(id);
    if (ACTIVE.has(item.status)) {
      const idle = this.waitIdle(id);
      this.controllers.get(id)?.abort('cancelled');
      await idle;
    } else if (item.status !== 'done') {
      await this.discardPart(item);
    }
    if (deleteFile && item.status === 'done' && item.dest) await fsp.unlink(item.dest).catch(() => {});
    this.forget(id);
    return true;
  }

  forget(id) {
    this.items.delete(id);
    this.secrets.delete(id);
    this.emit('remove', { id });
    this.persist();
  }

  removeCompleted() {
    let n = 0;
    for (const item of [...this.items.values()]) {
      if (item.status === 'done') { this.forget(item.id); n++; }
    }
    return n;
  }

  // "Stop all": every running or waiting download is paused.
  stopAll() {
    for (const item of this.items.values()) {
      if (ACTIVE.has(item.status) || item.status === 'queued' || this.retryTimers.has(item.id)) this.pause(item.id);
    }
    for (const qid of [...this.runningQueues]) this.runningQueues.delete(qid);
    this.emit('queues', [...this.runningQueues]);
  }

  // Download again from scratch, replacing the old file.
  async redownload(id) {
    const item = this.items.get(id);
    if (!item) return null;
    if (BUSY.has(item.status)) {
      const idle = this.waitIdle(id);
      this.controllers.get(id)?.abort('cancelled');
      await idle;
    }
    await this.discardPart(item);
    if (item.status === 'done' && item.dest) await fsp.unlink(item.dest).catch(() => {});
    this.update(item, {
      status: 'queued', requestedName: item.requestedName || item.filename, dest: null,
      received: 0, progress: 0, error: null, retries: 0, segments: [], finishedAt: null
    });
    this.pump();
    return { ...item };
  }

  // Properties window: description, and a new address for an unfinished download.
  edit(id, { description, url } = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    const patch = {};
    if (typeof description === 'string') patch.description = description.slice(0, 500);
    if (typeof url === 'string' && url.trim() && url.trim() !== item.url) {
      if (item.status === 'done' || BUSY.has(item.status)) throw Object.assign(new Error('the address can only change while the download is stopped'), { status: 409 });
      const u = new URL(url.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https addresses are supported');
      patch.url = u.href;
    }
    this.update(item, patch);
    return { ...item };
  }

  // ---------- queues ----------

  setQueue(ids, queueId) {
    if (queueId && !this.settings.queue(queueId)) throw new Error('unknown queue');
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item || item.status === 'done') continue;
      const patch = { queueId: queueId || null };
      if (queueId) {
        patch.queueOrder = this.nextOrder(queueId);
        if (item.status === 'paused' || item.status === 'error') patch.status = 'queued';
      } else if (item.status === 'queued') {
        patch.status = 'paused'; // taken out of a queue: wait for the user
      }
      this.update(item, patch);
    }
    this.pump();
  }

  reorderQueue(queueId, ids) {
    ids.forEach((id, n) => {
      const item = this.items.get(id);
      if (item && item.queueId === queueId) this.update(item, { queueOrder: n + 1 });
    });
  }

  startQueue(queueId) {
    if (!this.settings.queue(queueId) || this.runningQueues.has(queueId)) return false;
    for (const item of this.items.values()) {
      if (item.queueId === queueId && ['paused', 'error'].includes(item.status)) {
        this.clearRetry(item.id);
        this.update(item, { status: 'queued', error: null });
      }
    }
    this.runningQueues.add(queueId);
    this.emit('queues', [...this.runningQueues]);
    this.emit('event', { type: 'queueStart', queue: this.settings.queue(queueId) });
    this.pump();
    return true;
  }

  stopQueue(queueId) {
    if (!this.runningQueues.delete(queueId)) return false;
    for (const item of this.items.values()) {
      if (item.queueId === queueId && ACTIVE.has(item.status)) this.controllers.get(item.id)?.abort('paused');
    }
    this.emit('queues', [...this.runningQueues]);
    return true;
  }

  finishQueue(queueId) {
    this.runningQueues.delete(queueId);
    this.emit('queues', [...this.runningQueues]);
    const q = this.settings.queue(queueId);
    this.emit('event', { type: 'queueEnd', queue: q, afterFinish: q?.schedule.afterFinish || 'none' });
  }

  deleteQueue(queueId) {
    if (queueId === 'main') throw new Error('the main queue cannot be deleted');
    this.stopQueue(queueId);
    for (const item of this.items.values()) if (item.queueId === queueId) this.update(item, { queueId: null, status: item.status === 'queued' ? 'paused' : item.status });
    this.settings.update({ queues: this.s().queues.filter(q => q.id !== queueId) });
  }

  // ---------- disk ----------

  async discardPart(item) {
    if (!item.dest) return;
    await fsp.unlink(item.dest + '.part').catch(() => {});
    await fsp.unlink(item.dest + '.part.json').catch(() => {});
  }

  persist() {
    if (!this.stateFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush().catch(() => {});
    }, 300);
    this.persistTimer.unref?.();
  }

  async flush() {
    if (!this.stateFile) return;
    const items = [...this.items.values()].map((i) => {
      const out = { ...i };
      for (const k of LIVE_ONLY) delete out[k];
      return out;
    });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(items, null, 1));
    await fsp.rename(tmp, this.stateFile);
  }

  // Pause running downloads (they resume from where they stopped) and save.
  async close() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    clearTimeout(this.quota.timer);
    for (const id of [...this.retryTimers.keys()]) this.clearRetry(id);
    const running = [...this.controllers.keys()];
    const idle = running.map(id => this.waitIdle(id));
    for (const id of running) this.controllers.get(id)?.abort('paused');
    await Promise.all(idle);
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.flush();
  }
}

module.exports = { Manager, ACTIVE, BUSY };
