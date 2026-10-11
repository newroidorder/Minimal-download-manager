// Three capture paths, in order of how IDM's own extension behaves:
// 1. Downloads the browser starts on its own (chrome.downloads.onCreated).
// 2. Link clicks on file-looking links (content.js), so the browser never
//    spends a one-time download URL itself.
// 3. Media/file responses seen on the page (webRequest, observe only). These
//    are listed in the popup and are never downloaded automatically.

import { getSettings, sendToServer, detectedKey } from './lib.js';

// ---------- 1. Browser-initiated downloads ----------

chrome.downloads.onCreated.addListener(async (item) => {
  if (item.byExtensionId === chrome.runtime.id) return; // our own fallback download
  if (item.state !== 'in_progress') return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return; // blob:, data:, filesystem: only exist inside the browser

  const s = await getSettings();
  if (!s.captureDownloads || !s.token) return;

  // Hand off first, and cancel only after the server has accepted it.
  // A cancelled Chrome download can't be resumed, so this order never loses a file.
  try {
    await sendToServer({ url, referrer: item.referrer });
  } catch {
    return;
  }
  await chrome.downloads.cancel(item.id).catch(() => {});
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
});

// ---------- 2. Link clicks (from content.js) and the context menu ----------

async function sendOrFallback({ url, filename, referrer }) {
  try {
    await sendToServer({ url, filename, referrer });
    return { ok: true };
  } catch (err) {
    // The click was already cancelled, so let the browser download it instead.
    const opts = { url };
    if (filename && !/[\\/]/.test(filename)) opts.filename = filename;
    await chrome.downloads.download(opts).catch(() => chrome.downloads.download({ url }));
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'click' && sender.tab) {
    sendOrFallback({ url: msg.url, filename: msg.filename, referrer: msg.referrer }).then(reply);
    return true; // async reply
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'mini-idm-link', title: 'Download link with Mini IDM', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'mini-idm-media', title: 'Download this media with Mini IDM', contexts: ['video', 'audio'] });
  getSettings().then(s => { if (!s.token) chrome.runtime.openOptionsPage(); });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === 'mini-idm-link' ? info.linkUrl : info.srcUrl;
  if (url && /^https?:/i.test(url)) sendOrFallback({ url, referrer: info.pageUrl });
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

  getSettings().then(s => {
    if (d.url.startsWith(s.server)) return;
    record(d.tabId, { url: d.url, kind, type, size: total || 0, filename: filenameFrom(disposition, d.url), referrer: d.initiator || '', seenAt: Date.now() });
  });
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
