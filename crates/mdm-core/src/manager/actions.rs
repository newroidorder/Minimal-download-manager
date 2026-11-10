//! User actions on downloads and queues, and saving the list.

use super::*;
use crate::downloader::Stop;

impl Manager {
    fn stop_running(st: &State, id: &str, why: Stop) {
        if let Some(c) = st.controllers.get(id) {
            c.stop(why);
        }
    }

    fn clear_retry(st: &mut State, id: &str) {
        if let Some(t) = st.retry.remove(id) {
            t.abort();
        }
    }

    pub fn pause(&self, id: &str) -> Option<Item> {
        let mut st = self.lock();
        Self::clear_retry(&mut st, id);
        let status = st.items.get(id)?.status.clone();
        if is_active(&status) {
            Self::stop_running(&st, id, Stop::Paused);
        } else if status == "queued" || status == "error" {
            self.update(&mut st, id, true, |i| i.status = "paused".into());
        }
        st.items.get(id).cloned()
    }

    pub fn resume(&self, id: &str) -> Option<Item> {
        let mut st = self.lock();
        Self::clear_retry(&mut st, id);
        let item = st.items.get(id)?.clone();
        if ["paused", "error", "cancelled"].contains(&item.status.as_str()) {
            // Resuming a download that sits in a stopped queue starts it now.
            let detach = item.queue_id.as_ref().is_some_and(|q| !st.running_queues.contains(q));
            self.update(&mut st, id, true, |i| {
                i.status = "queued".into();
                i.error = None;
                i.retries = 0;
                if detach {
                    i.queue_id = None;
                }
            });
            drop(st);
            self.pump();
        }
        self.get(id)
    }

    pub async fn cancel(&self, id: &str) -> Option<Item> {
        let item = {
            let mut st = self.lock();
            Self::clear_retry(&mut st, id);
            let item = st.items.get(id)?.clone();
            if is_active(&item.status) {
                Self::stop_running(&st, id, Stop::Cancelled);
                return Some(item);
            }
            item
        };
        if !["done", "cancelled", "scanning"].contains(&item.status.as_str()) {
            discard_part(&item);
            let mut st = self.lock();
            self.update(&mut st, id, true, |i| {
                i.status = "cancelled".into();
                i.dest = None;
                i.progress = 0;
                i.received = 0;
                i.segments.clear();
            });
            st.secrets.remove(id);
        }
        self.get(id)
    }

    /// Waits until the download is no longer starting, downloading or scanning.
    pub async fn wait_idle(&self, id: &str) {
        loop {
            let notified = self.0.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let running = {
                let st = self.lock();
                st.items.get(id).is_some_and(|i| is_busy(&i.status)) || st.controllers.contains_key(id)
            };
            if !running {
                return;
            }
            notified.await;
        }
    }

    async fn stop_and_wait(&self, id: &str) {
        Self::stop_running(&self.lock(), id, Stop::Cancelled);
        self.wait_idle(id).await;
    }

    /// delete_file: also delete the downloaded file from disk.
    pub async fn remove(&self, id: &str, delete_file: bool) -> bool {
        let Some(item) = ({
            let mut st = self.lock();
            Self::clear_retry(&mut st, id);
            st.items.get(id).cloned()
        }) else {
            return false;
        };
        if is_active(&item.status) {
            self.stop_and_wait(id).await;
        } else if item.status != "done" {
            discard_part(&item);
        }
        if delete_file && item.status == "done" {
            if let Some(d) = &item.dest {
                let _ = std::fs::remove_file(d);
            }
        }
        let mut st = self.lock();
        self.forget_locked(&mut st, id);
        true
    }

    pub(super) fn forget_locked(&self, st: &mut State, id: &str) {
        st.items.shift_remove(id);
        st.secrets.remove(id);
        self.emit(Event::Remove(id.to_string()));
        self.persist(st);
        self.0.idle.notify_waiters();
    }

    pub fn remove_completed(&self) -> usize {
        let mut st = self.lock();
        let done: Vec<String> = st.items.values().filter(|i| i.status == "done").map(|i| i.id.clone()).collect();
        for id in &done {
            self.forget_locked(&mut st, id);
        }
        done.len()
    }

    /// "Stop all": every running or waiting download is paused.
    pub fn stop_all(&self) {
        let ids: Vec<String> = {
            let st = self.lock();
            st.items.values().filter(|i| is_active(&i.status) || i.status == "queued" || st.retry.contains_key(&i.id)).map(|i| i.id.clone()).collect()
        };
        for id in ids {
            self.pause(&id);
        }
        let mut st = self.lock();
        st.running_queues.clear();
        self.emit(Event::Queues(vec![]));
    }

    /// Download again from scratch, replacing the old file.
    pub async fn redownload(&self, id: &str) -> Option<Item> {
        let item = self.get(id)?;
        if is_busy(&item.status) {
            self.stop_and_wait(id).await;
        }
        let item = self.get(id)?;
        discard_part(&item);
        if item.status == "done" {
            if let Some(d) = &item.dest {
                let _ = std::fs::remove_file(d);
            }
        }
        {
            let mut st = self.lock();
            self.update(&mut st, id, true, |i| {
                i.status = "queued".into();
                i.requested_name = Some(i.requested_name.clone().unwrap_or_else(|| i.filename.clone()));
                i.dest = None;
                i.received = 0;
                i.progress = 0;
                i.error = None;
                i.retries = 0;
                i.segments.clear();
                i.finished_at = None;
            });
        }
        self.pump();
        self.get(id)
    }

    /// Properties window: description, and a new address for an unfinished download.
    pub fn edit(&self, id: &str, description: Option<&str>, url: Option<&str>) -> Result<Option<Item>, String> {
        let mut st = self.lock();
        let Some(item) = st.items.get(id).cloned() else { return Ok(None) };
        let mut new_url = None;
        if let Some(u) = url.map(str::trim).filter(|u| !u.is_empty() && *u != item.url) {
            if item.status == "done" || is_busy(&item.status) {
                return Err("the address can only change while the download is stopped".into());
            }
            let parsed = Url::parse(u).map_err(|_| "invalid address".to_string())?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err("only http and https addresses are supported".into());
            }
            new_url = Some(parsed.to_string());
        }
        Ok(self.update(&mut st, id, true, |i| {
            if let Some(d) = description {
                i.description = d.chars().take(500).collect();
            }
            if let Some(u) = new_url {
                i.url = u;
            }
        }))
    }

    // ---------- queues ----------

    pub fn set_queue(&self, ids: &[String], queue_id: Option<&str>) -> Result<(), String> {
        if let Some(q) = queue_id {
            if self.0.settings.queue(q).is_none() {
                return Err("unknown queue".into());
            }
        }
        {
            let mut st = self.lock();
            for id in ids {
                let Some(item) = st.items.get(id).cloned() else { continue };
                if item.status == "done" {
                    continue;
                }
                let order = queue_id.map(|q| next_order(&st, q));
                self.update(&mut st, id, true, |i| {
                    i.queue_id = queue_id.map(String::from);
                    if let Some(o) = order {
                        i.queue_order = o;
                        if i.status == "paused" || i.status == "error" {
                            i.status = "queued".into();
                        }
                    } else if i.status == "queued" {
                        i.status = "paused".into(); // taken out of a queue: wait for the user
                    }
                });
            }
        }
        self.pump();
        Ok(())
    }

    pub fn reorder_queue(&self, queue_id: &str, ids: &[String]) {
        let mut st = self.lock();
        for (n, id) in ids.iter().enumerate() {
            if st.items.get(id).is_some_and(|i| i.queue_id.as_deref() == Some(queue_id)) {
                self.update(&mut st, id, true, |i| i.queue_order = n as u64 + 1);
            }
        }
    }

    pub fn start_queue(&self, queue_id: &str) -> bool {
        let Some(q) = self.0.settings.queue(queue_id) else { return false };
        {
            let mut st = self.lock();
            if st.running_queues.iter().any(|x| x == queue_id) {
                return false;
            }
            let ids: Vec<String> = st.items.values().filter(|i| i.queue_id.as_deref() == Some(queue_id) && (i.status == "paused" || i.status == "error")).map(|i| i.id.clone()).collect();
            for id in ids {
                Self::clear_retry(&mut st, &id);
                self.update(&mut st, &id, true, |i| {
                    i.status = "queued".into();
                    i.error = None;
                });
            }
            st.running_queues.push(queue_id.to_string());
            self.emit(Event::Queues(st.running_queues.clone()));
            self.emit(Event::QueueStart(Some(q)));
        }
        self.pump();
        true
    }

    pub fn stop_queue(&self, queue_id: &str) -> bool {
        let mut st = self.lock();
        let before = st.running_queues.len();
        st.running_queues.retain(|q| q != queue_id);
        if st.running_queues.len() == before {
            return false;
        }
        for i in st.items.values().filter(|i| i.queue_id.as_deref() == Some(queue_id) && is_active(&i.status)) {
            Self::stop_running(&st, &i.id, Stop::Paused);
        }
        self.emit(Event::Queues(st.running_queues.clone()));
        true
    }

    pub(super) fn finish_queue(&self, st: &mut State, queue_id: &str) {
        st.running_queues.retain(|q| q != queue_id);
        self.emit(Event::Queues(st.running_queues.clone()));
        let q = self.0.settings.queue(queue_id);
        let after = q.as_ref().map_or("none".to_string(), |q| q.schedule.after_finish.clone());
        self.emit(Event::QueueEnd(q, after));
    }

    pub fn delete_queue(&self, queue_id: &str) -> Result<(), String> {
        if queue_id == "main" {
            return Err("the main queue cannot be deleted".into());
        }
        self.stop_queue(queue_id);
        {
            let mut st = self.lock();
            let ids: Vec<String> = st.items.values().filter(|i| i.queue_id.as_deref() == Some(queue_id)).map(|i| i.id.clone()).collect();
            for id in ids {
                self.update(&mut st, &id, true, |i| {
                    i.queue_id = None;
                    if i.status == "queued" {
                        i.status = "paused".into();
                    }
                });
            }
        }
        let queues: Vec<_> = self.0.settings.get().queues.iter().filter(|q| q.id != queue_id).map(|q| serde_json::json!({ "id": q.id })).collect();
        self.0.settings.update(&serde_json::json!({ "queues": queues })).map(|_| ())
    }

    // ---------- disk ----------

    pub(super) fn persist(&self, st: &mut State) {
        if self.0.state_file.is_none() || st.persist_pending {
            return;
        }
        st.persist_pending = true;
        let m = self.clone();
        self.0.rt.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            m.lock().persist_pending = false;
            let _ = m.flush();
        });
    }

    pub fn flush(&self) -> std::io::Result<()> {
        let Some(file) = &self.0.state_file else { return Ok(()) };
        let items: Vec<serde_json::Value> = self
            .lock()
            .items
            .values()
            .map(|i| {
                let mut v = serde_json::to_value(i).unwrap_or_default();
                if let Some(o) = v.as_object_mut() {
                    for k in LIVE_ONLY {
                        o.remove(k);
                    }
                }
                v
            })
            .collect();
        let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
        std::fs::write(&tmp, serde_json::to_string_pretty(&items).unwrap_or_default())?;
        std::fs::rename(tmp, file)
    }

    /// Pauses running downloads (they resume from where they stopped) and saves.
    pub async fn close(&self) {
        let running: Vec<String> = {
            let mut st = self.lock();
            if let Some(t) = st.quota.timer.take() {
                t.abort();
            }
            for (_, t) in st.retry.drain() {
                t.abort();
            }
            let ids: Vec<String> = st.controllers.keys().cloned().collect();
            for id in &ids {
                Self::stop_running(&st, id, Stop::Paused);
            }
            ids
        };
        for id in running {
            self.wait_idle(&id).await;
        }
        let _ = self.flush();
    }
}

pub(super) fn discard_part(item: &Item) {
    if let Some(d) = &item.dest {
        let _ = std::fs::remove_file(format!("{d}.part"));
        let _ = std::fs::remove_file(format!("{d}.part.json"));
    }
}
