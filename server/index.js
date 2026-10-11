#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./lib/config');
const { createApp } = require('./lib/app');

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, '127.0.0.1', () => {
  console.log(`Mini IDM running at http://127.0.0.1:${config.port}`);
  console.log(`Saving to:       ${config.saveDir}`);
  console.log(`Extension token: ${config.token}`);
  console.log('(paste the token into the extension options page)');
});

app.server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : err.message);
  process.exit(1);
});

// Pause running downloads so they resume from where they stopped next time.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nPausing downloads and saving queue...');
    await app.close();
    process.exit(0);
  });
}
