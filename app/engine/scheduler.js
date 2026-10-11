'use strict';

// Starts and stops queues at the times set in the Scheduler window.
// tick() runs every few seconds; each start/stop fires at most once per minute.

const pad = (n) => String(n).padStart(2, '0');

function stamp(d) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    day: d.getDay()
  };
}

class Scheduler {
  constructor(settings, manager, now = () => new Date()) {
    this.settings = settings;
    this.manager = manager;
    this.now = now;
    this.fired = new Set(); // "<queue>|start|<date> <time>"
    this.timer = null;
  }

  start(intervalMs = 10_000) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const t = stamp(this.now());
    for (const q of this.settings.get().queues) {
      const s = q.schedule;
      if (!s.enabled) continue;
      const due = s.startTime === t.time && (s.startMode === 'once' ? s.startDate === t.date : s.days.includes(t.day));
      const startKey = `${q.id}|start|${t.date} ${t.time}`;
      if (due && !this.fired.has(startKey)) {
        this.fired.add(startKey);
        this.manager.startQueue(q.id);
      }
      const stopKey = `${q.id}|stop|${t.date} ${t.time}`;
      if (s.stopEnabled && s.stopTime === t.time && !this.fired.has(stopKey)) {
        this.fired.add(stopKey);
        this.manager.stopQueue(q.id);
      }
    }
    if (this.fired.size > 500) this.fired.clear();
  }
}

module.exports = { Scheduler };
