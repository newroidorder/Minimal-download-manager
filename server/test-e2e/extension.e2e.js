'use strict';

// End-to-end: loads the real extension into Chromium (via Playwright), points
// it at a real Mini IDM server and checks each capture path.
//
//   npm i -D playwright && npx playwright install chromium   (once)
//   npm run test:e2e

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../lib/app');
const { BODY, sha256, tmpDir, startOrigin } = require('../test/helpers');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const EXTENSION = path.resolve(__dirname, '..', '..', 'extension');
const TOKEN = 'e2e-token-0123456789abcdef';

async function waitFor(fn, what, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

(async () => {
  const origin = await startOrigin();
  const home = tmpDir();
  const app = createApp({ token: TOKEN, home, saveDir: path.join(home, 'downloads') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const server = `http://127.0.0.1:${app.server.address().port}`;

  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'mini-idm-profile-')), {
    channel: 'chromium', // the new headless mode, which supports extensions
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
  });
  let failed = false;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed = true; console.log(`FAIL ${name}\n     ${err.message}`); }
  };

  try {
    const isOurs = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
    const sw = context.serviceWorkers().find(isOurs) || await context.waitForEvent('serviceworker', { predicate: isOurs });
    // Extension APIs are bound slightly after the worker starts.
    await waitFor(() => sw.evaluate(() => !!globalThis.chrome?.storage?.local).catch(() => false), 'extension APIs');
    const setSettings = (s) => sw.evaluate((s) => chrome.storage.local.set(s), s);
    await setSettings({ server, token: TOKEN, captureDownloads: true, captureClicks: true });
    const queue = () => app.queue.list();
    const page = await context.newPage();

    await check('link click is captured and HttpOnly cookies are forwarded', async () => {
      await page.goto(`${origin.base}/page.html`);
      origin.stats.cookies = [];
      await page.click('#zip');
      const item = await waitFor(() => queue().find(i => i.url.endsWith('/files/archive.zip') && i.status === 'done'), 'archive.zip to finish');
      assert.equal(sha256(fs.readFileSync(item.dest)), sha256(BODY));
      assert.ok(origin.stats.cookies.includes('sid=httponly-secret'), `origin saw cookies: ${origin.stats.cookies}`);
    });

    await check('browser-started download is taken over and removed from Chrome', async () => {
      await page.click('#dl'); // not a file-looking URL, so Chrome starts the download itself
      const item = await waitFor(() => queue().find(i => i.url.endsWith('/dl?id=1') && i.status === 'done'), 'report.bin to finish');
      assert.equal(path.basename(item.dest), 'report.bin');
      const left = await sw.evaluate(() => chrome.downloads.search({}).then(l => l.filter(d => d.url.includes('/dl?id=1') && d.state !== 'interrupted')));
      assert.deepEqual(left, [], 'Chrome should not keep its own copy');
    });

    await check('video on the page is detected (not auto-downloaded)', async () => {
      const before = queue().length;
      await page.evaluate(() => document.getElementById('v').load());
      const tabId = await sw.evaluate(() => chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('/page.html')).id));
      const list = await waitFor(() => sw.evaluate((k) => chrome.storage.session.get(k).then(r => r[k]), `detected:${tabId}`)
        .then(l => l && l.find(d => d.url.endsWith('/files/video.mp4')) && l), 'video to be detected');
      assert.equal(list.find(d => d.url.endsWith('/files/video.mp4')).kind, 'media');
      assert.equal(queue().length, before, 'detection must not start a download');
    });

    await check('server rejects the request: the click falls back to a normal browser download', async () => {
      await setSettings({ token: 'wrong-token' });
      await page.waitForTimeout(200); // let content.js see the storage change
      const before = queue().length;
      await page.click('#zip');
      const d = await waitFor(() => sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] })
        .then(l => l.find(x => x.url.endsWith('/files/archive.zip') && x.byExtensionId === chrome.runtime.id))), 'fallback download');
      assert.ok(d);
      assert.equal(queue().length, before);
    });
  } finally {
    await context.close();
    await app.close();
    await origin.close();
  }
  console.log(failed ? '\nE2E FAILED' : '\nE2E passed');
  process.exit(failed ? 1 : 0);
})();
