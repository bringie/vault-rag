'use strict';
// FIFO byte-budgeted ring buffer of {seq, data} frames.
// Caller appends frames in monotonic seq order. snapshot() returns a copy.
// When total bytes exceeds capacity, oldest frames are dropped until <= capacity.

class RingBuffer {
  constructor(capacityBytes) {
    this.cap = capacityBytes;
    this.frames = [];
    this.bytes = 0;
    this.lastSeq = null;  // vt-0304: most recent seq we accepted
  }
  append({ seq, data }) {
    // vt-0304: skip frames we've already seen — replayed pty_data lands
    // here too, and we don't want to broadcast duplicates to viewers.
    if (this.lastSeq != null && seq <= this.lastSeq) return false;
    this.frames.push({ seq, data });
    this.bytes += data.length;
    this.lastSeq = seq;
    while (this.bytes > this.cap && this.frames.length > 1) {
      const dropped = this.frames.shift();
      this.bytes -= dropped.data.length;
    }
    return true;
  }
  snapshot() {
    return this.frames.slice();
  }
  size() {
    return this.bytes;
  }
}

module.exports = { RingBuffer };
