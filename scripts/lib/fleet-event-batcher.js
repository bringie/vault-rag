'use strict';
// EventBatcher: in-mem queue, flushes when size threshold reached or interval elapses.
// If write() lags past lagBudgetMs, new pty_out/pty_in events are dropped (lifecycle/meta kept).

class EventBatcher {
  constructor({ flushSize = 50, flushIntervalMs = 200, lagBudgetMs = 5000, write }) {
    this.flushSize = flushSize;
    this.flushIntervalMs = flushIntervalMs;
    this.lagBudgetMs = lagBudgetMs;
    this.write = write;
    this.queue = [];
    this.flushing = false;
    this.lagStartedAt = null;
    this.stopped = false;
    this.timer = setInterval(() => this._maybeFlush(), this.flushIntervalMs);
    this.timer.unref?.();
  }
  push(event) {
    if (this.stopped) return;
    const drop = this.lagStartedAt
      && Date.now() - this.lagStartedAt > this.lagBudgetMs
      && (event.kind === 'pty_out' || event.kind === 'pty_in');
    if (drop) return;
    this.queue.push(event);
    if (this.queue.length >= this.flushSize) this._maybeFlush();
  }
  async _maybeFlush() {
    if (this.flushing || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.flushing = true;
    const startedAt = Date.now();
    if (this.lagStartedAt === null) this.lagStartedAt = startedAt;
    try {
      await this.write(batch);
      this.lagStartedAt = null;
    } catch (e) {
      const survivors = batch.filter(e => e.kind === 'lifecycle' || e.kind === 'meta');
      this.queue.unshift(...survivors);
    } finally {
      this.flushing = false;
    }
  }
  async shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.queue.length && !this.flushing) {
      await this._maybeFlush();
    }
    while (this.flushing) await new Promise(r => setTimeout(r, 10));
  }
}

module.exports = { EventBatcher };
