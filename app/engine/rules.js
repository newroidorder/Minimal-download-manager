'use strict';

// Decisions IDM makes from its Options: which browser downloads to capture
// (File types tab), and which login to send to which site (Sites & users tab).

const { extOf } = require('./settings');

const MIME_EXT = {
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-rar-compressed': 'rar', 'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z', 'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-tar': 'tar',
  'application/x-msdownload': 'exe', 'application/x-msi': 'msi', 'application/x-ms-installer': 'msi',
  'application/vnd.android.package-archive': 'apk', 'application/x-iso9660-image': 'iso', 'application/pdf': 'pdf',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi'
};

// "*.example.com" matches example.com and every subdomain; "example.com" matches exactly.
function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  const h = String(host).toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

// "*" wildcards in a full URL pattern.
function urlMatches(pattern, url) {
  const re = new RegExp('^' + String(pattern).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(url);
}

function fileExt({ url, filename, mime }) {
  let ext = extOf(filename);
  if (!ext) { try { ext = extOf(decodeURIComponent(new URL(url).pathname)); } catch { /* bad URL */ } }
  if (!ext && mime) ext = MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
  return ext;
}

// kind: 'auto' (browser started it), 'click' (link click), or an explicit user
// action ('menu', 'detected', 'manual'), which is always accepted.
function captureDecision(settings, { url, filename, mime, browser, kind }) {
  if (kind !== 'auto' && kind !== 'click') return { capture: true };
  if (browser && settings.general.browsers[browser] === false) return { capture: false, reason: 'browser disabled' };
  let host = '';
  try { host = new URL(url).hostname; } catch { return { capture: false, reason: 'bad URL' }; }
  if (settings.fileTypes.excludeSites.some(p => hostMatches(p, host))) return { capture: false, reason: 'site excluded' };
  if (settings.fileTypes.excludeUrls.some(p => urlMatches(p, url))) return { capture: false, reason: 'address excluded' };
  const ext = fileExt({ url, filename, mime });
  // Generic binary with no known extension: IDM still treats it as a file.
  if (!ext && /^application\/(octet-stream|force-download|x-download)/i.test(mime || '')) return { capture: true };
  if (!settings.fileTypes.capture.includes(ext)) return { capture: false, reason: ext ? `.${ext} is not in the file types list` : 'unknown file type' };
  return { capture: true };
}

// Sites & users: "example.com", "*.example.com" or "example.com/private/".
// A saved login is only sent over HTTPS, so it can't be read on the way.
// The one exception is a site the user entered as "http://..." on purpose
// (an old router or NAS on the local network).
function credentialsFor(sites, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  let best = null;
  for (const s of sites) {
    const plainHttp = /^http:\/\//i.test(s.site);
    if (u.protocol === 'http:' && !plainHttp) continue;
    if (u.protocol === 'https:' && plainHttp) continue;
    const raw = s.site.replace(/^https?:\/\//i, '');
    const slash = raw.indexOf('/');
    const host = slash >= 0 ? raw.slice(0, slash) : raw;
    const prefix = slash >= 0 ? raw.slice(slash) : '/';
    if (!hostMatches(host, u.hostname) || !u.pathname.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, s };
  }
  return best ? 'Basic ' + Buffer.from(`${best.s.user}:${best.s.pass}`).toString('base64') : null;
}

module.exports = { captureDecision, credentialsFor, hostMatches, urlMatches, fileExt };
