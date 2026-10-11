// Shared by the service worker, popup and options page.

export const DEFAULTS = {
  server: 'http://127.0.0.1:7878',
  token: '',
  captureDownloads: true,
  captureClicks: true
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

export async function api(path, opts = {}, settings) {
  const s = settings || await getSettings();
  return fetch(s.server.replace(/\/+$/, '') + path, {
    ...opts,
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

// Cookies come from chrome.cookies, which includes HttpOnly cookies that
// document.cookie can't see. Partitioned (CHIPS) cookies need the top-level
// site, which is taken from the referrer.
async function cookieHeader(url, referrer) {
  const jars = [chrome.cookies.getAll({ url }).catch(() => [])];
  try {
    const top = new URL(referrer).origin;
    jars.push(chrome.cookies.getAll({ url, partitionKey: { topLevelSite: top } }).catch(() => []));
  } catch { /* no referrer */ }
  const seen = new Map();
  for (const c of (await Promise.all(jars)).flat()) seen.set(c.name, c.value);
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function buildHeaders(url, referrer) {
  const headers = { 'User-Agent': navigator.userAgent };
  const cookie = await cookieHeader(url, referrer);
  if (cookie) headers.Cookie = cookie;
  if (referrer && /^https?:/.test(referrer)) headers.Referer = referrer;
  return headers;
}

export async function sendToServer({ url, filename, referrer }) {
  const s = await getSettings();
  if (!s.token) throw new Error('No server token set. Open the extension options.');
  const headers = await buildHeaders(url, referrer);
  // interactive: the server may ask where to save, via its dialog window.
  const r = await api('/api/downloads', { method: 'POST', body: JSON.stringify({ url, filename: filename || undefined, headers, interactive: true }) }, s);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `server answered ${r.status}`);
  if (body.dialogUrl) openDialog(s.server.replace(/\/+$/, '') + body.dialogUrl);
  return body;
}

// IDM-style small window: "Download File Info", then progress, then "complete".
export function openDialog(url) {
  const width = 560;
  const height = 520;
  return chrome.windows.create({ url, type: 'popup', width, height, focused: true }).catch(() => chrome.tabs.create({ url }));
}

export function fmtBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const detectedKey = (tabId) => `detected:${tabId}`;
