'use strict';

// Windows integration: antivirus scan, power actions after a queue, and the
// clipboard monitor.

const { spawn } = require('child_process');
const { clipboard } = require('electron');

// Splits an argument string like: -Scan -File "%f" (quotes group words).
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}

// Runs the antivirus on a finished file; %f is replaced by the file path.
function runProgram(program, args, file) {
  return new Promise((resolve, reject) => {
    const list = splitArgs(args || '').map(a => a.split('%f').join(file));
    if (!(args || '').includes('%f')) list.push(file);
    const child = spawn(program, list, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

function detached(cmd, args) {
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  c.on('error', () => {});
  c.unref();
}

// After a queue finishes: shut down (Windows shows its own 60 s warning and
// "shutdown /a" cancels it) or sleep.
function shutdown(message) {
  if (process.platform === 'win32') detached('shutdown', ['/s', '/t', '60', '/c', message]);
  else detached('shutdown', ['-h', '+1']);
}
function cancelShutdown() {
  if (process.platform === 'win32') detached('shutdown', ['/a']);
  else detached('shutdown', ['-c']);
}
function sleep() {
  if (process.platform === 'win32') detached('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
  else detached('systemctl', ['suspend']);
}

// Calls onUrl when a new single download link is copied.
function watchClipboard(isEnabled, wants, onUrl) {
  let last = String(clipboard.readText() || '');
  const timer = setInterval(() => {
    if (!isEnabled()) return;
    let text;
    try { text = String(clipboard.readText() || '').trim(); } catch { return; }
    if (text === last) return;
    last = text;
    if (!/^https?:\/\/\S+$/i.test(text) || text.length > 4000) return;
    if (wants(text)) onUrl(text);
  }, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { runProgram, shutdown, cancelShutdown, sleep, watchClipboard, splitArgs };
