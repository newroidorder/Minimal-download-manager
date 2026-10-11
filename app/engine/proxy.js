'use strict';

// Proxy support for the Proxy/Socks tab: none, system, automatic (PAC) or
// manual HTTP / SOCKS5, with optional login.
//
// routeFor(url) returns null (direct), { forward } for plain HTTP through an
// HTTP proxy (absolute-URI request), or { agent } that tunnels the connection
// (HTTP CONNECT or SOCKS5). For system and PAC modes the caller supplies
// resolve(url), which in the app is Electron's session.resolveProxy.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

function basic(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function readUntil(socket, done) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const n = done(buf);
      if (n) {
        cleanup();
        const rest = buf.subarray(n);
        if (rest.length) socket.unshift(rest);
        resolve(buf.subarray(0, n));
      }
    };
    const onError = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('proxy closed the connection')); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function connectSocket(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

async function httpConnect(proxy, host, port) {
  const s = await connectSocket(proxy.host, proxy.port);
  const auth = proxy.user ? `Proxy-Authorization: ${basic(proxy.user, proxy.pass)}\r\n` : '';
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = await readUntil(s, b => { const i = b.indexOf('\r\n\r\n'); return i >= 0 ? i + 4 : 0; });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
  if (!status || status[1] !== '200') {
    s.destroy();
    throw new Error(`proxy refused the connection (${status ? status[1] : 'bad reply'})`);
  }
  return s;
}

async function socks5Connect(proxy, host, port) {
  const s = await connectSocket(proxy.host, proxy.port);
  const fail = (msg) => { s.destroy(); throw new Error(`SOCKS5: ${msg}`); };
  s.write(Buffer.from(proxy.user ? [5, 2, 0, 2] : [5, 1, 0]));
  const hello = await readUntil(s, b => (b.length >= 2 ? 2 : 0));
  if (hello[0] !== 5 || hello[1] === 0xff) fail('no acceptable login method');
  if (hello[1] === 2) {
    const u = Buffer.from(proxy.user || ''), p = Buffer.from(proxy.pass || '');
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await readUntil(s, b => (b.length >= 2 ? 2 : 0));
    if (auth[1] !== 0) fail('login rejected');
  }
  const h = Buffer.from(host);
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
  const reply = await readUntil(s, (b) => {
    if (b.length < 5) return 0;
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : 1 + b[4];
    return b.length >= 4 + len + 2 ? 4 + len + 2 : 0;
  });
  if (reply[1] !== 0) fail(`connection failed (code ${reply[1]})`);
  return s;
}

function tunnelAgent(proxy, secure, tlsOptions = {}) {
  const Base = secure ? https.Agent : http.Agent;
  const agent = new Base({ keepAlive: false });
  agent.createConnection = (options, cb) => {
    const host = options.host || options.hostname;
    const port = Number(options.port) || (secure ? 443 : 80);
    const connect = proxy.type === 'socks5' ? socks5Connect : httpConnect;
    connect(proxy, host, port).then((raw) => {
      if (!secure) return cb(null, raw);
      const t = tls.connect({ socket: raw, servername: options.servername || host, ALPNProtocols: ['http/1.1'], ...tlsOptions });
      cb(null, t);
    }, cb);
  };
  return agent;
}

// "PROXY host:port; SOCKS5 host:port; DIRECT" -> first usable entry
function parseRule(rule) {
  for (const part of String(rule || 'DIRECT').split(';')) {
    const m = /^\s*(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^:\s]+):(\d+)\s*$/i.exec(part);
    if (m) return { type: /^SOCKS/i.test(m[1]) ? 'socks5' : 'http', host: m[2], port: Number(m[3]) };
    if (/^\s*DIRECT\s*$/i.test(part)) return null;
  }
  return null;
}

function createRouter(getSettings, resolve, tlsOptions) {
  return async function routeFor(url) {
    const p = getSettings().proxy;
    let proxy = null;
    if (p.mode === 'manual' && p.host) proxy = { type: p.type, host: p.host, port: p.port, user: p.user, pass: p.pass };
    else if ((p.mode === 'system' || p.mode === 'pac') && resolve) proxy = parseRule(await resolve(url));
    if (!proxy) return null;
    const secure = new URL(url).protocol === 'https:';
    if (proxy.type === 'http' && !secure) {
      return { forward: { host: proxy.host, port: proxy.port, auth: proxy.user ? basic(proxy.user, proxy.pass) : null } };
    }
    return { agent: tunnelAgent(proxy, secure, tlsOptions) };
  };
}

module.exports = { createRouter, parseRule, tunnelAgent };
