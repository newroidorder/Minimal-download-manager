//! Starting downloads: the queue pump, one download's life, retries and the
//! download quota ("Download limits").

use super::*;
use crate::downloader::{download, DlError, Job, Outcome, Progress, Stop};
use std::path::Path;
use std::time::Duration;

impl Manager {
    fn active_in(st: &State, queue_id: Option<&str>) -> usize {
        st.items.values().filter(|i| is_busy(&i.status) && i.queue_id.as_deref() == queue_id).count()
    }

    pub fn pump(&self) {
        let s = self.0.settings.get();
        let mut st = self.lock();
        if st.quota.blocked {
            return;
        }
        let queued = |st: &State, q: Option<&str>| -> Vec<Item> {
            st.items.values().filter(|i| i.status == "queued" && i.queue_id.as_deref() == q && !st.retry.contains_key(&i.id)).cloned().collect()
        };
        // Downloads outside queues start right away, up to "downloads at once".
        let free = (s.connection.max_active as usize).saturating_sub(Self::active_in(&st, None));
        let mut solo = queued(&st, None);
        solo.sort_by_key(|i| i.added_at);
        for item in solo.into_iter().take(free) {
            self.start(&mut st, &item.id);
        }
        // Each running queue downloads its files in order, N at a time.
        for qid in st.running_queues.clone() {
            let Some(q) = s.queues.iter().find(|q| q.id == qid) else {
                st.running_queues.retain(|x| *x != qid);
                continue;
            };
            let qfree = (q.max_concurrent as usize).saturating_sub(Self::active_in(&st, Some(&qid)));
            let mut waiting = queued(&st, Some(&qid));
            waiting.sort_by_key(|i| i.queue_order);
            for item in waiting.into_iter().take(qfree) {
                self.start(&mut st, &item.id);
            }
            let left = st.items.values().any(|i| i.queue_id.as_deref() == Some(&qid) && (is_busy(&i.status) || i.status == "queued"));
            if !left {
                self.finish_queue(&mut st, &qid);
            }
        }
    }

    /// Marks the item as starting (so pump counts it) and spawns the download.
    fn start(&self, st: &mut State, id: &str) {
        if let Some(t) = st.retry.remove(id) {
            t.abort();
        }
        let control = Arc::new(Control::default());
        st.controllers.insert(id.to_string(), control.clone());
        let Some(item) = self.update(st, id, true, |i| {
            i.status = "starting".into();
            i.error = None;
            i.speed = 0;
            i.last_try_at = Some(now_ms());
        }) else {
            return;
        };
        let m = self.clone();
        let id = id.to_string();
        self.0.rt.spawn(async move {
            let job = Job {
                url: item.url.clone(),
                filename: item.requested_name.clone(),
                headers: Vec::new(),
                dir: item.dir.as_ref().map(PathBuf::from),
                dest: item.dest.as_ref().map(PathBuf::from),
            };
            let job = Job { headers: m.headers_for(&item), ..job };
            let opts = m.options_for(&item);
            let r = download(job, opts, &control).await;
            let settings = m.0.settings.get();
            match r {
                Ok(Outcome::Done { dest, size, last_modified }) => m.finish(&id, &dest, size, last_modified, &settings).await,
                Ok(Outcome::Paused { dest, .. }) => {
                    let mut st = m.lock();
                    m.update(&mut st, &id, true, |i| {
                        i.status = if i.quota_paused { "queued" } else { "paused" }.into();
                        i.dest = dest.map(|d| d.display().to_string());
                        i.speed = 0;
                        i.connections = 0;
                    });
                }
                Ok(Outcome::Cancelled) => {
                    let mut st = m.lock();
                    m.update(&mut st, &id, true, |i| {
                        i.status = "cancelled".into();
                        i.dest = None;
                        i.speed = 0;
                        i.connections = 0;
                        i.progress = 0;
                        i.received = 0;
                        i.segments.clear();
                    });
                    st.secrets.remove(&id);
                }
                Err(e) => m.fail(&id, e),
            }
            m.lock().controllers.remove(&id);
            m.0.idle.notify_waiters();
            m.pump();
        });
    }

    fn options_for(&self, item: &Item) -> Options {
        let s = self.0.settings.get();
        let mut o = Options::new(self.client(), self.0.settings.base_dir.clone());
        o.max_connections = self.connections_for(&item.url) as usize;
        o.limiter = Some(self.0.limiter.clone());
        if s.connection.quota.enabled {
            let m = self.clone();
            o.on_bytes = Some(Arc::new(move |n| m.count_bytes(n)));
        }
        let store = self.0.settings.clone();
        o.resolve_dir = Some(Arc::new(move |name, mime| Some(PathBuf::from(store.categorize(name, mime).folder))));
        let (m, id) = (self.clone(), item.id.clone());
        o.on_progress = Arc::new(move |p| m.on_progress(&id, p));
        if let Some(t) = &self.0.tweak {
            t(&mut o);
        }
        o
    }

    fn on_progress(&self, id: &str, p: Progress) {
        let categorize = self.0.settings.clone();
        let mut st = self.lock();
        let Some(cur) = st.items.get(id) else { return };
        let first = cur.dest.as_deref() != Some(p.dest.as_str());
        let had_dir = cur.dir.is_some();
        let category = (first && !had_dir).then(|| categorize.categorize(&p.filename, "").id);
        self.update(&mut st, id, first, |i| {
            i.status = "downloading".into();
            if first {
                i.dir = Path::new(&p.dest).parent().map(|d| d.display().to_string());
                if let Some(c) = category {
                    i.category = c;
                }
            }
            i.dest = Some(p.dest);
            i.filename = p.filename;
            i.size = p.size;
            i.received = p.received;
            i.speed = p.speed;
            i.connections = p.connections;
            i.resumable = p.resumable;
            i.progress = p.progress;
            i.segments = p.segments;
        });
    }

    async fn finish(&self, id: &str, dest: &Path, size: u64, last_modified: Option<String>, s: &crate::settings::Settings) {
        if s.save.set_file_date {
            if let Some(t) = last_modified.and_then(|lm| chrono::DateTime::parse_from_rfc2822(&lm).ok()) {
                if let Ok(f) = std::fs::File::options().write(true).open(dest) {
                    let _ = f.set_modified(t.into());
                }
            }
        }
        let dest_s = dest.display().to_string();
        let done = |i: &mut Item| {
            i.status = "done".into();
            i.dest = Some(dest_s.clone());
            i.filename = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            i.dir = dest.parent().map(|d| d.display().to_string());
            i.size = size;
            i.received = size;
            i.progress = 100;
            i.speed = 0;
            i.connections = 0;
            i.segments.clear();
            i.finished_at = Some(now_ms());
            i.retries = 0;
            i.error = None;
        };
        let av = &s.downloads.antivirus;
        let mut scan = None;
        if let (true, false, Some(run)) = (av.enabled, av.program.is_empty(), &self.0.run_program) {
            {
                let mut st = self.lock();
                self.update(&mut st, id, true, |i| {
                    done(i);
                    i.status = "scanning".into();
                });
            }
            scan = Some(match run(av.program.clone(), av.args.clone(), dest_s.clone()).await {
                Ok(0) => "clean".to_string(),
                Ok(code) => format!("warning (exit code {code})"),
                Err(e) => format!("could not run the antivirus: {e}"),
            });
        }
        let mut st = self.lock();
        let item = self.update(&mut st, id, true, |i| {
            done(i);
            if scan.is_some() {
                i.scan = scan;
            }
        });
        st.secrets.remove(id);
        if let Some(i) = item {
            self.emit(Event::Complete(i));
        }
    }

    fn fail(&self, id: &str, err: DlError) {
        let s = self.0.settings.get();
        let retryable = err.status.is_none_or(|c| c >= 500 || c == 408 || c == 429);
        let attempts = s.retry.attempts;
        let mut st = self.lock();
        let Some(item) = self.update(&mut st, id, true, |i| {
            i.status = "error".into();
            i.error = Some(err.message.clone());
            if let Some(d) = &err.dest {
                i.dest = Some(d.display().to_string());
            }
            i.speed = 0;
            i.connections = 0;
        }) else {
            return;
        };
        if item.retries == 0 {
            self.emit(Event::Failed(item.clone()));
        }
        if retryable && (attempts == 0 || item.retries < attempts) {
            let m = self.clone();
            let id2 = id.to_string();
            let delay = Duration::from_secs(s.retry.delay as u64);
            let t = self.0.rt.spawn(async move {
                tokio::time::sleep(delay).await;
                {
                    let mut st = m.lock();
                    st.retry.remove(&id2);
                    if st.items.get(&id2).is_some_and(|i| i.status == "error") {
                        m.update(&mut st, &id2, true, |i| {
                            i.status = "queued".into();
                            i.retries += 1;
                        });
                    }
                }
                m.pump();
            });
            st.retry.insert(id.to_string(), t.abort_handle());
        }
    }

    // ---------- download quota ----------

    fn count_bytes(&self, n: u64) {
        let q = self.0.settings.get().connection.quota.clone();
        if !q.enabled {
            return;
        }
        let now = now_ms();
        let window = q.hours as i64 * 3_600_000;
        let mut st = self.lock();
        if now - st.quota.window_start >= window {
            st.quota.window_start = now;
            st.quota.bytes = 0;
            st.quota.warned = false;
        }
        st.quota.bytes += n;
        let limit = q.mb * 1024 * 1024;
        if q.warn && !st.quota.warned && st.quota.bytes as f64 >= limit as f64 * 0.9 {
            st.quota.warned = true;
            self.emit(Event::QuotaWarning { mb: q.mb, hours: q.hours });
        }
        if !st.quota.blocked && st.quota.bytes >= limit {
            st.quota.blocked = true;
            let until = st.quota.window_start + window;
            let ids: Vec<String> = st.items.values().filter(|i| is_active(&i.status)).map(|i| i.id.clone()).collect();
            for id in ids {
                if let Some(i) = st.items.get_mut(&id) {
                    i.quota_paused = true;
                }
                if let Some(c) = st.controllers.get(&id) {
                    c.stop(Stop::Paused);
                }
            }
            self.emit(Event::Quota { until });
            let m = self.clone();
            let t = self.0.rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis((until - now).max(0) as u64)).await;
                m.unblock_quota();
            });
            st.quota.timer = Some(t.abort_handle());
        }
    }

    fn unblock_quota(&self) {
        {
            let mut st = self.lock();
            st.quota = QuotaState { window_start: now_ms(), ..Default::default() };
            for i in st.items.values_mut() {
                i.quota_paused = false;
            }
        }
        self.pump();
    }
}
