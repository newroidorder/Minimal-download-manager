//! Starts and stops queues at the times set in the Scheduler window. tick()
//! runs every few seconds; each start/stop fires at most once per minute.

use crate::manager::Manager;
use chrono::{DateTime, Datelike, Local};
use std::collections::HashSet;
use std::sync::Mutex;

pub struct Scheduler {
    manager: Manager,
    fired: Mutex<HashSet<String>>, // "<queue>|start|<date> <time>"
}

impl Scheduler {
    pub fn new(manager: Manager) -> Self {
        Scheduler { manager, fired: Mutex::new(HashSet::new()) }
    }

    pub fn tick_at(&self, now: DateTime<Local>) {
        let date = now.format("%Y-%m-%d").to_string();
        let time = now.format("%H:%M").to_string();
        let day = now.weekday().num_days_from_sunday() as u8;
        let mut fired = self.fired.lock().unwrap();
        for q in &self.manager.settings().get().queues {
            let s = &q.schedule;
            if !s.enabled {
                continue;
            }
            let due = s.start_time == time && if s.start_mode == "once" { s.start_date == date } else { s.days.contains(&day) };
            let start_key = format!("{}|start|{date} {time}", q.id);
            if due && fired.insert(start_key) {
                self.manager.start_queue(&q.id);
            }
            let stop_key = format!("{}|stop|{date} {time}", q.id);
            if s.stop_enabled && s.stop_time == time && fired.insert(stop_key) {
                self.manager.stop_queue(&q.id);
            }
        }
        if fired.len() > 500 {
            fired.clear();
        }
    }

    /// Ticks every 10 seconds until the returned task is aborted.
    pub fn start(self: std::sync::Arc<Self>, rt: &tokio::runtime::Handle) -> tokio::task::JoinHandle<()> {
        rt.spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(10));
            loop {
                iv.tick().await;
                self.tick_at(Local::now());
            }
        })
    }
}
