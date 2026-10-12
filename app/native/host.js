'use strict';

// Native messaging host: the part of Minimal Download Manager the browser
// starts for our extension. Chrome only
// starts it for the extension IDs in its manifest. It relays messages between
// the extension (stdin/stdout) and the program (private pipe), and tells the
// extension whether the program is running.
//
// Started through a small wrapper the program writes next to the manifest,
// which sets ELECTRON_RUN_AS_NODE=1, MDM_HOME and MDM_PIPE.

const fs = require('fs');
const net = require('net');
const path = require('path');
const P = require('./protocol');

const home = process.env.MDM_HOME;
const pipe = process.env.MDM_PIPE || (home && P.pipePath(home));
const RETRY_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;

function token() {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).token || null; } catch { return null; }
}

const toBrowser = (msg) => process.stdout.write(P.encodeNative(msg));

let conn = null;          // authenticated pipe socket
let connecting = null;    // Promise<socket|null> while a connection is being made
let browser = '';
let lastStatus = null;
const pending = new Map(); // request id -> timer

function status(running, version) {
  const key = `${running}:${version || ''}`;
  if (key === lastStatus) return;
  lastStatus = key;
  toBrowser({ type: 'status', running, version: version || null });
}

function connect() {
  if (conn) return Promise.resolve(conn);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    const secret = token();
    if (!pipe || !secret) return resolve(null);
    const sock = net.connect(pipe);
    const myNonce = P.nonce();
    let ready = false;
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { sock.destroy(); done(null); }, 5000);
    sock.on('error', () => {});
    sock.on('close', () => {
      if (!ready) return done(null);
      conn = null;
      for (const [id, t] of pending) { clearTimeout(t); toBrowser({ id, error: 'not-running' }); }
      pending.clear();
      status(false);
    });
    sock.on('connect', () => P.writeLine(sock, { type: 'hello', nonce: myNonce }));
    P.readLines(sock, (msg) => {
      if (!ready) {
        if (msg.type === 'hello') {
          // The program proves it knows the token before we send it anything else.
          if (!P.verify(secret, 'app', myNonce, msg.proof)) { sock.destroy(); return; }
          P.writeLine(sock, { type: 'auth', proof: P.proof(secret, 'host', msg.nonce), browser });
        } else if (msg.type === 'ready') {
          ready = true;
          conn = sock;
          status(true, msg.version);
          if (msg.config) toBrowser({ type: 'config', config: msg.config });
          done(sock);
        } else {
          sock.destroy();
        }
        return;
      }
      if (msg.type === 'config') return toBrowser({ type: 'config', config: msg.config });
      if (msg.id != null && pending.has(msg.id)) {
        clearTimeout(pending.get(msg.id));
        pending.delete(msg.id);
        toBrowser(msg);
      }
    });
  }).finally(() => { connecting = null; });
  return connecting;
}

async function fromBrowser(msg) {
  if (msg.type === 'hello') {
    if (typeof msg.browser === 'string' && /^[a-z]{2,12}$/.test(msg.browser)) browser = msg.browser;
    const c = await connect();
    if (c) P.writeLine(c, { type: 'browser', browser });
    else status(false);
    return;
  }
  if (msg.id == null) return;
  const c = await connect();
  if (!c) return toBrowser({ id: msg.id, error: 'not-running' });
  pending.set(msg.id, setTimeout(() => { pending.delete(msg.id); toBrowser({ id: msg.id, error: 'timeout' }); }, REQUEST_TIMEOUT_MS));
  P.writeLine(c, msg);
}

function main() {
  process.stdin.on('end', () => process.exit(0));   // the browser closed the connection
  process.stdout.on('error', () => process.exit(0));
  P.readNative(process.stdin, (msg) => { fromBrowser(msg).catch(() => {}); }, () => process.exit(1));
  // Keep a connection to the program, so the extension knows at once when it starts or quits.
  const tick = () => { if (!conn) connect().then(c => { if (!c) status(false); }); };
  tick();
  setInterval(tick, RETRY_MS);
}

main();
