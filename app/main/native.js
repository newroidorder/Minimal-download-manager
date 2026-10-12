'use strict';

// Registers the native messaging host with the browsers. Done on every start, so it follows the program if it
// is moved or updated. Per user only: no admin rights needed.
//
// <home>/native/
//   host.bat (Windows) or host.sh: sets ELECTRON_RUN_AS_NODE=1 and runs
//     native/host.js with the program's own executable
//   com.minimaldm.bridge.json: the manifest. Only our extension may start it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { HOST_NAME } = require('../native/protocol');

// Opera and Vivaldi read Chrome's key on Windows.
const WIN_KEYS = ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser'];
const LINUX_DIRS = ['google-chrome', 'google-chrome-beta', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi', 'opera'];
const MAC_DIRS = ['Google/Chrome', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Vivaldi'];

function writeIfChanged(file, text, mode) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* new */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
}

function wrapper({ exe, script, home, pipe }) {
  if (process.platform === 'win32') {
    const q = (s) => String(s).replace(/%/g, '%%');
    return ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `set "MDM_HOME=${q(home)}"`, `set "MDM_PIPE=${q(pipe)}"`,
      `"${q(exe)}" "${q(script)}" %*`, ''].join('\r\n');
  }
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 MDM_HOME=${q(home)} MDM_PIPE=${q(pipe)} exec ${q(exe)} ${q(script)} "$@"`, ''].join('\n');
}

function regAdd(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['add', `HKCU\\Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Writes the wrapper and manifest and registers them. Returns the manifest
 * path. extraDirs: more NativeMessagingHosts folders (tests use a browser profile).
 */
async function installNativeHost({ home, exe, script, pipe, extensionId, extraDirs = [] }) {
  const dir = path.join(home, 'native');
  const win = process.platform === 'win32';
  const hostFile = path.join(dir, win ? 'host.bat' : 'host.sh');
  writeIfChanged(hostFile, wrapper({ exe, script, home, pipe }), win ? undefined : 0o755);

  const manifest = JSON.stringify({
    name: HOST_NAME,
    description: 'Minimal Download Manager browser connection',
    path: hostFile,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2);
  const manifestFile = path.join(dir, `${HOST_NAME}.json`);
  writeIfChanged(manifestFile, manifest);

  if (win) {
    await Promise.all(WIN_KEYS.map(k => regAdd(k, manifestFile)));
  } else {
    const base = process.platform === 'darwin'
      ? MAC_DIRS.map(d => path.join(os.homedir(), 'Library', 'Application Support', d))
      : LINUX_DIRS.map(d => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), d));
    for (const d of base) {
      // Only for browsers that are installed (their profile folder exists).
      if (!fs.existsSync(d)) continue;
      try { writeIfChanged(path.join(d, 'NativeMessagingHosts', `${HOST_NAME}.json`), manifest); } catch { /* read-only */ }
    }
  }
  for (const d of extraDirs) {
    try { writeIfChanged(path.join(d, `${HOST_NAME}.json`), manifest); } catch { /* skip */ }
  }
  return manifestFile;
}

module.exports = { installNativeHost, wrapper };
