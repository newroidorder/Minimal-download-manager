'use strict';

// <home>/config.json: the bridge port and a token for scripts (the extension
// doesn't need it; it is recognised by its fixed ID).

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

// The ID that follows from the "key" in extension/manifest.json.
const EXTENSION_ID = 'jblggonfekdkfbcfpjfnemnhbofnhfki';
const DEFAULT_PORT = 7878;

function loadConfig(home) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (!saved.token) {
    saved.token = randomBytes(24).toString('base64url');
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return { token: saved.token, port: Number(saved.port) || DEFAULT_PORT };
}

module.exports = { loadConfig, EXTENSION_ID, DEFAULT_PORT };
