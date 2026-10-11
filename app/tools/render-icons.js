'use strict';
// Renders build/icon.png (512) and build/tray.png (32) from renderer/logo.svg.
// Needs Playwright: NODE_PATH=$(npm root -g) node tools/render-icons.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'logo.svg'), 'utf8');
  const b = await chromium.launch();
  for (const [file, size] of [['icon.png', 512], ['tray.png', 32], ['tray@2x.png', 64]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
    await p.screenshot({ path: path.join(__dirname, '..', 'build', file), omitBackground: true });
    await p.close();
  }
  await b.close();
})();
