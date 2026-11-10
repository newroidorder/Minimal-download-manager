//! Global speed limiter (token bucket) shared by every connection. While a
//! connection waits it stops reading its socket, so TCP backpressure slows the
//! server down too.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Limiter {
    state: Mutex<(f64, Instant, f64)>, // tokens, last refill, rate (bytes/s, 0 = off)
}

impl Default for Limiter {
    fn default() -> Self {
        Limiter { state: Mutex::new((0.0, Instant::now(), 0.0)) }
    }
}

fn refill(s: &mut (f64, Instant, f64)) {
    let now = Instant::now();
    if s.2 > 0.0 {
        s.0 = (s.0 + now.duration_since(s.1).as_secs_f64() * s.2).min(s.2);
    }
    s.1 = now;
}

impl Limiter {
    pub fn set(&self, bytes_per_second: u64) {
        let mut s = self.state.lock().unwrap();
        refill(&mut s);
        s.2 = bytes_per_second as f64;
        s.0 = s.0.min(s.2);
    }

    pub async fn take(&self, n: usize) {
        let wait = {
            let mut s = self.state.lock().unwrap();
            if s.2 <= 0.0 {
                return;
            }
            refill(&mut s);
            s.0 -= n as f64;
            // Concurrent takers share the debt, so waiting is fair across connections.
            if s.0 < 0.0 { (-s.0 / s.2).min(5.0) } else { 0.0 }
        };
        if wait > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(wait)).await;
        }
    }
}
