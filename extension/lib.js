// Used by the service worker. The extension has no settings: the Minimal
// Download Manager program decides what to capture (Options > File types).
//
// The program is reached through native messaging (com.minimaldm.bridge, which
// the program registers on start). If the browser can't
// start the host, the old 127.0.0.1:7878 connection is tried, which only
// answers when it is switched on in the program (Options > General).

const HOST = 'com.minimaldm.bridge';
const DEFAULT_SERVER = 'http://127.0.0.1:7878';
const TIMEOUT_MS = 15_000;

// Tests can point the HTTP fallback elsewhere; normal installs never set this.
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

// ---------- native messaging ----------

let port = null;
let hostWorks = false;       // the host answered at least once on this port
let hostMissing = 0;         // when the browser last failed to start the host
let app = { running: false, version: null };
let seq = 0;
const pending = new Map();   // id -> { resolve, reject, timer }
const waiters = new Set();   // resolve() when the first status arrives
const configListeners = new Set();

export const onConfig = (fn) => configListeners.add(fn);

function connect() {
  if (port) return port;
  if (hostMissing && Date.now() - hostMissing < 60_000) return null;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    hostMissing = Date.now();
    return null;
  }
  hostWorks = false;
  port.onMessage.addListener((msg) => {
    hostWorks = true;
    if (msg.type === 'status') {
      app = { running: !!msg.running, version: msg.version || null };
      for (const w of waiters) w();
      waiters.clear();
    } else if (msg.type === 'config') {
      chrome.storage.local.set({ config: msg.config });
      for (const fn of configListeners) fn(msg.config);
    } else if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // "Specified native messaging host not found." and the like
    if (!hostWorks) hostMissing = Date.now();
    port = null;
    app = { running: false, version: null };
    for (const w of waiters) w();
    waiters.clear();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('disconnected')); }
    pending.clear();
  });
  port.postMessage({ type: 'hello', browser: browserName() });
  return port;
}

// Resolves once the host has said whether the program is running.
function hostReady(p) {
  if (hostWorks) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    waiters.add(() => { clearTimeout(t); resolve(); });
    if (!p) resolve();
  });
}

function nativeRequest(p, type, body) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    p.postMessage({ id, type, body });
  });
}

// ---------- HTTP fallback ----------

async function httpRequest(type, body) {
  const paths = { ping: `/api/ping?browser=${browserName()}`, config: '/api/config', capture: '/api/capture' };
  const opts = type === 'capture' ? { method: 'POST', body: JSON.stringify({ ...body, browser: browserName() }) } : {};
  const r = await fetch((await server()) + paths[type], { ...opts, headers: { 'Content-Type': 'application/json' } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

async function request(type, body) {
  const p = connect();
  await hostReady(p);
  if (port && hostWorks) {
    if (!app.running) throw new Error('not-running');
    return nativeRequest(port, type, body);
  }
  return httpRequest(type, body);
}

// Opens the connection early so the program shows the browser as connected.
export function keepConnected() { connect(); }

// Is Minimal Download Manager running? Also tells it which browser is connected.
export async function ping() {
  try {
    return await request('ping');
  } catch {
    return null;
  }
}

// Settings from the program, cached for the content script and menus.
export async function refreshConfig() {
  try {
    const config = await request('config');
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
  // Cookies only go along when the program asks for them (Options > General).
  const { config } = await chrome.storage.local.get('config');
  if (config?.sendCookies !== false) {
    const cookie = await cookieHeader(url, referrer);
    if (cookie) headers.Cookie = cookie;
  }
  if (referrer && /^https?:/.test(referrer)) headers.Referer = referrer;
  const r = await request('capture', { url, filename: filename || undefined, mime: mime || undefined, referrer, kind, headers });
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
