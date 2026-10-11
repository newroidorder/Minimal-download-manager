# Review of the first draft

The first draft of this project (written before this repository existed) "worked" against one
well-behaved test server. Run against servers that misbehave, it failed in ways that corrupt files or
leak data. Each issue below has a test in this repository that would catch it.

## Downloader

| Issue in the draft | Observed | Fix | Test |
|---|---|---|---|
| Never checked for `206` on Range requests | Server that ignores Range: **24 MB file for 3 MB of data**, marked done | Probe with `bytes=0-`; trust ranges only on `206` + `Content-Range`; check every segment | `server that advertises but ignores Range` |
| Never checked status codes | 404 HTML page saved as `file.zip`, marked done | ≥ 400 is an error; nothing left on disk | `HTTP 404 is an error` |
| Forwarded headers on every redirect | Session cookie sent to a different host | Strip Cookie/Authorization on cross-origin redirects | `cookies are dropped on cross-origin redirects` |
| Ignored `Content-Disposition` | `/attach?id=7` saved as `attach` | `filename*=` > `filename=` > URL path | `Content-Disposition filename* is honored` |
| Fixed 8 equal parts, then a merge | Not "dynamic segmentation"; double disk I/O | Work stealing + in-place positional writes | `ranged file: parallel segments` |
| No retry, no timeout | One stalled socket hangs forever | 30 s idle timeout, per-segment retry from last written byte | `dropped connections are retried` |
| No pause/resume despite being IDM's core feature | n/a | Segment map in `.part.json`, `If-Range` on resume | `pause keeps progress; resume continues` |
| Same filename overwrote | Two `setup.exe` downloads clobber each other | Atomic `wx` creation of `.part`, `name (1).ext` | `same name: concurrent and later downloads` |
| HEAD for metadata | Signed/S3 URLs often refuse HEAD | GET probe that is reused as the first segment | covered by all of the above |

## Server

| Issue | Fix | Test |
|---|---|---|
| `Access-Control-Allow-Origin: *`, no authentication. Any website could queue downloads and read your history | Bearer token, no CORS headers, foreign-Origin rejection, Host check | `API requires the token`, `foreign Origin is rejected`, `DNS rebinding` |
| `innerHTML` with filenames from the request body: XSS on the localhost UI | `textContent` only + strict CSP | `UI is served with a strict CSP` (+ manual check with an `<img onerror>` filename) |
| Every POST started immediately | Queue with max active downloads | `queue limits concurrency` |
| Queue lost on restart | Atomic JSON persistence; interrupted downloads come back paused | `survives a restart` |
| Accepted any URL scheme | `http:`/`https:` only | `only http(s) URLs are accepted` |

## Extension

| Issue | Fix | Test (e2e) |
|---|---|---|
| Content script in `world: "MAIN"` called `chrome.runtime.sendMessage`, which doesn't exist there, so every hook silently did nothing, and the click handler had already called `preventDefault()` | Isolated-world script (DOM click events are visible there) | `link click is captured` |
| XHR/fetch hooks would have auto-downloaded every `.mp4`/`.pdf` a page fetched | Observe-only `webRequest` detection, listed in the popup | `video on the page is detected (not auto-downloaded)` |
| `cancel()` then `resume()` as fallback: a cancelled Chrome download can't be resumed, so the file was lost when the server was down | Send first, cancel only after the server accepts | `browser-started download is taken over` |
| Clicks lost when the server was down | Fallback to `chrome.downloads.download` | `server rejects the request: … falls back` |
| `blob:`/`data:` downloads cancelled and sent to a server that can't fetch them | Skipped | n/a |
| Extension-filename filter ran on `item.filename`, which is empty at `onCreated` | Removed; server uses `Content-Disposition` | n/a |
| Unused `tabs` permission | Permissions match what the code uses | n/a |

## Analysis (Phase 1)

The draft presented guesses based on file names as facts and never split its claims into proven,
inferred and hidden, which is what the task asked for. It skipped the most useful step (unpacking
`IDMGCExt.crx`, a ZIP of readable JavaScript), and it claimed the WFP driver could capture DRM streams,
which a network driver can't, since it only sees TLS ciphertext. `docs/PROMPT.md` restates Phase 1 with
evidence tagging, a static-then-dynamic method, and these pitfalls listed.
