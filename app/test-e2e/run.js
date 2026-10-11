'use strict';

// End-to-end: drives the real Mini IDM program (Electron) and the real
// browser extension (Chromium) together.
//
//   npm i -D playwright      (once; uses the Chromium Playwright installs)
//   npm run test:e2e         (on Linux without a display: xvfb-run -a npm run test:e2e)
//   SHOTS=folder npm run test:e2e   also saves screenshots

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { BODY, sha256, tmpDir, startOrigin, waitFor } = require('../test/helpers');

let pw;
try { pw = require('playwright'); } catch {
  console.error('Playwright is not installed. Run: npm i -D playwright');
  process.exit(2);
}

const APP = path.join(__dirname, '..');
const EXTENSION = path.join(APP, '..', 'extension');
const SHOTS = process.env.SHOTS;
const LANG = process.env.E2E_LANG || 'en';
const THEME = process.env.E2E_THEME || 'light';

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let failed = false;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed = true; console.log(`FAIL ${name}\n     ${String(err.stack).split('\n').slice(0, 4).join('\n     ')}`); }
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

(async () => {
  const origin = await startOrigin();
  const home = tmpDir('mini-idm-e2e-');
  const downloads = path.join(home, 'Downloads');
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, token: 'e2e-token' }));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ version: 2, language: LANG, ui: { theme: THEME } }));

  const app = await pw._electron.launch({
    executablePath: require(path.join(APP, 'node_modules', 'electron')),
    args: [APP, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    env: { ...process.env, MINI_IDM_HOME: home, MINI_IDM_SAVE_DIR: downloads, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  });
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', e => errors.push(`${p.url()}: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') errors.push(`${p.url()}: ${m.text()}`); });
  };
  app.on('window', watch);
  const main = await app.firstWindow();
  watch(main);
  await main.waitForSelector('.tb[data-act="add"]');
  const win = (part) => waitFor(() => app.windows().find(w => !w.isClosed() && w.url().includes(part)), 15_000, `window ${part}`);
  const closed = (page) => waitFor(() => page.isClosed(), 10_000, 'window to close');
  // Buttons that close their own window: click without waiting on the page afterwards.
  const clickClosing = (page, sel) => page.evaluate((q) => document.querySelector(q).click(), sel).catch(() => {});
  const ipc = (name, ...args) => main.evaluate(([n, a]) => window.idm.invoke(n, ...a), [name, args]);
  let context;

  try {
    await check('main window opens without errors', async () => {
      await main.waitForTimeout(800);
      assert.equal(await main.title(), 'Mini IDM');
      assert.equal(await main.locator('.node .nl').first().textContent(), LANG === 'pt-BR' ? 'Todos os downloads' : 'All downloads');
      await shot(main, 'main-empty');
    });

    await check('Add URL -> Download File Info -> progress -> Download complete', async () => {
      await main.click('.tb[data-act="add"]');
      const add = await win('/add.html');
      await add.fill('#url', `${origin.base}/files/archive.zip`);
      await clickClosing(add, '#ok');
      const dl = await win('/download.html');
      await dl.waitForSelector('#ask:not([hidden])');
      await dl.waitForFunction(() => !document.getElementById('askInfo').textContent.includes('…'));
      assert.equal(await dl.inputValue('#filename'), 'archive.zip');
      assert.equal(await dl.inputValue('#category'), 'compressed');
      assert.equal(await dl.inputValue('#folder'), path.join(downloads, 'Compressed'));
      await shot(dl, 'dialog-file-info');
      await dl.click('#start');
      await dl.waitForSelector('#complete:not([hidden])', { timeout: 20_000 });
      const file = path.join(downloads, 'Compressed', 'archive.zip');
      assert.equal(sha256(fs.readFileSync(file)), sha256(BODY));
      assert.equal(await dl.textContent('#donePath'), file);
      await shot(dl, 'dialog-complete');
      await clickClosing(dl, '#closeDone');
      await main.waitForSelector('.row .cell.status.done');
    });

    await check('progress window: rate, connections, segment bar, pause and resume', async () => {
      await ipc('settings', { downloads: { showFileInfo: false } });
      await ipc('add', { url: `${origin.base}/slow`, filename: 'ubuntu-26.04-desktop-amd64.iso' });
      const dl = await win('/download.html');
      await dl.waitForSelector('#progress:not([hidden])');
      await dl.waitForFunction(() => /\d/.test(document.getElementById('progConns').textContent), null, { timeout: 10_000 });
      await dl.waitForTimeout(300);
      await shot(dl, 'dialog-progress');
      await shot(main, 'main-downloading');
      await dl.click('#pauseResume');
      await dl.waitForFunction(() => /Resume|Continuar/.test(document.getElementById('pauseResume').textContent), null, { timeout: 10_000 });
      await dl.click('#pauseResume');
      await dl.waitForSelector('#complete:not([hidden])', { timeout: 30_000 });
      const iso = path.join(downloads, 'Programs', 'ubuntu-26.04-desktop-amd64.iso');
      assert.equal(sha256(fs.readFileSync(iso)), sha256(BODY), 'goes to Programs, intact after pause/resume');
      await clickClosing(dl, '#closeDone');
      await ipc('settings', { downloads: { showFileInfo: true } });
    });

    await check('Options: 9 tabs; switching the language to Portuguese and back', async () => {
      await main.click('.tb[data-act="options"]');
      const opt = await win('/options.html');
      await opt.waitForSelector('#browsers .browser-row');
      assert.equal(await opt.locator('#nav button').count(), 9);
      await shot(opt, 'options-general');
      for (const sec of ['types', 'save', 'downloads', 'connection', 'proxy', 'sites', 'retry', 'sounds']) {
        await opt.click(`#nav button[data-sec="${sec}"]`);
        await opt.waitForSelector(`section[data-sec="${sec}"]:not([hidden])`);
        if (sec === 'save') { await opt.click('#cats tr:nth-child(3)'); await shot(opt, 'options-save'); }
        if (sec === 'connection') await shot(opt, 'options-connection');
      }
      await opt.click('#nav button[data-sec="general"]');
      await opt.selectOption('select[data-path="language"]', 'pt-BR');
      await clickClosing(opt, '#ok');
      await closed(opt);
      await main.waitForFunction(() => document.querySelector('.menubar button').textContent === 'Tarefas');
      await shot(main, 'main-portuguese');
      await ipc('settings', { language: LANG });
    });

    await check('Downloads menu has the IDM entries; dark mode', async () => {
      await main.click('.menubar button[data-menu="downloads"]');
      const labels = await main.locator('.menu .mi .label').allTextContents();
      for (const want of ['Pause all', 'Stop all', 'Delete all completed', 'Find', 'Find next', 'Scheduler…', 'Start queue', 'Stop queue', 'Speed limiter', 'Options…']) {
        assert.ok(labels.includes(want), `missing ${want}`);
      }
      await main.hover('.menu .mi:has-text("Speed limiter")');
      await main.waitForTimeout(150);
      await shot(main, 'menu-downloads');
      await main.keyboard.press('Escape');
      await main.keyboard.press('Escape');
      await main.emulateMedia({ colorScheme: null }); // use the app's own theme, not the test tool's
      await ipc('settings', { ui: { theme: 'dark' } });
      await main.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches, null, { timeout: 5000 });
      await main.waitForTimeout(300);
      await shot(main, 'main-dark');
      await ipc('settings', { ui: { theme: THEME } });
    });

    await check('Scheduler: create a queue with a schedule', async () => {
      await main.click('.tb[data-act="scheduler"]');
      const sc = await win('/scheduler.html');
      await sc.click('#newQueue');
      await sc.fill('#qName', 'Night downloads');
      await sc.check('#sEnabled');
      await sc.fill('#sTime', '02:30');
      await sc.check('#stopOn');
      await sc.selectOption('#after', 'shutdown');
      await shot(sc, 'scheduler');
      await sc.click('#apply');
      await clickClosing(sc, '#close');
      await closed(sc);
      const s = await ipc('state');
      const q = s.settings.queues.find(x => x.name === 'Night downloads');
      assert.ok(q, 'queue saved');
      assert.equal(q.schedule.startTime, '02:30');
      assert.equal(q.schedule.afterFinish, 'shutdown');
      await main.waitForSelector('.node .nl:text("Night downloads")');
    });

    await check('Batch download adds a numbered series to the main queue', async () => {
      await main.focus('#list');
      await main.keyboard.press('Control+B');
      const b = await win('/batch.html');
      await b.fill('#pattern', `${origin.base}/img*.jpg`);
      await b.fill('#from', '1');
      await b.fill('#to', '12');
      await b.fill('#width', '2');
      await b.waitForFunction(() => document.querySelectorAll('#preview tr').length === 12);
      assert.match(await b.textContent('#preview tr:first-child td'), /img01\.jpg$/);
      await clickClosing(b, '#ok');
      await closed(b);
      const s = await ipc('state');
      assert.equal(s.items.filter(i => /img\d\d\.jpg$/.test(i.url) && i.queueId === 'main').length, 12);
    });

    await check('Site Grabber explores linked pages and lists matching files', async () => {
      await main.click('.tb[data-act="grabber"]');
      const g = await win('/grabber.html');
      await g.fill('#url', `${origin.base}/site/index.html`);
      await g.fill('#exts', 'zip mp3 pdf');
      await g.selectOption('#depth', '1');
      await g.click('#explore');
      await g.waitForFunction(() => document.querySelectorAll('#results tr').length === 3, null, { timeout: 10_000 });
      await shot(g, 'grabber');
      await g.click('#saveProject');
      await main.waitForSelector('.node .nl:text("127.0.0.1")', { state: 'attached', timeout: 5000 }).catch(() => {});
      const s = await ipc('state');
      assert.equal(s.settings.grabberProjects.length, 1, 'project saved');
      await g.close();
    });

    await check('Properties, About, and the speed limiter toggle in the status bar', async () => {
      await main.click('.row');
      await main.keyboard.press('Alt+Enter');
      const pr = await win('/properties.html');
      await pr.waitForFunction(() => document.getElementById('name').textContent.length > 0);
      await shot(pr, 'dialog-properties');
      await pr.close();
      await main.click('.menubar button[data-menu="help"]');
      await main.click('.menu .mi:has-text("About Mini IDM")');
      const ab = await win('/about.html');
      await ab.waitForFunction(() => /\d+\.\d+\.\d+/.test(document.getElementById('version').textContent));
      await clickClosing(ab, '#close');
      await main.click('#stLimiter');
      await main.waitForFunction(() => document.getElementById('stLimiter').classList.contains('on'));
      assert.equal((await ipc('state')).settings.speedLimit.enabled, true);
      await main.click('#stLimiter');
      await main.waitForFunction(() => !document.getElementById('stLimiter').classList.contains('on'));
    });

    await check('browser extension: a link click opens the program\'s dialog; cookies are forwarded', async () => {
      context = await pw.chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'mini-idm-profile-')), {
        channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
      });
      const isOurs = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
      const sw = context.serviceWorkers().find(isOurs) || await context.waitForEvent('serviceworker', { predicate: isOurs });
      await waitFor(() => sw.evaluate(() => !!globalThis.chrome?.storage?.local).catch(() => false), 10_000, 'extension APIs');
      assert.equal(new URL(sw.url()).host, 'jblggonfekdkfbcfpjfnemnhbofnhfki', 'the fixed extension ID');
      await sw.evaluate(async (p) => { await chrome.storage.local.set({ server: `http://127.0.0.1:${p}` }); }, port);
      // re-run setup so the config is fetched from the program on this port
      await sw.evaluate(async (p) => {
        const r = await fetch(`http://127.0.0.1:${p}/api/config`);
        await chrome.storage.local.set({ config: await r.json() });
        await fetch(`http://127.0.0.1:${p}/api/ping?browser=chrome`);
      }, port);
      const page = await context.newPage();
      await page.goto(`${origin.base}/page.html`);
      await page.waitForTimeout(300);
      origin.stats.cookies = [];
      await page.click('#zip');
      // archive.zip is already in the list, so the program asks first, like IDM.
      const dup = await win('/duplicate.html');
      await dup.waitForFunction(() => document.getElementById('name').textContent.length > 0);
      await shot(dup, 'dialog-duplicate');
      await dup.check('input[value="number"]');
      await clickClosing(dup, '#ok');
      const dl = await waitFor(() => app.windows().find(w => !w.isClosed() && w.url().includes('/download.html')), 15_000, 'download window');
      await dl.waitForSelector('#ask:not([hidden])');
      assert.equal(await dl.inputValue('#filename'), 'archive.zip');
      await dl.click('#start');
      await dl.waitForSelector('#complete:not([hidden])', { timeout: 20_000 });
      assert.equal(path.basename(await dl.textContent('#donePath')), 'archive (1).zip', 'the second copy gets a number');
      assert.ok(origin.stats.cookies.includes('sid=httponly-secret'), `cookies seen: ${origin.stats.cookies}`);
      await clickClosing(dl, '#closeDone');
      const st = await ipc('bridge');
      assert.ok(st.seen.chrome, 'the program knows the browser is connected');
      await main.waitForFunction(() => document.getElementById('stBridge').classList.contains('good'), null, { timeout: 20_000 });
      assert.match(await main.textContent('#stBridge'), /Connected: Google Chrome/, 'the status bar says so');
    });

    await check('browser extension: a download the browser starts is taken over', async () => {
      await ipc('settings', { downloads: { showFileInfo: false, showProgress: false, showComplete: false } });
      const page = context.pages().at(-1);
      await page.click('#dl');
      await waitFor(async () => (await ipc('state')).items.some(i => i.url.endsWith('/dl?id=1') && i.status === 'done'), 20_000, 'report.bin done');
      const item = (await ipc('state')).items.find(i => i.url.endsWith('/dl?id=1'));
      assert.equal(path.basename(item.dest), 'report.bin');
      await shot(main, 'main-list');
    });

    await check('File types rules: an excluded site stays in the browser', async () => {
      await ipc('settings', { fileTypes: { excludeSites: ['127.0.0.1'] } });
      const sw = context.serviceWorkers()[0];
      const before = (await ipc('state')).items.length;
      const page = context.pages().at(-1);
      await page.click('#zip');
      await waitFor(() => sw.evaluate(() => chrome.downloads.search({}).then(l => l.some(d => d.url.endsWith('/files/archive.zip') && d.byExtensionId))), 10_000, 'browser download');
      assert.equal((await ipc('state')).items.length, before);
    });

    await check('no errors in any window', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await context?.close().catch(() => {});
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await origin.close();
  }
  console.log(failed ? '\nE2E FAILED' : '\nE2E passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
