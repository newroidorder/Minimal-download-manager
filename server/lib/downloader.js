'use strict';

// Segmented HTTP downloader with IDM-style dynamic segmentation.
//
// One probe connection starts at byte 0. Every extra connection takes the back
// half of the largest remaining segment, and so does any connection that
// finishes early. Bytes are written in place into a pre-sized "<name>.part"
// file, so there is no merge step. The segment map is saved next to it in
// "<name>.part.json", which makes pause, retry and restart resumable.

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULTS = {
  maxConnections: 8,
  minSplit: 1024 * 1024,      // never split a remainder smaller than 2 x this
  retries: 5,
  retryBaseMs: 500,
  idleTimeoutMs: 30_000,
  progressIntervalMs: 250,
  stateIntervalMs: 1000
};

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function rawGet(url, headers, signal, idleTimeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, { headers, signal }, resolve);
    req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('connection timed out')));
    req.on('error', reject);
  });
}

// Follows redirects. Credentials are never forwarded to a different origin.
async function open(url, headers, signal, opts, depth = 0) {
  if (depth > 10) throw new Error('too many redirects');
  const res = await rawGet(url, headers, signal, opts.idleTimeoutMs);
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    res.resume();
    const next = new URL(res.headers.location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`refusing redirect to ${next.protocol}`);
    let h = headers;
    if (next.origin !== new URL(url).origin) {
      h = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!/^(cookie|authorization)$/i.test(k)) h[k] = v;
      }
    }
    return open(next.href, h, signal, opts, depth + 1);
  }
  if (res.statusCode >= 400) {
    res.resume();
    throw new HttpError(res.statusCode);
  }
  return { res, url, headers };
}

function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(cd);
  return plain ? (plain[2] ?? plain[1]).trim() : null;
}

function filenameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function sanitize(name) {
  const clean = path.basename(String(name || ''))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return clean || `download_${Date.now()}`;
}

// Creates "<name>.part" exclusively, picking "file (1).zip" etc. when the name
// or an in-progress .part of it is taken. 'wx' makes the claim atomic, so two
// downloads of the same name can never pick the same file.
async function createPart(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const dest = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (fs.existsSync(dest)) continue;
    try {
      return { dest, fd: await fsp.open(dest + '.part', 'wx') };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

function parseContentRange(v) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(v || '');
  return m && { start: +m[1], end: +m[2], total: m[3] === '*' ? null : +m[3] };
}

// A strong ETag, or else Last-Modified, lets a resumed request use If-Range.
function validatorOf(res) {
  const etag = res.headers.etag;
  if (etag && !etag.startsWith('W/')) return etag;
  return res.headers['last-modified'] || null;
}

async function readState(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

/**
 * Downloads job.url.
 *
 * job: { url, filename?, headers?, dir?, dest? }. The folder is job.dir, else
 * resolveDir(filename, mime) once the name is known, else saveDir. When dest
 * is set and its .part/.part.json exist, the download resumes from the saved
 * segment map.
 *
 * Resolves to { status: 'done' | 'paused' | 'cancelled', dest, size }.
 * Pause and cancel are requested with signal.abort('paused') or
 * signal.abort('cancelled'). Any other failure rejects. If the server supports
 * ranges, the .part file is kept and err.dest is set, so a retry resumes.
 */
async function download(job, { saveDir, resolveDir, signal, onProgress = () => {}, ...overrides } = {}) {
  const o = { ...DEFAULTS, ...overrides };
  const headers = job.headers || {};
  const inner = new AbortController();
  const forwardAbort = () => inner.abort(signal.reason);
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let dest = job.dest || null;
  let fd = null;
  let size = 0;
  let canRange = false;
  let validator = null;
  let segments = [];
  let received = 0;
  let firstRes = null;
  let finalUrl = job.url;
  let finalHeaders = headers;
  let stateTimer = null;
  let saving = Promise.resolve();

  const partPath = () => dest + '.part';
  const statePath = () => dest + '.part.json';

  // State records only bytes that are actually written (seg.written), never
  // bytes that are merely claimed (seg.pos). That keeps it safe after a crash.
  // Finished segments are kept too, so the segment bar still shows them after a resume.
  const saveState = () => {
    if (!canRange || !dest) return saving;
    const snapshot = {
      url: job.url, size, validator,
      segments: segments.map(s => ({ start: s.start, pos: s.written, end: s.end }))
    };
    saving = saving.then(() => writeJsonAtomic(statePath(), snapshot)).catch(() => {});
    return saving;
  };

  let lastEmit = 0;
  let lastBytes = 0;
  const progress = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < o.progressIntervalMs) return;
    const speed = lastEmit ? Math.round((received - lastBytes) / ((now - lastEmit) / 1000)) : 0;
    lastEmit = now;
    lastBytes = received;
    onProgress({
      dest, filename: path.basename(dest), size, received, speed,
      connections: segments.filter(s => s.active).length,
      progress: size ? Math.min(99, Math.floor(received / size * 100)) : 0,
      // [start, written, end) per segment, for an IDM-style connection bar
      segments: size ? segments.map(s => [s.start, s.written, s.end + 1]) : []
    });
  };

  try {
    // 1. Try to resume from a saved segment map.
    if (dest) {
      const state = await readState(statePath());
      const saved = state?.url === job.url && state.size && Array.isArray(state.segments) && fs.existsSync(partPath())
        ? state.segments
        : [];
      const first = saved.find(s => s.pos <= s.end);
      if (first) {
        const h = { ...headers, Range: `bytes=${first.pos}-${first.end}` };
        if (state.validator) h['If-Range'] = state.validator;
        const r = await open(job.url, h, inner.signal, o);
        const cr = r.res.statusCode === 206 && parseContentRange(r.res.headers['content-range']);
        if (cr && cr.start === first.pos && cr.total === state.size) {
          size = state.size;
          canRange = true;
          validator = state.validator;
          segments = saved.map(s => ({ start: s.start ?? s.pos, pos: s.pos, written: s.pos, end: s.end, active: false }));
          received = size - segments.reduce((n, s) => n + Math.max(0, s.end - s.pos + 1), 0);
          firstRes = r.res;
          finalUrl = r.url;
          finalHeaders = r.headers;
          fd = await fsp.open(partPath(), 'r+');
        } else {
          r.res.resume(); // file changed on the server, or ranges stopped working: start over
        }
      }
    }

    // 2. Fresh start. Probe with GET bytes=0-, because signed URLs often refuse HEAD.
    //    Ranges are only trusted if the server answers 206 with a Content-Range.
    if (!fd) {
      const probe = await open(job.url, { ...headers, Range: 'bytes=0-' }, inner.signal, o);
      const cr = probe.res.statusCode === 206 && parseContentRange(probe.res.headers['content-range']);
      canRange = !!(cr && cr.start === 0 && cr.total);
      size = canRange ? cr.total : (parseInt(probe.res.headers['content-length'], 10) || 0);
      validator = validatorOf(probe.res);
      finalUrl = probe.url;
      finalHeaders = probe.headers;
      firstRes = probe.res;
      if (dest) {
        fd = await fsp.open(partPath(), 'w');
      } else {
        const name = sanitize(job.filename
          || filenameFromDisposition(probe.res.headers['content-disposition'])
          || filenameFromUrl(finalUrl));
        const mime = (probe.res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const dir = job.dir || (resolveDir && resolveDir(name, mime)) || saveDir;
        await fsp.mkdir(dir, { recursive: true });
        ({ dest, fd } = await createPart(dir, name));
      }
      if (size) await fd.truncate(size);
      segments = [{ start: 0, pos: 0, written: 0, end: size ? size - 1 : Infinity, active: false }];
      received = 0;
    }

    progress(true);
    if (canRange) {
      stateTimer = setInterval(saveState, o.stateIntervalMs);
      stateTimer.unref();
    }

    async function pump(seg, res) {
      for await (const chunk of res) {
        const len = Math.min(chunk.length, seg.end - seg.pos + 1);
        if (len <= 0) break;
        const at = seg.pos;
        seg.pos += len;               // claim the bytes before awaiting, so a split sees the claim
        received += len;
        await fd.write(chunk, 0, len, at);
        seg.written = at + len;
        progress();
        if (seg.pos > seg.end) break;
      }
      res.destroy();
    }

    async function runSegment(seg, res) {
      seg.active = true;
      for (let attempt = 0; ; attempt++) {
        try {
          if (!res) {
            const r = await open(finalUrl, { ...finalHeaders, Range: `bytes=${seg.pos}-${seg.end}` }, inner.signal, o);
            const got = parseContentRange(r.res.headers['content-range']);
            if (r.res.statusCode !== 206 || !got || got.start !== seg.pos) {
              r.res.resume();
              throw new Error('server stopped honoring Range requests');
            }
            res = r.res;
          }
          await pump(seg, res);
          if (seg.pos > seg.end || seg.end === Infinity) break;
          throw new Error('connection closed early');
        } catch (err) {
          res = null;
          const fatal = inner.signal.aborted || !canRange || attempt >= o.retries
            || (err instanceof HttpError && err.status < 500 && err.status !== 429);
          if (fatal) throw err;
          // Bytes claimed but never written must be fetched again.
          received -= seg.pos - seg.written;
          seg.pos = seg.written;
          await new Promise(r => setTimeout(r, o.retryBaseMs * 2 ** attempt));
        }
      }
      seg.active = false;
    }

    // Dynamic segmentation: carve the back half off the largest remaining active segment.
    function steal() {
      let best = null;
      for (const s of segments) {
        if (s.active && s.end - s.pos + 1 >= 2 * o.minSplit && (!best || s.end - s.pos > best.end - best.pos)) best = s;
      }
      if (!best) return null;
      const mid = best.pos + Math.floor((best.end - best.pos + 1) / 2);
      const seg = { start: mid, pos: mid, written: mid, end: best.end, active: true };
      best.end = mid - 1;
      segments.push(seg);
      return seg;
    }

    // Unfinished segments first (several when resuming), then steal.
    const unassigned = segments.filter(s => s.pos <= s.end);
    const next = () => unassigned.shift() || (canRange ? steal() : null);

    async function worker(seg, res) {
      while (seg) {
        await runSegment(seg, res);
        res = null;
        seg = next();
      }
    }

    const workers = [worker(unassigned.shift(), firstRes)];
    while (workers.length < o.maxConnections) {
      const seg = next();
      if (!seg) break;
      workers.push(worker(seg));
    }
    // Fail fast: one fatal segment stops the others.
    await Promise.all(workers.map(w => w.catch(err => { inner.abort(err); throw err; })));

    if (size && received !== size) throw new Error(`size mismatch: got ${received} of ${size} bytes`);
    clearInterval(stateTimer);
    await saving;
    await fd.close();
    fd = null;
    await fsp.rename(partPath(), dest);
    await fsp.unlink(statePath()).catch(() => {});
    onProgress({ dest, filename: path.basename(dest), size: size || received, received, speed: 0, connections: 0, progress: 100 });
    return { status: 'done', dest, size: size || received };
  } catch (err) {
    clearInterval(stateTimer);
    if (fd) await fd.close().catch(() => {});
    const reason = signal?.aborted ? signal.reason : null;
    const removePart = async () => {
      if (!dest) return;
      await saving;
      await fsp.unlink(partPath()).catch(() => {});
      await fsp.unlink(statePath()).catch(() => {});
    };

    if (reason === 'cancelled') {
      await removePart();
      return { status: 'cancelled', dest: null, size };
    }
    if (reason === 'paused') {
      if (canRange) {
        await saveState();
        return { status: 'paused', dest, size };
      }
      await removePart(); // no ranges: resuming means starting over
      return { status: 'paused', dest: null, size };
    }
    if (canRange && dest) {
      await saveState();
      err.dest = dest;
    } else {
      await removePart();
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// Reads a file's name, size and type without downloading it (for the
// "Download File Info" dialog). The probe connection is closed right away.
async function inspect(url, { headers = {}, signal, ...overrides } = {}) {
  const o = { ...DEFAULTS, ...overrides };
  const { res, url: finalUrl } = await open(url, { ...headers, Range: 'bytes=0-' }, signal, o);
  res.destroy();
  const cr = res.statusCode === 206 && parseContentRange(res.headers['content-range']);
  const canRange = !!(cr && cr.start === 0 && cr.total);
  return {
    filename: sanitize(filenameFromDisposition(res.headers['content-disposition']) || filenameFromUrl(finalUrl)),
    size: canRange ? cr.total : (res.statusCode === 200 && parseInt(res.headers['content-length'], 10)) || 0,
    mime: (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
    canRange
  };
}

module.exports = { download, inspect, sanitize, filenameFromDisposition, filenameFromUrl, HttpError };
