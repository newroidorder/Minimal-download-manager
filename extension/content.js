// Isolated-world content script. DOM click events are visible here, and so is
// chrome.runtime. (A "world": "MAIN" script would have no chrome.runtime.)
//
// It catches plain left-clicks on links that look like files and hands them to
// the background before the browser requests the URL. If the server can't take
// the download, the background starts a normal browser download instead, so a
// click is never lost.

(() => {
  const FILE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|img|exe|msi|dmg|pkg|deb|rpm|apk|appimage|mp4|mkv|avi|mov|wmv|webm|flv|mp3|flac|wav|m4a|ogg|torrent)$/i;
  let enabled = false;

  const refresh = () => chrome.storage.local.get(['captureClicks', 'token'])
    .then(s => { enabled = s.captureClicks !== false && !!s.token; })
    .catch(() => { enabled = false; });
  refresh();
  chrome.storage.onChanged.addListener(refresh);

  // Bubble phase on window: runs after the page's own handlers, so links the
  // page already handles (e.defaultPrevented) are left alone.
  window.addEventListener('click', (e) => {
    if (!enabled || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element && e.target.closest('a[href]');
    if (!a) return;
    let url;
    try { url = new URL(a.href); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (!a.hasAttribute('download') && !FILE_EXT.test(url.pathname)) return;

    try {
      chrome.runtime.sendMessage({ type: 'click', url: url.href, filename: a.getAttribute('download') || null, referrer: location.href })
        .catch(() => {});
    } catch {
      return; // extension was reloaded; this page's script is orphaned, so let the browser handle it
    }
    e.preventDefault();
  });
})();
