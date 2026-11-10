//! Starting a download: resuming from a saved segment map, or a fresh probe.

use super::*;

/// Sparse file: pre-sizing then writing far into it doesn't zero-fill the gap first.
pub(super) fn make_sparse(file: &File) {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::io::AsRawHandle;
        let mut n = 0u32;
        windows_sys::Win32::System::IO::DeviceIoControl(
            file.as_raw_handle() as _,
            windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut n,
            std::ptr::null_mut(),
        );
    }
    #[cfg(not(windows))]
    let _ = file;
}

/// Creates "<name>.part" exclusively, picking "file (1).zip" etc. when the name
/// or an in-progress .part of it is taken. create_new makes the claim atomic.
pub(super) fn create_part(dir: &Path, name: &str) -> std::io::Result<(PathBuf, File)> {
    let p = Path::new(name);
    let (stem, ext) = match (p.file_stem(), p.extension()) {
        (Some(s), Some(e)) => (s.to_string_lossy().into_owned(), format!(".{}", e.to_string_lossy())),
        _ => (name.to_string(), String::new()),
    };
    for i in 0.. {
        let dest = dir.join(if i == 0 { name.to_string() } else { format!("{stem} ({i}){ext}") });
        if dest.exists() {
            continue;
        }
        match OpenOptions::new().read(true).write(true).create_new(true).open(part(&dest)) {
            Ok(f) => return Ok((dest, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

pub(super) struct Started {
    pub(super) sh: Arc<Shared>,
    pub(super) file: File,
    pub(super) first: Response,
    pub(super) url: String,
    pub(super) headers: Headers,
    pub(super) last_modified: Option<String>,
}

/// Picks up a saved segment map if the server still has the same file.
pub(super) async fn try_resume(job: &Job, o: &Options, dest: &Path, cancel: &CancellationToken) -> Result<Option<Started>, HttpError> {
    let state: Value = match std::fs::read_to_string(state_file(dest)).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => return Ok(None),
    };
    let size = state["size"].as_u64().unwrap_or(0);
    if state["url"].as_str() != Some(&job.url) || size == 0 || !part(dest).exists() {
        return Ok(None);
    }
    let segs: Vec<Seg> = state["segments"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let pos = s["pos"].as_u64()?;
                    let end = s["end"].as_u64()?;
                    Some(Seg { start: s["start"].as_u64().unwrap_or(pos), pos, written: pos, end, active: false })
                })
                .collect()
        })
        .unwrap_or_default();
    let Some(first) = segs.iter().find(|s| s.pos <= s.end).copied() else { return Ok(None) };
    let validator = state["validator"].as_str().map(String::from);
    let mut h = with(&job.headers, "Range", format!("bytes={}-{}", first.pos, first.end));
    if let Some(v) = &validator {
        h = with(&h, "If-Range", v.clone());
    }
    let op = open(&o.client, &job.url, &h, cancel).await?;
    let cr = range_of(&op.res);
    if !cr.is_some_and(|c| c.start == first.pos && c.total == Some(size)) {
        return Ok(None); // file changed on the server, or ranges stopped working: start over
    }
    let file = OpenOptions::new().read(true).write(true).open(part(dest)).map_err(io)?;
    let left: u64 = segs.iter().map(Seg::left).sum();
    let queue = segs.iter().enumerate().filter(|(_, s)| s.pos <= s.end).map(|(i, _)| i).collect();
    let sh = Shared {
        url: job.url.clone(),
        dest: dest.to_path_buf(),
        size,
        can_range: true,
        validator,
        segs: Mutex::new(segs),
        queue: Mutex::new(queue),
        received: AtomicU64::new(size - left),
        prog: Mutex::new((None, 0)),
    };
    let last_modified = header(&op.res, "last-modified").map(String::from);
    Ok(Some(Started { sh: Arc::new(sh), file, first: op.res, url: op.url.to_string(), headers: op.headers, last_modified }))
}

/// Fresh start. Probes with GET bytes=0-, because signed URLs often refuse HEAD.
/// Ranges are only trusted if the server answers 206 with a Content-Range.
pub(super) async fn start_fresh(job: &Job, o: &Options, ctx: &mut Ctx, cancel: &CancellationToken) -> Result<Started, HttpError> {
    let probe = open(&o.client, &job.url, &with(&job.headers, "Range", "bytes=0-".into()), cancel).await?;
    let cr = range_of(&probe.res).filter(|c| c.start == 0 && c.total.is_some_and(|t| t > 0));
    let can_range = cr.is_some();
    let size = cr.map_or_else(|| probe.res.content_length().unwrap_or(0), |c| c.total.unwrap_or(0));
    let (dest, file) = match &job.dest {
        Some(d) => {
            // The old map no longer matches once the .part is emptied.
            let _ = std::fs::remove_file(state_file(d));
            (d.clone(), OpenOptions::new().read(true).write(true).create(true).truncate(true).open(part(d)).map_err(io)?)
        }
        None => {
            let disposition = filename_from_disposition(header(&probe.res, "content-disposition"));
            let name = sanitize(&job.filename.clone().or(disposition).or_else(|| filename_from_url(probe.url.as_str())).unwrap_or_default());
            let mime = mime_of(&probe.res);
            let dir = job.dir.clone().or_else(|| o.resolve_dir.as_ref().and_then(|f| f(&name, &mime))).unwrap_or_else(|| o.save_dir.clone());
            std::fs::create_dir_all(&dir).map_err(io)?;
            create_part(&dir, &name).map_err(io)?
        }
    };
    ctx.dest = Some(dest.clone());
    if size > 0 {
        make_sparse(&file);
        file.set_len(size).map_err(io)?;
    }
    let sh = Shared {
        url: job.url.clone(),
        dest,
        size,
        can_range,
        validator: validator_of(&probe.res),
        segs: Mutex::new(vec![Seg { start: 0, pos: 0, written: 0, end: if size > 0 { size - 1 } else { UNKNOWN }, active: false }]),
        queue: Mutex::new(VecDeque::from([0])),
        received: AtomicU64::new(0),
        prog: Mutex::new((None, 0)),
    };
    let last_modified = header(&probe.res, "last-modified").map(String::from);
    Ok(Started { sh: Arc::new(sh), file, first: probe.res, url: probe.url.to_string(), headers: probe.headers, last_modified })
}

#[derive(Default)]
pub(super) struct Ctx {
    pub(super) dest: Option<PathBuf>,
    pub(super) sh: Option<Arc<Shared>>,
}

