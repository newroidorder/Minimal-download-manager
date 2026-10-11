'use strict';

// User settings: IDM-style download categories (each with its own folder),
// the "ask where to save" dialog, and connection limits.
// Saved to <home>/settings.json and editable from the web UI.

const fs = require('fs');
const path = require('path');

// IDM's default categories and file types. "general" catches everything else.
const CATEGORY_DEFAULTS = [
  { id: 'compressed', name: 'Compressed', dir: 'Compressed', exts: ['zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'arj', 'ace', 'cab', 'lzh', 'zst'] },
  { id: 'documents', name: 'Documents', dir: 'Documents', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pps', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'epub', 'mobi'] },
  { id: 'music', name: 'Music', dir: 'Music', exts: ['mp3', 'wav', 'wma', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'mpa', 'ra'] },
  { id: 'programs', name: 'Programs', dir: 'Programs', exts: ['exe', 'msi', 'msix', 'appx', 'bat', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'iso', 'img'] },
  { id: 'video', name: 'Video', dir: 'Video', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'ogv', 'asf', 'rm', 'qt'] },
  { id: 'general', name: 'General', dir: '', exts: [] }
];

function defaultSettings(baseDir) {
  return {
    askWhereToSave: true,   // show the "Download File Info" dialog for captured downloads
    showDialog: true,       // show a progress / "download complete" window
    maxActive: 3,
    maxConnections: 8,
    categories: CATEGORY_DEFAULTS.map(c => ({ id: c.id, name: c.name, folder: path.join(baseDir, c.dir), exts: [...c.exts] }))
  };
}

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function cleanExts(exts) {
  const list = Array.isArray(exts) ? exts : String(exts || '').split(/[\s,;]+/);
  const out = [];
  for (const e of list) {
    const x = String(e).trim().toLowerCase().replace(/^\*?\./, '');
    if (/^[a-z0-9]{1,10}$/.test(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

// Validates a (partial) settings object on top of the current one.
function merge(current, patch) {
  const next = structuredClone(current);
  if (!patch || typeof patch !== 'object') return next;
  if ('askWhereToSave' in patch) next.askWhereToSave = !!patch.askWhereToSave;
  if ('showDialog' in patch) next.showDialog = !!patch.showDialog;
  if ('maxActive' in patch) next.maxActive = clampInt(patch.maxActive, 1, 10, current.maxActive);
  if ('maxConnections' in patch) next.maxConnections = clampInt(patch.maxConnections, 1, 32, current.maxConnections);
  if (Array.isArray(patch.categories)) {
    for (const p of patch.categories) {
      const cat = next.categories.find(c => c.id === p?.id);
      if (!cat) continue;
      if (typeof p.folder === 'string') {
        if (!path.isAbsolute(p.folder.trim())) throw new Error(`${cat.name}: folder must be a full path`);
        cat.folder = path.normalize(p.folder.trim());
      }
      if ('exts' in p && cat.id !== 'general') cat.exts = cleanExts(p.exts);
    }
  }
  return next;
}

// Picks the category for a file name, falling back to its MIME type.
function categorize(settings, filename, mime = '') {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  const byExt = ext && settings.categories.find(c => c.id !== 'general' && c.exts.includes(ext));
  if (byExt) return byExt;
  const byMime = /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'music' : null;
  return settings.categories.find(c => c.id === byMime) || settings.categories.find(c => c.id === 'general');
}

class Settings {
  constructor(file, baseDir, overrides) {
    this.file = file;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    // Start from defaults so new fields and categories appear after upgrades.
    this.value = merge(defaultSettings(baseDir), saved);
    if (overrides) this.value = merge(this.value, overrides);
  }

  get() {
    return structuredClone(this.value);
  }

  update(patch) {
    this.value = merge(this.value, patch);
    if (this.file) {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
      fs.renameSync(tmp, this.file);
    }
    return this.get();
  }

  categorize(filename, mime) {
    return categorize(this.value, filename, mime);
  }
}

module.exports = { Settings, defaultSettings, categorize, merge };
