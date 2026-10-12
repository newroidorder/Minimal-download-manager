'use strict';

// All user settings, grouped like the Options tabs. Saved to
// <home>/settings.json. Every value is validated against the defaults, so
// a damaged or old file can never put the app in a bad state.

const fs = require('fs');
const path = require('path');

// Default "File types" list for automatic capture.
const CAPTURE_EXTS = ('3gp 7z aac ace aif apk arj asf avi bin bz2 exe gz gzip img iso lzh m4a m4v mkv mov mp3 mp4 '
  + 'mpa mpe mpeg mpg msi msu ogg ogv pdf plj pps ppt qt r0 r1 ra rar rm rmvb sea sit sitx tar tif tiff wav wma wmv z zip '
  + 'flac webm opus xz zst dmg pkg deb rpm appimage msix epub torrent').split(' ');

const EXCLUDE_SITES = ['*.update.microsoft.com', 'download.windowsupdate.com', '*.download.windowsupdate.com', 'siteseal.thawte.com', 'ecom.cimetz.com', '*.voice2page.com'];

const CATEGORY_DEFAULTS = [
  { id: 'compressed', dir: 'Compressed', exts: ['zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'arj', 'ace', 'cab', 'lzh', 'zst', 'r0', 'r1', 'sit', 'sitx', 'sea', 'z', 'gzip'] },
  { id: 'documents', dir: 'Documents', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pps', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'epub', 'mobi', 'plj'] },
  { id: 'music', dir: 'Music', exts: ['mp3', 'wav', 'wma', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'mpa', 'ra'] },
  { id: 'programs', dir: 'Programs', exts: ['exe', 'msi', 'msu', 'msix', 'appx', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'iso', 'img', 'bin'] },
  { id: 'video', dir: 'Video', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'mpe', '3gp', 'ts', 'ogv', 'asf', 'rm', 'rmvb', 'qt'] },
  { id: 'general', dir: '', exts: [] }
];
const BUILTIN_CATEGORIES = new Set(CATEGORY_DEFAULTS.map(c => c.id));

const BROWSERS = ['chrome', 'edge', 'opera', 'brave', 'vivaldi', 'firefox'];
const SOUND_EVENTS = ['complete', 'failed', 'queueStart', 'queueEnd'];
const COLUMNS = ['name', 'queue', 'size', 'status', 'timeLeft', 'rate', 'lastTry', 'description'];

function defaultQueue(id, name = '') {
  return {
    id, name, maxConcurrent: 1,
    schedule: { enabled: false, startMode: 'daily', startTime: '03:00', startDate: '', days: [0, 1, 2, 3, 4, 5, 6], stopEnabled: false, stopTime: '07:00', afterFinish: 'none' }
  };
}

function defaults(baseDir) {
  return {
    version: 2,
    language: 'auto',
    general: {
      startWithWindows: true,
      monitorClipboard: true,
      browsers: Object.fromEntries(BROWSERS.map(b => [b, true])),
      contextMenu: true,
      bypassKey: 'alt',         // hold this key while clicking to let the browser download
      sendCookies: true,        // the extension sends the site's cookies with captured downloads
      allowHttpBridge: false    // old 127.0.0.1:7878 connection, only for extensions without native messaging
    },
    fileTypes: { capture: [...CAPTURE_EXTS], excludeSites: [...EXCLUDE_SITES], excludeUrls: [] },
    save: {
      categories: CATEGORY_DEFAULTS.map(c => ({ id: c.id, name: '', folder: path.join(baseDir, c.dir), exts: [...c.exts], rememberLast: true })),
      setFileDate: false
    },
    downloads: {
      showFileInfo: true,       // "New download" window before starting
      showProgress: true,       // progress window
      showComplete: true,       // "Download complete" window
      duplicate: 'ask',         // ask | number | overwrite | resume
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      antivirus: {
        enabled: false,
        program: 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
        args: '-Scan -ScanType 3 -File "%f"'
      }
    },
    connection: {
      maxConnections: 8,
      maxActive: 3,
      exceptions: [],           // [{ host, max }]
      quota: { enabled: false, mb: 200, hours: 5, warn: true }
    },
    proxy: { mode: 'none', pacUrl: '', type: 'http', host: '', port: 8080, user: '', pass: '' },
    sites: [],                  // [{ site, user, pass }]
    retry: { attempts: 0, delay: 30 },   // 0 = keep retrying
    sounds: Object.fromEntries(SOUND_EVENTS.map(e => [e, { enabled: false, file: '' }])),
    speedLimit: { enabled: false, kbps: 1024 },
    ui: {
      theme: 'system',
      hideCategories: false,
      toolbar: 'large',         // large | small | hidden
      fontSize: 13,
      sortBy: 'addedAt',
      sortDir: 'desc',
      columns: Object.fromEntries(COLUMNS.map(c => [c, true])),
      columnWidths: {},
      closeToTray: true
    },
    queues: [defaultQueue('main')],
    grabberProjects: []         // [{ id, name, url, depth, exts, sameSite }]
  };
}

// ---------- validation helpers ----------

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const str = (v, fallback, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const time = (v, fallback) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback);
const isAbs = (p) => path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\/.test(p);

function cleanExts(exts) {
  const list = Array.isArray(exts) ? exts : String(exts || '').split(/[\s,;]+/);
  const out = [];
  for (const e of list) {
    const x = String(e).trim().toLowerCase().replace(/^\*?\./, '');
    if (/^[a-z0-9]{1,10}$/.test(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

function cleanList(v, max = 500) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))].slice(0, max);
}

function absFolder(v, fallback, label) {
  if (typeof v !== 'string') return fallback;
  const p = v.trim();
  if (!isAbs(p)) throw new Error(`${label}: folder must be a full path`);
  return p.length > 3 ? p.replace(/[\\/]+$/, '') : p;
}

function slug(name) {
  const s = String(name).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `c-${s || Date.now().toString(36)}`;
}

// Merges a (partial) patch onto current settings with full validation.
function merge(current, patch, baseDir) {
  const d = defaults(baseDir);
  const next = structuredClone(current);
  if (!patch || typeof patch !== 'object') return next;

  if ('language' in patch) next.language = oneOf(patch.language, ['auto', 'en', 'pt-BR'], next.language);

  const g = patch.general;
  if (g && typeof g === 'object') {
    next.general.startWithWindows = bool(g.startWithWindows, next.general.startWithWindows);
    next.general.monitorClipboard = bool(g.monitorClipboard, next.general.monitorClipboard);
    next.general.contextMenu = bool(g.contextMenu, next.general.contextMenu);
    next.general.bypassKey = oneOf(g.bypassKey, ['alt', 'shift', 'none'], next.general.bypassKey);
    next.general.sendCookies = bool(g.sendCookies, next.general.sendCookies);
    next.general.allowHttpBridge = bool(g.allowHttpBridge, next.general.allowHttpBridge);
    if (g.browsers && typeof g.browsers === 'object') {
      for (const b of BROWSERS) next.general.browsers[b] = bool(g.browsers[b], next.general.browsers[b]);
    }
  }

  const ft = patch.fileTypes;
  if (ft && typeof ft === 'object') {
    if ('capture' in ft) next.fileTypes.capture = cleanExts(ft.capture);
    if ('excludeSites' in ft) next.fileTypes.excludeSites = cleanList(ft.excludeSites);
    if ('excludeUrls' in ft) next.fileTypes.excludeUrls = cleanList(ft.excludeUrls);
  }

  const sv = patch.save;
  if (sv && typeof sv === 'object') {
    next.save.setFileDate = bool(sv.setFileDate, next.save.setFileDate);
    if (Array.isArray(sv.categories)) {
      const out = [];
      for (const c of sv.categories) {
        if (!c || typeof c !== 'object') continue;
        const existing = next.save.categories.find(x => x.id === c.id);
        const fresh = !existing && typeof c.name === 'string' && c.name.trim();
        if (!existing && !fresh) continue;
        const cat = existing ? { ...existing } : {
          id: slug(c.name), name: '', folder: path.join(baseDir, c.name.trim().replace(/[<>:"/\\|?*]/g, '_')), exts: [], rememberLast: true
        };
        if (out.some(x => x.id === cat.id)) continue;
        if (!BUILTIN_CATEGORIES.has(cat.id)) cat.name = str(c.name, cat.name, 40).trim() || cat.name;
        if ('folder' in c) cat.folder = absFolder(c.folder, cat.folder, cat.name || cat.id);
        if ('exts' in c && cat.id !== 'general') cat.exts = cleanExts(c.exts);
        cat.rememberLast = bool(c.rememberLast, cat.rememberLast);
        out.push(cat);
      }
      // Built-in categories can't be deleted; custom ones are dropped when left out.
      for (const b of d.save.categories) {
        if (!out.some(c => c.id === b.id)) out.push(next.save.categories.find(c => c.id === b.id) || b);
      }
      const gi = out.findIndex(c => c.id === 'general');
      out.push(...out.splice(gi, 1)); // General stays last
      next.save.categories = out;
    }
  }

  const dl = patch.downloads;
  if (dl && typeof dl === 'object') {
    for (const k of ['showFileInfo', 'showProgress', 'showComplete']) next.downloads[k] = bool(dl[k], next.downloads[k]);
    next.downloads.duplicate = oneOf(dl.duplicate, ['ask', 'number', 'overwrite', 'resume'], next.downloads.duplicate);
    next.downloads.userAgent = str(dl.userAgent, next.downloads.userAgent, 500).replace(/[\r\n]/g, '');
    if (dl.antivirus && typeof dl.antivirus === 'object') {
      const av = next.downloads.antivirus;
      av.enabled = bool(dl.antivirus.enabled, av.enabled);
      av.program = str(dl.antivirus.program, av.program, 500);
      av.args = str(dl.antivirus.args, av.args, 500);
    }
  }

  const cn = patch.connection;
  if (cn && typeof cn === 'object') {
    next.connection.maxConnections = clampInt(cn.maxConnections ?? next.connection.maxConnections, 1, 32, next.connection.maxConnections);
    next.connection.maxActive = clampInt(cn.maxActive ?? next.connection.maxActive, 1, 20, next.connection.maxActive);
    if (Array.isArray(cn.exceptions)) {
      next.connection.exceptions = cn.exceptions
        .filter(e => e && typeof e.host === 'string' && e.host.trim())
        .map(e => ({ host: e.host.trim().toLowerCase().slice(0, 200), max: clampInt(e.max, 1, 32, 1) }))
        .slice(0, 100);
    }
    if (cn.quota && typeof cn.quota === 'object') {
      const q = next.connection.quota;
      q.enabled = bool(cn.quota.enabled, q.enabled);
      q.mb = clampInt(cn.quota.mb ?? q.mb, 1, 10_000_000, q.mb);
      q.hours = clampInt(cn.quota.hours ?? q.hours, 1, 24 * 31, q.hours);
      q.warn = bool(cn.quota.warn, q.warn);
    }
  }

  const px = patch.proxy;
  if (px && typeof px === 'object') {
    const p = next.proxy;
    p.mode = oneOf(px.mode, ['none', 'system', 'pac', 'manual'], p.mode);
    p.pacUrl = str(px.pacUrl, p.pacUrl, 1000).trim();
    p.type = oneOf(px.type, ['http', 'socks5'], p.type);
    p.host = str(px.host, p.host, 255).trim();
    p.port = clampInt(px.port ?? p.port, 1, 65535, p.port);
    p.user = str(px.user, p.user, 255);
    p.pass = str(px.pass, p.pass, 255);
  }

  if (Array.isArray(patch.sites)) {
    next.sites = patch.sites
      .filter(s => s && typeof s.site === 'string' && s.site.trim())
      .map(s => ({ site: s.site.trim().slice(0, 500), user: str(s.user, '', 255), pass: str(s.pass, '', 255) }))
      .slice(0, 500);
  }

  if (patch.retry && typeof patch.retry === 'object') {
    next.retry.attempts = clampInt(patch.retry.attempts ?? next.retry.attempts, 0, 1000, next.retry.attempts);
    next.retry.delay = clampInt(patch.retry.delay ?? next.retry.delay, 1, 3600, next.retry.delay);
  }

  if (patch.sounds && typeof patch.sounds === 'object') {
    for (const e of SOUND_EVENTS) {
      const s = patch.sounds[e];
      if (!s || typeof s !== 'object') continue;
      next.sounds[e].enabled = bool(s.enabled, next.sounds[e].enabled);
      next.sounds[e].file = str(s.file, next.sounds[e].file, 1000);
    }
  }

  if (patch.speedLimit && typeof patch.speedLimit === 'object') {
    next.speedLimit.enabled = bool(patch.speedLimit.enabled, next.speedLimit.enabled);
    next.speedLimit.kbps = clampInt(patch.speedLimit.kbps ?? next.speedLimit.kbps, 1, 10_000_000, next.speedLimit.kbps);
  }

  const ui = patch.ui;
  if (ui && typeof ui === 'object') {
    next.ui.theme = oneOf(ui.theme, ['system', 'light', 'dark'], next.ui.theme);
    next.ui.hideCategories = bool(ui.hideCategories, next.ui.hideCategories);
    next.ui.toolbar = oneOf(ui.toolbar, ['large', 'small', 'hidden'], next.ui.toolbar);
    next.ui.fontSize = clampInt(ui.fontSize ?? next.ui.fontSize, 11, 18, next.ui.fontSize);
    next.ui.sortBy = oneOf(ui.sortBy, ['addedAt', 'name', 'size', 'status', 'lastTry', 'category', 'description', 'rate', 'timeLeft', 'queue'], next.ui.sortBy);
    next.ui.sortDir = oneOf(ui.sortDir, ['asc', 'desc'], next.ui.sortDir);
    next.ui.closeToTray = bool(ui.closeToTray, next.ui.closeToTray);
    if (ui.columns && typeof ui.columns === 'object') {
      for (const c of COLUMNS) next.ui.columns[c] = c === 'name' ? true : bool(ui.columns[c], next.ui.columns[c]);
    }
    if (ui.columnWidths && typeof ui.columnWidths === 'object') {
      for (const c of COLUMNS) if (c in ui.columnWidths) next.ui.columnWidths[c] = clampInt(ui.columnWidths[c], 40, 800, 120);
    }
  }

  if (Array.isArray(patch.queues)) {
    const out = [];
    for (const q of patch.queues) {
      if (!q || typeof q !== 'object') continue;
      const id = typeof q.id === 'string' && /^[\w-]{1,40}$/.test(q.id) ? q.id : `q-${Date.now().toString(36)}${out.length}`;
      if (out.some(x => x.id === id)) continue;
      const cur = next.queues.find(x => x.id === id) || defaultQueue(id);
      const s = q.schedule && typeof q.schedule === 'object' ? q.schedule : {};
      out.push({
        id,
        name: id === 'main' ? str(q.name, cur.name, 60) : (str(q.name, cur.name, 60).trim() || 'Queue'),
        maxConcurrent: clampInt(q.maxConcurrent ?? cur.maxConcurrent, 1, 20, cur.maxConcurrent),
        schedule: {
          enabled: bool(s.enabled, cur.schedule.enabled),
          startMode: oneOf(s.startMode, ['once', 'daily'], cur.schedule.startMode),
          startTime: time(s.startTime, cur.schedule.startTime),
          startDate: typeof s.startDate === 'string' && (s.startDate === '' || /^\d{4}-\d{2}-\d{2}$/.test(s.startDate)) ? s.startDate : cur.schedule.startDate,
          days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : cur.schedule.days,
          stopEnabled: bool(s.stopEnabled, cur.schedule.stopEnabled),
          stopTime: time(s.stopTime, cur.schedule.stopTime),
          afterFinish: oneOf(s.afterFinish, ['none', 'exit', 'shutdown', 'sleep'], cur.schedule.afterFinish)
        }
      });
    }
    if (!out.some(q => q.id === 'main')) out.unshift(next.queues.find(q => q.id === 'main') || defaultQueue('main'));
    next.queues = out.slice(0, 50);
  }

  if (Array.isArray(patch.grabberProjects)) {
    next.grabberProjects = patch.grabberProjects
      .filter(g => g && typeof g.url === 'string' && /^https?:\/\//i.test(g.url.trim()))
      .map((g, n) => ({
        id: typeof g.id === 'string' && /^[\w-]{1,40}$/.test(g.id) ? g.id : `g-${Date.now().toString(36)}${n}`,
        name: str(g.name, '', 80).trim() || g.url.trim().slice(0, 80),
        url: g.url.trim().slice(0, 2000),
        depth: clampInt(g.depth, 0, 3, 1),
        exts: cleanExts(g.exts),
        sameSite: bool(g.sameSite, true)
      }))
      .slice(0, 100);
  }
  return next;
}

// Version 1 (the first browser + local server build) used a flat file.
function migrate(saved) {
  if (!saved || typeof saved !== 'object' || saved.version === 2) return saved;
  const out = {};
  if (Array.isArray(saved.categories)) out.save = { categories: saved.categories };
  out.downloads = { showFileInfo: saved.askWhereToSave, showProgress: saved.showDialog, showComplete: saved.showDialog };
  out.connection = { maxActive: saved.maxActive, maxConnections: saved.maxConnections };
  return out;
}

function extOf(filename) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

// Picks the category for a file name, falling back to its MIME type.
function categorize(settings, filename, mime = '') {
  const ext = extOf(filename);
  const cats = settings.save.categories;
  const byExt = ext && cats.find(c => c.id !== 'general' && c.exts.includes(ext));
  if (byExt) return byExt;
  const byMime = /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'music' : null;
  return cats.find(c => c.id === byMime) || cats.find(c => c.id === 'general');
}

// Saved passwords (Sites and logins, proxy) are written encrypted when the
// program gives us a cipher (Windows DPAPI through Electron's safeStorage):
// "enc:<base64>". They are only ever plain text in memory.
const ENC = 'enc:';

function mapSecrets(value, fn) {
  const out = structuredClone(value);
  if (out?.proxy && typeof out.proxy.pass === 'string') out.proxy.pass = fn(out.proxy.pass);
  if (Array.isArray(out?.sites)) for (const s of out.sites) if (s && typeof s.pass === 'string') s.pass = fn(s.pass);
  return out;
}

class Settings {
  /**
   * cipher: { encrypt(text) -> base64, decrypt(base64) -> text }, optional.
   * Without one, passwords are kept as they are (tests, platforms without a keyring).
   */
  constructor(file, baseDir, overrides, { cipher = null } = {}) {
    this.file = file;
    this.baseDir = baseDir;
    this.cipher = cipher;
    this.listeners = new Set();
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    let plaintextOnDisk = false;
    if (saved) {
      saved = mapSecrets(saved, (v) => {
        if (!v.startsWith(ENC)) { if (v) plaintextOnDisk = true; return v; }
        try { return cipher ? cipher.decrypt(v.slice(ENC.length)) : ''; } catch { return ''; } // other user or machine: re-enter
      });
    }
    this.value = defaults(baseDir);
    try { this.value = merge(this.value, migrate(saved), baseDir); } catch { /* keep defaults on bad data */ }
    if (overrides) this.value = merge(this.value, overrides, baseDir);
    if (plaintextOnDisk && cipher && file) {
      try { this.save(); } catch { /* read-only folder: try again on the next change */ }
    }
  }

  // What goes to disk: the settings with passwords encrypted.
  serialize() {
    const value = this.cipher ? mapSecrets(this.value, v => (v ? ENC + this.cipher.encrypt(v) : v)) : this.value;
    return JSON.stringify(value, null, 2);
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, this.serialize(), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get() {
    return structuredClone(this.value);
  }

  update(patch) {
    this.value = merge(this.value, patch, this.baseDir);
    if (this.file) this.save();
    const v = this.get();
    for (const fn of this.listeners) fn(v);
    return v;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  categorize(filename, mime) {
    return categorize(this.value, filename, mime);
  }

  queue(id) {
    return this.value.queues.find(q => q.id === id);
  }
}

module.exports = { Settings, defaults, merge, categorize, extOf, cleanExts, BROWSERS, SOUND_EVENTS, COLUMNS };
