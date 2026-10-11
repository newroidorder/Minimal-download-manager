'use strict';

// Global speed limiter (token bucket) shared by every connection.
// take(n) resolves when n bytes may pass. While a connection waits, it stops
// reading its socket, so TCP backpressure slows the server down too.

class Limiter {
  constructor(bytesPerSecond = 0) {
    this.tokens = 0;
    this.last = Date.now();
    this.set(bytesPerSecond);
  }

  set(bytesPerSecond) {
    this.refill();
    this.rate = bytesPerSecond > 0 ? bytesPerSecond : 0;
    this.tokens = Math.min(this.tokens, this.rate);
  }

  refill() {
    const now = Date.now();
    if (this.rate) this.tokens = Math.min(this.rate, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
  }

  async take(n) {
    if (!this.rate) return;
    this.refill();
    this.tokens -= n;
    // Concurrent takers share the debt, so waiting is fair across connections.
    if (this.tokens < 0) await new Promise(r => setTimeout(r, Math.min(5000, -this.tokens / this.rate * 1000)));
  }
}

module.exports = { Limiter };
