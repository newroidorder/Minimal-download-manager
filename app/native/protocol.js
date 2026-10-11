'use strict';

// Shared by the program (engine/pipe.js) and the native messaging host
// (native/host.js). Kept free of Electron and of other files so the host can
// run on its own with ELECTRON_RUN_AS_NODE.
//
// Browser ⇄ host: Chrome native messaging (4-byte little-endian length + JSON).
// Host ⇄ program: a private pipe (Windows named pipe, Unix socket elsewhere),
// one JSON message per line, opened with a two-way handshake: each side proves
// it knows the token in <home>/config.json, a file only this Windows user can
// read. So no other program or user can talk to the program through the pipe,
// and the host never hands cookies to a program pretending to be ours.

const crypto = require('crypto');
const path = require('path');

const HOST_NAME = 'com.minimaldm.bridge';
const MAX_MESSAGE = 1024 * 1024; // Chrome's limit for host → browser messages

function pipePath(home) {
  if (process.platform === 'win32') {
    const id = crypto.createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\minimal-download-manager-${id}`;
  }
  return path.join(home, 'bridge.sock');
}

const nonce = () => crypto.randomBytes(24).toString('base64');
const proof = (token, role, n) => crypto.createHmac('sha256', String(token)).update(`${role}:${n}`).digest('base64');

function verify(token, role, n, value) {
  if (typeof value !== 'string' || typeof n !== 'string') return false;
  const a = Buffer.from(proof(token, role, n));
  const b = Buffer.from(value);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Newline-delimited JSON on a socket. Calls onMessage(obj) per line; a line
// that is too long or not JSON closes the connection.
function readLines(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > MAX_MESSAGE * 2) { socket.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { socket.destroy(); return; }
      if (msg && typeof msg === 'object') onMessage(msg);
      if (socket.destroyed) return;
    }
  });
}

const writeLine = (socket, msg) => { if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n'); };

// Chrome native messaging framing.
function readNative(stream, onMessage, onBad) {
  let buf = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_MESSAGE) return onBad?.();
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { return onBad?.(); }
      if (msg && typeof msg === 'object') onMessage(msg);
    }
  });
}

function encodeNative(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

module.exports = { HOST_NAME, MAX_MESSAGE, pipePath, nonce, proof, verify, readLines, writeLine, readNative, encodeNative };
