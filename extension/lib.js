// Shared by the service worker and the popup. The extension has no settings:
// the Minimal Download Manager program decides what to capture (Options > File types).

const DEFAULT_SERVER = 'http://127.0.0.1:7878';

// Tests can point the extension elsewhere; normal installs never set this.
export async function server() {
  const { server: s } = await chrome.storage.local.get('server');
  return (s || DEFAULT_SERVER).replace(/\/+$/, '');
}

export function browserName() {
  const brands = (navigator.userAgentData?.brands || []).map(b => b.brand);
  if (brands.includes('Opera') || /OPR\//.test(navigator.userAgent)) return 'opera';
  if (brands.includes('Microsoft Edge') || /Edg\//.test(navigator.userAgent)) return 'edge';
  if (brands.includes('Brave') || navigator.brave) return 'brave';
  if (/Vivaldi/.test(navigator.userAgent)) return 'vivaldi';
  return 'chrome';
}

async function api(path, opts = {}) {
  const r = await fetch((await server()) + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// Is Minimal Download Manager running? Also tells it which browser is connected.
export async function ping() {
  try {
    return await api(`/api/ping?browser=${browserName()}`);
  } catch {
    return null;
  }
}

// Settings from the program, cached for the content script and menus.
export async function refreshConfig() {
  try {
    const config = await api('/api/config');
    await chrome.storage.local.set({ config });
    return config;
  } catch {
    return (await chrome.storage.local.get('config')).config || null;
  }
}

// Cookies come from chrome.cookies, which includes HttpOnly cookies that
// document.cookie can't see. Partitioned (CHIPS) cookies need the top-level
// site, which is taken from the referrer.
async function cookieHeader(url, referrer) {
  const jars = [chrome.cookies.getAll({ url }).catch(() => [])];
  try {
    jars.push(chrome.cookies.getAll({ url, partitionKey: { topLevelSite: new URL(referrer).origin } }).catch(() => []));
  } catch { /* no referrer */ }
  const seen = new Map();
  for (const c of (await Promise.all(jars)).flat()) seen.set(c.name, c.value);
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Hands a download to Minimal Download Manager. kind: 'auto' (the browser started it),
 * 'click', 'menu' or 'detected'. Resolves to true when Minimal Download Manager took it,
 * false when its rules say the browser should keep it; throws when Minimal Download Manager
 * isn't running.
 */
export async function capture({ url, filename, mime, referrer, kind }) {
  const headers = { 'User-Agent': navigator.userAgent };
  const cookie = await cookieHeader(url, referrer);
  if (cookie) headers.Cookie = cookie;
  if (referrer && /^https?:/.test(referrer)) headers.Referer = referrer;
  const r = await api('/api/capture', {
    method: 'POST',
    body: JSON.stringify({ url, filename: filename || undefined, mime: mime || undefined, referrer, kind, browser: browserName(), headers })
  });
  return r.accepted === true;
}

export function fmtBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const detectedKey = (tabId) => `detected:${tabId}`;
