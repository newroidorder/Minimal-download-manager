// Isolated-world content script. DOM click events are visible here, and so is
// chrome.runtime. (A "world": "MAIN" script would have no chrome.runtime.)
//
// It catches plain left-clicks on links to the file types chosen in Minimal Download Manager
// (Options > File types) and hands them over before the browser requests the
// URL. Holding the bypass key (Alt by default) lets the browser download it.
// If Minimal Download Manager can't take it, the browser downloads it the normal way.

(() => {
  const FALLBACK = 'zip rar 7z gz tar iso exe msi apk dmg mp4 mkv avi mov mp3 flac wav pdf'.split(' ');
  let exts = new Set(FALLBACK);
  let bypassKey = 'alt';

  const refresh = () => chrome.storage.local.get('config')
    .then(({ config }) => {
      if (Array.isArray(config?.captureExts)) exts = new Set(config.captureExts);
      bypassKey = config?.bypassKey || 'alt';
    })
    .catch(() => {});
  refresh();
  chrome.storage.onChanged.addListener(refresh);

  const extOf = (path) => { const m = /\.([a-z0-9]{1,10})$/i.exec(path); return m ? m[1].toLowerCase() : ''; };

  // Bubble phase on window: runs after the page's own handlers, so links the
  // page already handles (e.defaultPrevented) are left alone.
  window.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    if ((bypassKey === 'alt' && e.altKey) || (bypassKey === 'shift' && e.shiftKey)) return;
    if (e.altKey || e.shiftKey) return; // other modifier clicks keep their browser meaning
    const a = e.target instanceof Element && e.target.closest('a[href]');
    if (!a) return;
    let url;
    try { url = new URL(a.href); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
    if (!exts.has(extOf(path))) return;

    try {
      chrome.runtime.sendMessage({ type: 'click', url: url.href, filename: a.getAttribute('download') || null, referrer: location.href })
        .catch(() => {});
    } catch {
      return; // the extension was reloaded; this page's script is orphaned, so let the browser handle it
    }
    e.preventDefault();
  });
})();
