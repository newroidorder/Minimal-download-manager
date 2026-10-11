'use strict';

// Native OS helpers with no dependencies: a folder picker, "open file" and
// "show in folder". Windows uses PowerShell/Explorer, macOS osascript/open,
// and Linux zenity or kdialog plus xdg-open.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', d => { stdout += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: stdout.trim() }));
  });
}

function detach(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  child.on('error', () => {});
  child.unref();
}

// The dialog starts at the nearest folder that exists.
function existingAncestor(dir) {
  let d = dir && path.resolve(dir);
  while (d && !fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return d;
}

const PS_PICKER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Mini IDM: choose where to save'
$d.ShowNewFolderButton = $true
if ($env:MINI_IDM_INITIAL) { $d.SelectedPath = $env:MINI_IDM_INITIAL }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
`;

// Resolves to the chosen folder, or null if the user cancelled.
async function pickFolder(initial) {
  const start = existingAncestor(initial) || '';
  const env = { ...process.env, MINI_IDM_INITIAL: start };

  if (process.platform === 'win32') {
    const encoded = Buffer.from(PS_PICKER, 'utf16le').toString('base64');
    const r = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', encoded], { env });
    return r.stdout || null;
  }
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "Mini IDM: choose where to save"'
      + (start ? ' default location (POSIX file (system attribute "MINI_IDM_INITIAL"))' : '') + ')';
    const r = await run('osascript', ['-e', script], { env });
    return r.code === 0 && r.stdout ? r.stdout.replace(/\/$/, '') : null;
  }
  for (const [cmd, args] of [
    ['zenity', ['--file-selection', '--directory', '--title=Mini IDM: choose where to save', ...(start ? [`--filename=${start}/`] : [])]],
    ['kdialog', ['--getexistingdirectory', start || '.']]
  ]) {
    try {
      const r = await run(cmd, args, { env });
      return r.code === 0 && r.stdout ? r.stdout : null;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw Object.assign(new Error('No folder picker available. Type the folder path instead.'), { status: 501 });
}

// Paths come only from finished queue items, never from request input.
// Windows paths can't contain quotes, so verbatim quoting is safe.
function openFile(file) {
  if (process.platform === 'win32') detach('explorer.exe', [`"${file}"`], { windowsVerbatimArguments: true });
  else if (process.platform === 'darwin') detach('open', [file]);
  else detach('xdg-open', [file]);
}

function showInFolder(file) {
  if (process.platform === 'win32') detach('explorer.exe', [`/select,"${file}"`], { windowsVerbatimArguments: true });
  else if (process.platform === 'darwin') detach('open', ['-R', file]);
  else detach('xdg-open', [path.dirname(file)]);
}

module.exports = { pickFolder, openFile, showInFolder, existingAncestor };
