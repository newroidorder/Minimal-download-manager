# Task: Analyze Internet Download Manager (IDM) and build a minimal clone

## Ground rules

- This is learning/interoperability analysis of my own licensed install. Do not copy IDM code,
  binaries, strings, or icons into the clone. (IDM's EULA restricts reverse engineering, so keep to
  observation and black-box behaviour.)
- Tag every claim in the analysis:
  - **[PROVEN]**: give the evidence (file + string/offset, manifest field, registry key, command output, packet capture).
  - **[INFERRED]**: give the reasoning chain and what would confirm it.
  - **[HIDDEN]**: say what you couldn't see and what tool or access would reveal it.
- A file name is not evidence of what the file does. "idmfsa.dll = file segmentation assembly" is a guess until imports, exports, or behaviour back it up.

## Phase 1: Analysis

Find IDM in my Desktop folder. If it isn't there, use `C:\Program Files (x86)\Internet Download Manager`.
Record the exact version from the file properties.

### Static analysis (do these first: cheapest, and they give proof)

1. **Inventory**: every file with its size, version info, and Authenticode signer (`sigcheck -a`). For
   each .exe/.dll/.sys, record imports and exports (Detect-It-Easy, PE-bear or `dumpbin /imports /exports`).
   Group the files by what their imports show (WinHTTP/WinSock/OpenSSL = network, Fwps*/Fwpm* = WFP
   callout driver, CreateNamedPipe/ConnectNamedPipe = pipe IPC, SetWindowsHookEx/CreateRemoteThread =
   injection, and so on).
2. **Unpack the browser extensions.** `.crx` is a ZIP with a header in front (7-Zip opens it), and `.xpi` is a plain ZIP.
   Read `manifest.json` (MV2 or MV3, permissions, background, content_scripts and their `world`,
   `externally_connectable`) and the JavaScript. **This is the most important step.** The browser-side capture
   logic is readable source code, so most of "how it captures links/downloads/videos" can be PROVEN here
   instead of guessed.
3. **Native messaging**: `IDMMsgHost.json` / `IDMMsgHostMoz.json` plus the registry keys that point to them. From the
   extension JS, document the real message schema sent to `com.tonec.idm` (message types, field names,
   and whether cookies, referrer, user agent and POST data are included).
4. **Strings** in IDMMsgHost.exe and IDMan.exe: pipe names, window class names, `WM_COPYDATA` usage,
   registry paths, HTTP header templates, temp-folder names.
5. **Drivers**: are `idmwfp*.sys` / `idmtdi*.sys` actually installed and running (`sc query`, `driverquery`)?
   What do their imports show? State only what is visible. Remember that a kernel network driver sees **encrypted**
   HTTPS bytes. It cannot read URLs inside TLS, and it cannot capture DRM-protected (Widevine) media.
6. Use **REA** for disassembly only where steps 1–5 leave gaps, and cite function addresses.

### Dynamic analysis (with IDM running)

- **Process Explorer**: is IDMNetMon.dll actually loaded into chrome.exe/msedge.exe/firefox.exe? Verify it; don't
  assume. Check IDMan's open handles for `\Device\NamedPipe\...`.
- **Pipe list**: `[System.IO.Directory]::GetFiles("\\.\pipe\")` with IDM running and with it stopped.
- **Process Monitor** filtered on IDMan.exe and IDMMsgHost.exe during one download: where segment and temp files
  go, which registry keys hold settings, and who launches whom.
- **Wireshark** against a plain-HTTP server I control: how many parallel TCP connections, the exact `Range`
  headers, and whether new Range requests appear mid-download when a connection finishes. That last one
  proves or disproves "dynamic segmentation".
- **Extension DevTools** (chrome://extensions → IDM service worker → inspect): log the `connectNative`/`postMessage`
  traffic while clicking a download link and while playing a video.

### Official website

Use internetdownloadmanager.com (features page, version history) only for claims the binaries can't show,
and cite the URL for each one.

### Phase 1 deliverable

1. Architecture diagram. Mark every arrow PROVEN or INFERRED.
2. Capture flows for: (a) clicking a normal link, (b) a download the browser starts on its own, (c) a video
   playing on a page, (d) a download started outside any browser.
3. Three tables: Proven / Inferred / Hidden.

## Phase 2: Minimal clone

Node.js ≥ 18, zero runtime dependencies, Chrome MV3 extension. Small enough to read in one sitting.

### Downloader (the core; most of the effort goes here)

- **Probe with GET + `Range: bytes=0-`, not HEAD.** Signed or S3 URLs often refuse HEAD. Ranges are supported
  only if the response is `206` with `Content-Range: bytes 0-N/TOTAL`. A `200` means no ranges, so stream it as one
  connection. Keep the probe response as the first segment's data.
- **Check every status code.** ≥ 400 is an error, never a "done" file containing an HTML error page.
- **Check every segment response** is `206` and that its Content-Range starts at the requested byte.
- **Follow redirects once** during the probe and reuse the final URL for every segment. **Remove Cookie and
  Authorization** when a redirect changes origin.
- **Dynamic segmentation**, like IDM: when a connection becomes free, split the largest remaining segment in half
  (minimum remainder 2 MB). Up to 8 connections.
- **Write in place** into a pre-sized `<name>.part` file with positional writes, so there is no merge step and no
  double disk usage. Rename to the final name when the byte count matches the size.
- **Per-segment retry** with backoff, resuming from that segment's last written byte. Idle timeout 30 s.
- **Filenames**: request body > `Content-Disposition` (`filename*=` UTF-8 first) > URL path (percent-decoded).
  Sanitize the result. Never overwrite: use `name (1).ext`.
- **Progress events** limited to 4/s, with bytes received, speed, and active connections.
- **Cancel** aborts all sockets and removes the `.part` file.
- **Resume after restart (stretch goal):** every few seconds, save the segment map plus ETag/Last-Modified to
  `<name>.part.json`. On resume, send `If-Range`. If the server answers 200, restart from zero.

### Local server

- Bind to `127.0.0.1` only. **Authenticate every request**: generate a random token on first run and keep it
  in a config file; the extension sends `Authorization: Bearer <token>`. Allow CORS only for
  `chrome-extension://<id>`, never `*`. Reject requests whose `Host` header isn't `127.0.0.1:PORT` or
  `localhost:PORT` (DNS rebinding).
  Without this, any website you visit can queue downloads and read your download history.
- Accept only `http:`/`https:` URLs.
- Queue with a maximum number of active downloads (3). Endpoints: `POST /download`, `GET /queue`, `GET /events`
  (SSE), `POST /downloads/:id/cancel`, `POST /downloads/:id/retry`, `DELETE /downloads/:id`. Save the queue
  (without cookies) to a JSON file with atomic writes.
- Web UI: render all data with `textContent`, never `innerHTML`, because filenames and URLs come from
  attackers. Send a strict CSP header.

### Extension

- **Detect from response headers like a download manager does.** In the background, use
  `chrome.webRequest.onHeadersReceived` (observe only) to flag responses with `Content-Disposition: attachment`,
  `video/*`, `audio/*`, `application/octet-stream`, or archive MIME types. Store them per tab and list them in
  the popup with a "Download" button. Detected media is **never** downloaded automatically.
- **Browser-started downloads** (`chrome.downloads.onCreated`): skip `blob:`, `data:` and `filesystem:` URLs. POST to the server
  **first**, and call `chrome.downloads.cancel` + `erase` only after the server answers 2xx. A cancelled Chrome
  download cannot be resumed, so "cancel, then resume on failure" loses the file.
- **Link clicks**: if a page script is used, remember that `world: "MAIN"` scripts have **no `chrome.runtime`**.
  Use a MAIN-world script that `window.postMessage`s to an ISOLATED-world script, which relays to the background.
  If the server rejects a captured click, fall back to `chrome.downloads.download({ url })` so the click is
  never lost.
- Cookies: `chrome.cookies.getAll({ url })` (also pass `partitionKey` for partitioned cookies). Send the referrer
  and user agent too.
- Request only the permissions that are used: `downloads`, `cookies`, `webRequest`, `storage`, plus host permissions.
- Options page for the server token.

### Tests (required; "it downloaded a file from proof.ovh.net" is not enough)

Write `test.js`, which starts a local HTTP server and checks:

1. A 20 MB ranged file: SHA-256 matches, and at least 4 parallel connections were seen.
2. Connections dropped mid-segment: retries resume, and the SHA-256 matches.
3. HEAD says `Accept-Ranges` but GET ignores Range: the file is the correct size (not N× the size).
4. 404: status `error`, no file left on disk.
5. Cross-origin redirect: the Cookie header is not forwarded.
6. `Content-Disposition: filename*=UTF-8''r%C3%A9sum%C3%A9.pdf` is saved as `résumé.pdf`.
7. Two downloads with the same name do not overwrite each other.
8. Cancel: status `cancelled`, `.part` removed.
9. Server: a request without the token gets 401, and an `Origin: https://evil.example` request gets no CORS grant.

### Out of scope for v1 (say so in the README)

HLS/DASH reassembly (needs ffmpeg plus a manifest parser), scheduler, site grabber, FTP, DRM content
(not possible), and capturing traffic from apps outside the browser.

### v2 option: native messaging instead of an open port

A ~40-line Node native host (`com.myidm.host`, stdio, 4-byte little-endian length + JSON) registered under
`HKCU\Software\Google\Chrome\NativeMessagingHosts`. This mirrors IDM's real design. Chrome restricts
the host to the extension IDs in `allowed_origins`, so the token/CORS problem goes away, and Chrome can launch
the app on demand.
