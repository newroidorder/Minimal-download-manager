# Minimal Download Manager

A download manager for Windows modelled on Internet Download Manager: the same
layout, menus, Options tabs, categories, queues and scheduler, with a 2026
Windows 11 look, dark mode

The **program** does all the work. The small **browser extension** is only a
connector: it hands your downloads to the program and has nothing to set up.

![Minimal Download Manager main window](docs/screenshots/main-list.png)

| Download File Info | Progress | Download complete |
|---|---|---|
| ![](docs/screenshots/dialog-file-info.png) | ![](docs/screenshots/dialog-progress.png) | ![](docs/screenshots/dialog-complete.png) |

| Options | Scheduler | Português, dark mode |
|---|---|---|
| ![](docs/screenshots/options-general.png) | ![](docs/screenshots/scheduler.png) | ![](docs/screenshots/main-portuguese.png) ![](docs/screenshots/main-dark.png) |

## Install

1. Download **Minimal-Download-Manager-Setup-2.2.1.exe** from the [Releases page](../../releases).
   Optionally check it: the release page lists its SHA-256, which PowerShell's
   `Get-FileHash .\Minimal-Download-Manager-Setup-2.2.1.exe` must match.
2. Run it. The installer isn't code-signed yet (see [Security](#security)), so Windows SmartScreen
   may show "Windows protected your PC": click **More info → Run anyway**.
3. Minimal Download Manager starts and from then on starts with Windows, sitting in the notification area
   (next to the clock). Closing the window keeps it running there, like IDM.

### Connect your browser (once)

1. In Minimal Download Manager open **Options → General**. Under *Browser extension* click **Open folder**.
2. In your browser open `opera://extensions` (or `chrome://extensions`, `edge://extensions`),
   turn on **Developer mode**, click **Load unpacked** and choose that folder.
3. That's it. There's nothing to configure in the extension. The status bar in Minimal Download Manager shows
   "Connected: Opera" once the browser has talked to it.

**After updating the program:** open your browser's extensions page and click the reload button (↻)
on Minimal Download Manager (or restart the browser), so the browser picks up the updated extension.
Since 2.2 the extension connects through native messaging instead of port 7878.

## What it does (the features from IDM)

**Main window**: menu bar (Tasks, File, Downloads, View, Help), toolbar (Add URL, Resume, Stop,
Stop all, Delete, Delete completed, Options, Scheduler, Start/Stop queue, Grabber), category tree
(All downloads → Compressed, Documents, Music, Programs, Video, General; Unfinished; Finished;
Grabber projects; Queues), sortable and resizable columns (File name, Queue, Size, Status, Time left,
Transfer rate, Last try, Description), right-click menu, search, status bar with total speed.

**Downloading**: up to 32 connections per file with dynamic segmentation (a free connection takes
half of the largest remaining part), pause and resume (also after a restart), automatic retry,
direct writing (no temporary files to merge), duplicate-address handling, file names from the server.

**Browser capture**: downloads the browser starts, clicks on file links, right-click "Download with
Minimal Download Manager", and videos/files spotted on the page (listed in the extension's popup). The site's cookies
(including HttpOnly) go along so logged-in downloads work; you can switch that off in Options → General.
Hold **Alt** while clicking to let the browser download instead.

**Menus as in IDM**
- *Tasks*: Add URL, Add batch download (`img*.jpg` from 1 to 50), Site Grabber, Import/Export list, Exit
- *File*: Resume, Stop, Download again, Remove, Open, Open folder, Copy address, Properties
- *Downloads*: Pause all, Stop all, Delete all completed, Find (Ctrl+F), Find next (F3), Scheduler,
  Start queue ▸, Stop queue ▸, Speed limiter ▸ (on / off / settings), Options
- *View*: Hide categories, Arrange files by ▸, Toolbar ▸, Columns ▸, tray icon, Theme (dark mode),
  Font size, Language
- *Help*: Help, Report a problem, Check for updates, About

**Options (all 9 tabs)**

| Tab | What you can set |
|---|---|
| General | Start with Windows, clipboard monitoring, which browsers to capture from, the bypass key, the right-click menu, sending cookies, language, theme, extension folder, the old port-7878 connection (off) |
| File types | Types captured automatically (IDM's default list), sites and addresses never to capture |
| Save to | Categories with their folder and file types, new/edit/delete categories, remember last folder, file date from the server |
| Downloads | Show Download File Info / progress / complete windows, duplicate-address rule, User-Agent, antivirus scan after download (Microsoft Defender by default) |
| Connection | Connections per download (1–32), downloads at the same time, per-server exceptions, speed limiter, download limits (X MB every Y hours) |
| Proxy / Socks | None, Windows settings, automatic script (PAC), or manual HTTP / SOCKS5 with login |
| Sites and logins | User name and password per site, host, wildcard or path (sent over HTTPS only, stored encrypted) |
| Retry | Attempts (0 = keep trying) and the wait between them. IDM's dial-up/VPN options aren't needed on modern Windows. |
| Sounds | Download complete, download failed, queue started, queue finished: built-in tone or your own file |

**Scheduler**: any number of queues; start once or on chosen weekdays at a time, stop at a time,
N files at once, then do nothing / exit / shut down / sleep; file order inside each queue.

## Not included

- **Video download buttons and HLS/DASH streams.** That's IDM's most-used extra and the next big step.
- DRM-protected video (no download manager can legally do this).
- FTP and MMS, IDM's toolbar button inside web pages, and registration.
- Firefox: the extension targets Chrome, Edge, Opera, Brave and Vivaldi.

## For developers

```
app/            the Windows program (Electron)
  engine/       download engine: downloader, manager (queues, limits, retries), settings,
                scheduler, proxy, rules, grabber, batch, browser bridge
  main/         program shell: windows, tray, start with Windows, IPC, notifications, sounds
  renderer/     the windows (plain HTML/CSS/JS, strict CSP, no Node access)
  locales/      en.json, pt-BR.json
  native/       native messaging host the browser starts (host.js) and the pipe protocol
  test/         engine tests (node:test)
  test-e2e/     drives the real program and extension (Playwright)
extension/      the browser connector (Manifest V3)
docs/           screenshots, the original analysis prompt and review
```

```bash
cd app
npm install
npm start            # run the program
npm test             # 57 engine tests: segmentation, resume, queues, scheduler, proxies, quota…
npm run test:e2e     # real program + real extension (needs: npm i -D playwright)
npm run dist         # Windows installer in app/dist (on Linux this needs Wine)
```

Every push to `main` makes the **Windows build** workflow run the tests on Windows, build the
installer, and publish it as the release for the version in `app/package.json`. A version that is
already released is never replaced: raise the version to publish changes.

## Security

### How the browser connection works

Like IDM (which uses `IDMMsgHost.exe`), the extension talks to the program through **native
messaging**:

```
extension ──native messaging──▶ host (started by the browser) ──private pipe──▶ program
```

- The program registers the host for your Windows user on every start (`HKCU\Software\Google\Chrome\NativeMessagingHosts`
  and the Edge/Brave/Chromium keys; Opera and Vivaldi read Chrome's). The browser only lets the
  extension with our fixed ID start it.
- The host reaches the program over a Windows named pipe. Before anything else, both sides prove
  they know a random secret in `%APPDATA%\Minimal Download Manager\config.json`, a file only your
  Windows user can read. Other programs, and other users on the PC, can't add downloads or receive
  your cookies through it, and the host never talks to a program pretending to be ours.
- No network port is open. The old `127.0.0.1:7878` connection is **off**. It can be switched on in
  Options → General for a browser that can't use native messaging. While it is on, any program
  running on your PC could send it a download, because programs (unlike web pages) can fake the
  `Origin` header.
- Only cookies, referrer, user agent and language are passed on, and only for the download's own
  address. Cookies stay in memory and are never written to disk. They aren't sent again after a
  redirect to another site.

### Passwords

Passwords in *Sites and logins* and the proxy settings are stored encrypted with Windows DPAPI
(`enc:` in `settings.json`). Only your Windows user on this PC can decrypt them. Older plain-text
files are encrypted the first time 2.2 starts. Saved logins are only sent over **HTTPS**. A site
entered as `http://…` (for example an old router) is the one exception, and only because you typed
it that way.

### Releases

- Each version is built by GitHub Actions from the public source and published once. A release is
  never replaced later.
- The release notes and `SHA256SUMS.txt` give the installer's SHA-256.
- A signed [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)
  ties the file to the exact commit and workflow. Check it with
  `gh attestation verify Minimal-Download-Manager-Setup-<version>.exe --owner newroidorder`.
- The installer is **not code-signed** yet, which is why SmartScreen warns. The workflow signs
  automatically once a certificate is added as the repository secrets `WINDOWS_CERT` (base64 .pfx)
  and `WINDOWS_CERT_PASSWORD`. Free signing for open-source projects is available from
  [SignPath Foundation](https://signpath.org/). Azure Trusted Signing is a low-cost paid option.
