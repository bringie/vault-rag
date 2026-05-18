'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { expectedJsonlPath } = require('./jsonl-path');
const { makeStatefulParser } = require('./parsers/jsonl-parser');

class JsonlTailer {
  constructor({ sessionId, cwd, home, store, emit }) {
    if (!sessionId) throw new Error('sessionId required');
    if (!cwd) throw new Error('cwd required');
    if (!home) throw new Error('home required');
    if (!store) throw new Error('store required');
    if (typeof emit !== 'function') throw new Error('emit fn required');
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.home = home;
    this.store = store;
    this.emit = emit;
    this.state = 'idle';
    this._dirWatcher = null;
    this._fileWatcher = null;
    this._parser = makeStatefulParser();
    this._jsonlPath = expectedJsonlPath(cwd, sessionId, home);
    this._projectDir = path.dirname(this._jsonlPath);
    this._lineBuf = '';
    this._reading = false;
  }

  async start() {
    if (this.state !== 'idle') return;
    if (fs.existsSync(this._jsonlPath)) {
      await this._enterTailing();
      return;
    }
    this.state = 'waiting_for_file';
    this._dirWatcher = fs.watch(this._projectDir, (eventType, filename) => {
      if (filename !== `${this.sessionId}.jsonl`) return;
      if (this.state !== 'waiting_for_file') return;
      if (fs.existsSync(this._jsonlPath)) {
        this._enterTailing().catch(e =>
          console.error(`[jsonl-tailer] enterTailing failed: ${e.message}`));
      }
    });
  }

  async _enterTailing() {
    this.state = 'tailing';
    await this._readFromCursor();
    this._fileWatcher = fs.watch(this._jsonlPath, () => {
      if (this.state === 'tailing') {
        this._readFromCursor().catch(e =>
          console.error(`[jsonl-tailer] tail read failed: ${e.message}`));
      }
    });
  }

  async _readFromCursor() {
    if (this._reading) return;
    this._reading = true;
    try {
      const startOffset = this.store.getOffset(this.sessionId);
      let stat;
      try { stat = fs.statSync(this._jsonlPath); }
      catch { return; }
      if (stat.size <= startOffset) return;
      const fd = fs.openSync(this._jsonlPath, 'r');
      try {
        const chunkSize = 64 * 1024;
        const buf = Buffer.alloc(chunkSize);
        let pos = startOffset;
        while (pos < stat.size) {
          const remaining = stat.size - pos;
          const toRead = Math.min(chunkSize, remaining);
          const n = fs.readSync(fd, buf, 0, toRead, pos);
          if (n === 0) break;
          this._lineBuf += buf.slice(0, n).toString('utf8');
          pos += n;
          this._drainLines(pos - Buffer.byteLength(this._lineBuf, 'utf8'));
        }
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      this._reading = false;
    }
  }

  // Drains complete lines from _lineBuf. byteOffsetOfBufStart is the
  // file-byte offset corresponding to _lineBuf[0]. The persisted cursor
  // is advanced past each complete line (including its \n).
  _drainLines(byteOffsetOfBufStart) {
    let absOffset = byteOffsetOfBufStart;
    let nl;
    while ((nl = this._lineBuf.indexOf('\n')) !== -1) {
      const line = this._lineBuf.slice(0, nl);
      const lineByteOffset = absOffset;
      const consumed = Buffer.byteLength(line, 'utf8') + 1;
      this._lineBuf = this._lineBuf.slice(nl + 1);
      absOffset += consumed;
      if (line.length === 0) {
        this.store.setOffset(this.sessionId, absOffset);
        continue;
      }
      const frame = this._parser(line, lineByteOffset);
      if (frame) this.emit(frame);
      this.store.setOffset(this.sessionId, absOffset);
    }
  }

  async stop() {
    this.state = 'stopped';
    if (this._dirWatcher) { this._dirWatcher.close(); this._dirWatcher = null; }
    if (this._fileWatcher) { this._fileWatcher.close(); this._fileWatcher = null; }
    // vt-0392 v6: flush the debounced offset cursor so a clean stop +
    // restart resumes at the exact byte without re-emitting.
    try { this.store.flushNow?.(); } catch {}
  }
}

module.exports = { JsonlTailer };
