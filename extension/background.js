// The extension is only a connector, like IDM's: it hands downloads to the
// Mini IDM program, which decides what to capture (Options > File types).
// 1. Downloads the browser starts on its own (chrome.downloads.onCreated).
// 2. Clicks on file links (content.js), before the browser requests the URL,
//    so one-time links are not used up.
// 3. Right-click "Download with Mini IDM".
// 4. Media and files seen in page traffic (webRequest, observe only), listed
//    in the popup and never downloaded automatically.

import { server, ping, refreshConfig, capture, detectedKey } from './lib.js';

// ---------- startup ----------

async function setup() {
  await ping();
  const config = await refreshConfig();
  await chrome.contextMenus.removeAll();
  if (config?.contextMenu !== false) {
    chrome.contextMenus.create({ id: 'mini-idm-link', title: chrome.i18n.getUILanguage().startsWith('pt') ? 'Baixar com o Mini IDM' : 'Download with Mini IDM', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'mini-idm-media', title: chrome.i18n.getUILanguage().startsWith('pt') ? 'Baixar esta mídia com o Mini IDM' : 'Download this media with Mini IDM', contexts: ['video', 'audio'] });
  }
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
setup(); // each time the service worker wakes up
// The program's settings can change; pick them up every few minutes.
chrome.alarms?.create('refresh', { periodInMinutes: 2 });
// A short hello every 30 s keeps "Connected" showing in the program's status bar.
chrome.alarms?.create('ping', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'refresh') setup(); else if (a.name === 'ping') ping(); });

// ---------- 1. Browser-initiated downloads ----------

chrome.downloads.onCreated.addListener(async (item) => {
  if (item.byExtensionId === chrome.runtime.id) return; // our own fallback download
  if (item.state !== 'in_progress') return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return; // blob:, data:, filesystem: only exist inside the browser

  // Hand off first; cancel only after Mini IDM accepted it. A cancelled
  // download can't be resumed, so if Mini IDM is closed the browser keeps it.
  let accepted = false;
  try {
    accepted = await capture({ url, filename: (item.filename || '').split(/[\\/]/).pop(), mime: item.mime, referrer: item.referrer, kind: 'auto' });
  } catch {
    return;
  }
  if (!accepted) return;
  await chrome.downloads.cancel(item.id).catch(() => {});
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
});

// ---------- 2. Link clicks and 3. the right-click menu ----------

// If Mini IDM is not running (or doesn't want the file), the click still
// works: the browser downloads it the normal way.
async function sendOrFallback({ url, filename, referrer, kind }) {
  let accepted = false;
  try {
    accepted = await capture({ url, filename, referrer, kind });
  } catch { /* Mini IDM is not running */ }
  if (accepted) return { ok: true };
  const opts = { url };
  if (filename && !/[\\/]/.test(filename)) opts.filename = filename;
  await chrome.downloads.download(opts).catch(() => chrome.downloads.download({ url }));
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'click' && sender.tab) {
    sendOrFallback({ url: msg.url, filename: msg.filename, referrer: msg.referrer, kind: 'click' }).then(reply);
    return true; // async reply
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === 'mini-idm-link' ? info.linkUrl : info.srcUrl;
  if (url && /^https?:/i.test(url)) sendOrFallback({ url, referrer: info.pageUrl, kind: 'menu' });
});

// ---------- 3. Detect media and files in page traffic ----------

const FILE_TYPES = new Set([
  'application/octet-stream', 'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed',
  'application/vnd.rar', 'application/x-7z-compressed', 'application/gzip', 'application/x-tar',
  'application/x-msdownload', 'application/x-msi', 'application/x-apple-diskimage', 'application/vnd.android.package-archive',
  'application/x-iso9660-image', 'application/x-bittorrent', 'application/vnd.debian.binary-package', 'application/x-rpm'
]);
// HLS/DASH manifests are listed so you can see them. Downloading them needs a
// segment reassembler (out of scope for v1).
const STREAM_TYPES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'application/dash+xml']);
const MIN_MEDIA_BYTES = 512 * 1024; // ignore tiny clips, previews and stream segments
const MAX_PER_TAB = 50;

const tabLists = new Map(); // tabId -> Promise<Array>, cached copy of storage.session

function loadTab(tabId) {
  if (!tabLists.has(tabId)) {
    tabLists.set(tabId, chrome.storage.session.get(detectedKey(tabId)).then(r => r[detectedKey(tabId)] || []));
  }
  return tabLists.get(tabId);
}

async function record(tabId, entry) {
  const list = await loadTab(tabId);
  const existing = list.find(e => e.url === entry.url);
  if (existing) Object.assign(existing, entry);
  else {
    list.unshift(entry);
    list.length = Math.min(list.length, MAX_PER_TAB);
  }
  await chrome.storage.session.set({ [detectedKey(tabId)]: list });
  chrome.action.setBadgeText({ tabId, text: String(list.length) }).catch(() => {});
}

async function clearTab(tabId) {
  tabLists.delete(tabId);
  await chrome.storage.session.remove(detectedKey(tabId));
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

function filenameFrom(disposition, url) {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition || '');
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* ignore */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition || '');
  if (plain) return plain[1];
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || new URL(url).hostname; } catch { return url; }
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const h = {};
  for (const { name, value } of d.responseHeaders || []) h[name.toLowerCase()] = value || '';
  const type = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  const disposition = h['content-disposition'] || '';
  const total = Number(/\/(\d+)$/.exec(h['content-range'] || '')?.[1] || h['content-length'] || 0);

  let kind = null;
  if (/^\s*attachment/i.test(disposition)) kind = 'file';
  else if (STREAM_TYPES.has(type)) kind = 'stream';
  else if (/^(video|audio)\//.test(type) && type !== 'video/mp2t') kind = total && total < MIN_MEDIA_BYTES ? null : 'media';
  else if (FILE_TYPES.has(type) && (d.type === 'main_frame' || d.type === 'sub_frame' || total >= MIN_MEDIA_BYTES)) kind = 'file';
  if (!kind) return;

  server().then((base) => {
    if (d.url.startsWith(base)) return;
    record(d.tabId, { url: d.url, kind, type, size: total || 0, filename: filenameFrom(disposition, d.url), referrer: d.initiator || '', seenAt: Date.now() });
  });
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
