'use strict';

// Site Explorer: explores a web page (and, up to a depth, the pages it links
// to on the same site) and lists the files that match the chosen types.

const { extOf } = require('./settings');

const LINK_RE = /\b(?:href|src|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const SRCSET_RE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractLinks(html, baseUrl) {
  const base = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html);
  const root = base ? new URL(decodeEntities(base[1]), baseUrl).href : baseUrl;
  const out = new Set();
  const add = (raw) => {
    const v = decodeEntities(raw.trim());
    if (!v || /^(javascript|mailto|tel|data|blob):/i.test(v) || v.startsWith('#')) return;
    try {
      const u = new URL(v, root);
      if (u.protocol === 'http:' || u.protocol === 'https:') { u.hash = ''; out.add(u.href); }
    } catch { /* ignore */ }
  };
  for (const m of html.matchAll(LINK_RE)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of html.matchAll(SRCSET_RE)) for (const part of (m[1] ?? m[2]).split(',')) add(part.trim().split(/\s+/)[0]);
  return [...out];
}

/**
 * fetchPage(url) -> { url, contentType, text } (text only for HTML pages)
 * options: { depth 0-3, exts [], sameSite, maxPages, signal, onPage(url, found) }
 */
async function grab(startUrl, fetchPage, { depth = 1, exts = [], sameSite = true, maxPages = 200, signal, onPage } = {}) {
  const want = new Set(exts.map(e => e.toLowerCase()));
  const startHost = new URL(startUrl).hostname;
  const seen = new Set([startUrl]);
  const files = new Map();
  let level = [startUrl];
  let pages = 0;

  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const url of level) {
      if (signal?.aborted || pages >= maxPages) break;
      let page;
      try { page = await fetchPage(url); } catch { continue; }
      pages++;
      if (!/html/i.test(page.contentType || '') || typeof page.text !== 'string') continue;
      for (const link of extractLinks(page.text, page.url || url)) {
        const u = new URL(link);
        let ext = '';
        try { ext = extOf(decodeURIComponent(u.pathname)); } catch { ext = extOf(u.pathname); }
        if (ext && want.has(ext)) {
          if (!files.has(link)) {
            let name = u.pathname.split('/').pop() || u.hostname;
            try { name = decodeURIComponent(name); } catch { /* keep raw */ }
            files.set(link, { url: link, name, ext, page: url });
          }
        } else if (d < depth && !seen.has(link) && (!sameSite || u.hostname === startHost) && (!ext || /^(html?|php|aspx?|jsp)$/.test(ext))) {
          seen.add(link);
          next.push(link);
        }
      }
      onPage?.(url, files.size);
    }
    level = next;
  }
  return { files: [...files.values()], pages };
}

module.exports = { grab, extractLinks };
