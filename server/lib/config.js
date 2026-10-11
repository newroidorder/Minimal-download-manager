'use strict';

// Loads or creates ~/.mini-idm/config.json. The token is generated once and
// shared with the extension (paste it into the extension's options page).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');

function loadConfig(env = process.env) {
  const home = env.MINI_IDM_HOME || path.join(os.homedir(), '.mini-idm');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.json');

  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (!saved.token) {
    saved.token = randomBytes(24).toString('base64url');
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }

  return {
    home,
    token: saved.token,
    port: Number(env.MINI_IDM_PORT || saved.port || 7878),
    // Base folder for the default category folders (Downloads\Music, Downloads\Programs, ...).
    // Folders, categories and limits are changed in the web UI's Settings.
    saveDir: env.MINI_IDM_SAVE_DIR || saved.saveDir || path.join(os.homedir(), 'Downloads')
  };
}

module.exports = { loadConfig };
