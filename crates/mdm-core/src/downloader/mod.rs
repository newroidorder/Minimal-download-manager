//! Segmented HTTP downloader with dynamic segmentation.
//!
//! One probe connection starts at byte 0. Every extra connection takes the back
//! half of the largest remaining segment, and so does any connection that
//! finishes early. Bytes are written in place into a pre-sized (sparse)
//! "<name>.part" file, so there is no merge step. The segment map is saved next
//! to it in "<name>.part.json", which makes pause, retry and restart resumable.

use crate::http::{cancellable, filename_from_disposition, filename_from_url, header, mime_of, open, range_of, sanitize, validator_of, with, Headers, HttpError};
use crate::limiter::Limiter;
use reqwest::{Client, Response};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Bytes gathered per connection before one positional write.
const WRITE_BUF: usize = 256 * 1024;
const UNKNOWN: u64 = u64::MAX;

mod start;
use start::{start_fresh, try_resume, Ctx, Started};

pub struct Job {
    pub url: String,
    pub filename: Option<String>,
    pub headers: Headers,
    pub dir: Option<PathBuf>,
    /// Set to resume from "<dest>.part" + "<dest>.part.json".
    pub dest: Option<PathBuf>,
}

pub type ResolveDir = Arc<dyn Fn(&str, &str) -> Option<PathBuf> + Send + Sync>;

#[derive(Clone)]
pub struct Options {
    pub client: Client,
    pub max_connections: usize,
    pub min_split: u64,
    pub retries: u32,
    pub retry_base: Duration,
    pub progress_interval: Duration,
    pub state_interval: Duration,
    pub limiter: Option<Arc<Limiter>>,
    pub on_bytes: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    pub save_dir: PathBuf,
    pub resolve_dir: Option<ResolveDir>,
    pub on_progress: Arc<dyn Fn(Progress) + Send + Sync>,
}

impl Options {
    pub fn new(client: Client, save_dir: PathBuf) -> Self {
        Options {
            client,
            max_connections: 8,
            min_split: 1024 * 1024, // never split a remainder smaller than 2 x this
            retries: 5,
            retry_base: Duration::from_millis(500),
            progress_interval: Duration::from_millis(250),
            state_interval: Duration::from_secs(1),
            limiter: None,
            on_bytes: None,
            save_dir,
            resolve_dir: None,
            on_progress: Arc::new(|_| {}),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub dest: String,
    pub filename: String,
    pub size: u64,
    pub received: u64,
    pub speed: u64,
    pub connections: usize,
    pub resumable: bool,
    pub progress: u8,
    /// [start, written, end) per segment, for the connection bar
    pub segments: Vec<[u64; 3]>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Stop {
    Paused,
    Cancelled,
    Failed(String),
}

/// Pause / cancel handle for one running download.
#[derive(Default)]
pub struct Control {
    pub token: CancellationToken,
    reason: Mutex<Option<Stop>>,
}

impl Control {
    pub fn stop(&self, why: Stop) {
        self.reason.lock().unwrap().get_or_insert(why);
        self.token.cancel();
    }
    pub fn reason(&self) -> Option<Stop> {
        self.reason.lock().unwrap().clone()
    }
}

#[derive(Debug)]
pub enum Outcome {
    Done { dest: PathBuf, size: u64, last_modified: Option<String> },
    Paused { dest: Option<PathBuf>, size: u64 },
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct DlError {
    pub message: String,
    pub status: Option<u16>,
    /// The .part file was kept, so a retry resumes.
    pub dest: Option<PathBuf>,
}

impl std::fmt::Display for DlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Clone, Copy)]
struct Seg {
    start: u64,
    pos: u64,     // claimed up to here
    written: u64, // on disk up to here; the only thing saved, so a crash is safe
    end: u64,     // inclusive
    active: bool,
}

impl Seg {
    fn left(&self) -> u64 {
        if self.pos > self.end { 0 } else { (self.end - self.pos).saturating_add(1) }
    }
}

struct Shared {
    url: String,
    dest: PathBuf,
    size: u64,
    can_range: bool,
    validator: Option<String>,
    segs: Mutex<Vec<Seg>>,
    queue: Mutex<VecDeque<usize>>,
    received: AtomicU64,
    prog: Mutex<(Option<Instant>, u64)>,
}

fn part(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", dest.display()))
}

fn state_file(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part.json", dest.display()))
}

impl Shared {
    fn save_state(&self) {
        if !self.can_range {
            return;
        }
        let segs: Vec<Value> = self.segs.lock().unwrap().iter().map(|s| json!({ "start": s.start, "pos": s.written, "end": s.end })).collect();
        let snap = json!({ "url": self.url, "size": self.size, "validator": self.validator, "segments": segs });
        let file = state_file(&self.dest);
        let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
        if std::fs::write(&tmp, snap.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }

    fn progress(&self, o: &Options, force: bool) {
        let now = Instant::now();
        let mut p = self.prog.lock().unwrap();
        if !force && p.0.is_some_and(|t| now - t < o.progress_interval) {
            return;
        }
        let received = self.received.load(Relaxed);
        let speed = p.0.map_or(0, |t| ((received.saturating_sub(p.1)) as f64 / (now - t).as_secs_f64().max(0.001)).round() as u64);
        *p = (Some(now), received);
        let segs = self.segs.lock().unwrap();
        (o.on_progress)(Progress {
            dest: self.dest.display().to_string(),
            filename: self.dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            size: self.size,
            received,
            speed,
            connections: segs.iter().filter(|s| s.active).count(),
            resumable: self.can_range,
            progress: if self.size > 0 { (received * 100 / self.size).min(99) as u8 } else { 0 },
            segments: if self.size > 0 { segs.iter().map(|s| [s.start, s.written, s.end.saturating_add(1)]).collect() } else { vec![] },
        });
    }

    /// Unfinished segments first (several when resuming), then steal.
    fn next(&self, o: &Options) -> Option<usize> {
        let mut segs = self.segs.lock().unwrap();
        if let Some(i) = self.queue.lock().unwrap().pop_front() {
            segs[i].active = true;
            return Some(i);
        }
        if !self.can_range {
            return None;
        }
        // Dynamic segmentation: carve the back half off the largest remaining active segment.
        let best = segs.iter().enumerate().filter(|(_, s)| s.active && s.left() >= 2 * o.min_split).max_by_key(|(_, s)| s.left()).map(|(i, _)| i)?;
        let b = segs[best];
        let mid = b.pos + b.left() / 2;
        segs[best].end = mid - 1;
        segs.push(Seg { start: mid, pos: mid, written: mid, end: b.end, active: true });
        Some(segs.len() - 1)
    }
}

fn write_all_at(file: &File, mut buf: &[u8], mut at: u64) -> std::io::Result<()> {
    #[cfg(windows)]
    use std::os::windows::fs::FileExt;
    #[cfg(unix)]
    use std::os::unix::fs::FileExt;
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = file.seek_write(buf, at)?;
        #[cfg(unix)]
        let n = file.write_at(buf, at)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        at += n as u64;
    }
    Ok(())
}

fn io(e: std::io::Error) -> HttpError {
    HttpError::msg(e.to_string())
}

async fn pump(sh: &Shared, o: &Options, file: &File, i: usize, mut res: Response, cancel: &CancellationToken) -> Result<(), HttpError> {
    let mut buf: Vec<u8> = Vec::with_capacity(WRITE_BUF);
    let mut buf_at = 0u64;
    let flush = |buf: &mut Vec<u8>, at: u64| -> Result<(), HttpError> {
        if buf.is_empty() {
            return Ok(());
        }
        write_all_at(file, buf, at).map_err(io)?;
        sh.segs.lock().unwrap()[i].written = at + buf.len() as u64;
        buf.clear();
        Ok(())
    };
    let result = async {
        while let Some(chunk) = cancellable(cancel, async { Ok(res.chunk().await?) }).await? {
            let (at, len, last) = {
                let mut segs = sh.segs.lock().unwrap();
                let s = &mut segs[i];
                let len = (chunk.len() as u64).min(s.left()) as usize;
                if len == 0 {
                    break;
                }
                let at = s.pos;
                s.pos += len as u64; // claim the bytes first, so a split sees the claim
                (at, len, s.pos > s.end)
            };
            sh.received.fetch_add(len as u64, Relaxed);
            if let Some(l) = &o.limiter {
                l.take(len).await; // waiting here slows the socket via backpressure
            }
            if buf.is_empty() {
                buf_at = at;
            }
            buf.extend_from_slice(&chunk[..len]);
            if buf.len() >= WRITE_BUF {
                flush(&mut buf, buf_at)?;
            }
            if let Some(f) = &o.on_bytes {
                f(len as u64);
            }
            sh.progress(o, false);
            if last {
                break;
            }
        }
        Ok(())
    }
    .await;
    let flushed = flush(&mut buf, buf_at); // keep what arrived, even when stopping
    result.and(flushed)
}

async fn run_segment(sh: &Shared, o: &Options, file: &File, i: usize, mut first: Option<Response>, url: &str, headers: &Headers, cancel: &CancellationToken) -> Result<(), HttpError> {
    for attempt in 0.. {
        let r = async {
            let res = match first.take() {
                Some(r) => r,
                None => {
                    let (pos, end) = { let s = sh.segs.lock().unwrap()[i]; (s.pos, s.end) };
                    let op = open(&o.client, url, &with(headers, "Range", format!("bytes={pos}-{end}")), cancel).await?;
                    if range_of(&op.res).map(|c| c.start) != Some(pos) {
                        return Err(HttpError::msg("server stopped honoring Range requests"));
                    }
                    op.res
                }
            };
            pump(sh, o, file, i, res, cancel).await?;
            let s = sh.segs.lock().unwrap()[i];
            if s.pos > s.end || s.end == UNKNOWN { Ok(()) } else { Err(HttpError::msg("connection closed early")) }
        }
        .await;
        let Err(e) = r else { break };
        let fatal = cancel.is_cancelled() || !sh.can_range || attempt >= o.retries || e.status.is_some_and(|s| s < 500 && s != 429);
        if fatal {
            return Err(e);
        }
        {
            // Bytes claimed but never written must be fetched again.
            let mut segs = sh.segs.lock().unwrap();
            let s = &mut segs[i];
            sh.received.fetch_sub(s.pos - s.written, Relaxed);
            s.pos = s.written;
        }
        cancellable(cancel, async {
            tokio::time::sleep(o.retry_base * 2u32.pow(attempt.min(16))).await;
            Ok(())
        })
        .await?;
    }
    sh.segs.lock().unwrap()[i].active = false;
    Ok(())
}

async fn worker(sh: &Shared, o: &Options, file: &File, mut i: usize, mut res: Option<Response>, url: &str, headers: &Headers, cancel: &CancellationToken) -> Result<(), HttpError> {
    loop {
        run_segment(sh, o, file, i, res.take(), url, headers, cancel).await?;
        match sh.next(o) {
            Some(n) => i = n,
            None => return Ok(()),
        }
    }
}

async fn run(job: &Job, o: &Options, ctx: &mut Ctx, cancel: &CancellationToken) -> Result<Outcome, HttpError> {
    let resumed = match &job.dest {
        Some(d) => try_resume(job, o, d, cancel).await?,
        None => None,
    };
    let st = match resumed {
        Some(s) => s,
        None => start_fresh(job, o, ctx, cancel).await?,
    };
    let Started { sh, file, first, url, headers, last_modified } = st;
    ctx.dest = Some(sh.dest.clone());
    ctx.sh = Some(sh.clone());
    sh.progress(o, true);

    let mut workers = Vec::new();
    let mut first = Some(first);
    while workers.len() < o.max_connections.max(1) {
        let Some(i) = sh.next(o) else { break };
        workers.push(worker(&sh, o, &file, i, first.take(), &url, &headers, cancel));
    }
    let saver = async {
        loop {
            tokio::time::sleep(o.state_interval).await;
            sh.save_state();
        }
    };
    // Fail fast: one fatal segment drops (and so stops) the others.
    tokio::select! {
        r = futures_util::future::try_join_all(workers) => { r?; }
        _ = saver => unreachable!(),
    }

    let received = sh.received.load(Relaxed);
    if sh.size > 0 && received != sh.size {
        return Err(HttpError::msg(format!("size mismatch: got {received} of {} bytes", sh.size)));
    }
    file.sync_data().ok();
    drop(file);
    std::fs::rename(part(&sh.dest), &sh.dest).map_err(io)?;
    let _ = std::fs::remove_file(state_file(&sh.dest));
    let size = if sh.size > 0 { sh.size } else { received };
    let filename = sh.dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    (o.on_progress)(Progress { dest: sh.dest.display().to_string(), filename, size, received, speed: 0, connections: 0, resumable: sh.can_range, progress: 100, segments: vec![] });
    Ok(Outcome::Done { dest: sh.dest.clone(), size, last_modified })
}

fn remove_part(dest: &Option<PathBuf>) {
    if let Some(d) = dest {
        let _ = std::fs::remove_file(part(d));
        let _ = std::fs::remove_file(state_file(d));
    }
}

/// Downloads job.url. Pause and cancel go through `control`; any other failure
/// is an error. If the server supports ranges, the .part file is kept and
/// DlError.dest is set, so a retry resumes.
pub async fn download(job: Job, o: Options, control: &Control) -> Result<Outcome, DlError> {
    let mut ctx = Ctx { dest: job.dest.clone(), sh: None };
    let r = run(&job, &o, &mut ctx, &control.token).await;
    let err = match r {
        Ok(out) => return Ok(out),
        Err(e) => e,
    };
    let size = ctx.sh.as_ref().map_or(0, |s| s.size);
    // Keep the .part when it can be resumed: a loaded segment map with ranges,
    // or a resume that stopped before the map was even loaded (files untouched).
    let keep = match &ctx.sh {
        Some(s) => s.can_range && ctx.dest.is_some(),
        None => job.dest.is_some(),
    };
    if keep {
        if let Some(s) = &ctx.sh {
            s.save_state();
        }
    }
    let (message, status) = match control.reason() {
        Some(Stop::Cancelled) => {
            remove_part(&ctx.dest);
            return Ok(Outcome::Cancelled);
        }
        Some(Stop::Paused) if keep => return Ok(Outcome::Paused { dest: ctx.dest, size }),
        Some(Stop::Paused) => {
            remove_part(&ctx.dest); // no ranges: resuming means starting over
            return Ok(Outcome::Paused { dest: None, size });
        }
        Some(Stop::Failed(m)) => (m, None),
        None => (err.message, err.status),
    };
    if !keep {
        remove_part(&ctx.dest);
    }
    Err(DlError { message, status, dest: if keep { ctx.dest } else { None } })
}
