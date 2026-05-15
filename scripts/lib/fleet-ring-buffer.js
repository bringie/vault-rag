'use strict';
// FIFO byte-budgeted ring buffer of {seq, data} frames.
// Caller appends frames in monotonic seq order. snapshot() returns a copy.
// When total bytes exceeds capacity, oldest frames are dropped until <= capacity.

class RingBuffer {
  constructor(capacityBytes) {
    this.cap = capacityBytes;
    this.frames = [];
    this.bytes = 0;
  }
  append({ seq, data }) {
    this.frames.push({ seq, data });
    this.bytes += data.length;
    while (this.bytes > this.cap && this.frames.length > 1) {
      const dropped = this.frames.shift();
      this.bytes -= dropped.data.length;
    }
  }
  snapshot() {
    return this.frames.slice();
  }
  size() {
    return this.bytes;
  }
}

module.exports = { RingBuffer };
