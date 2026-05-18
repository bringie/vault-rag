'use strict';
const fs = require('node:fs');
const path = require('node:path');

class SessionStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'sessions.json');
    fs.mkdirSync(stateDir, { recursive: true });
    this.map = new Map();
    // vt-0176: on corrupt sessions.json, log + quarantine the file (rename
    // to .corrupt.<ts>) so the next _flush doesn't overwrite the evidence.
    // Previously a silent catch{} emptied the store → live PTYs become
    // orphans because reconciliation reports them as nonexistent.
    try {
      if (fs.existsSync(this.file)) {
        const text = fs.readFileSync(this.file, 'utf8');
        const raw = JSON.parse(text);
        for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
      }
    } catch (e) {
      const quarantine = this.file + '.corrupt.' + Date.now();
      try { fs.renameSync(this.file, quarantine); } catch {}
      console.error(`[session-store] corrupt sessions.json moved to ${quarantine}: ${e.message}`);
    }
  }
  put(id, info) { this.map.set(id, info); this._flush(); }
  get(id) { return this.map.get(id) || null; }
  delete(id) { this.map.delete(id); this._flush(); }
  list() { return Array.from(this.map.entries()); }
  // vt-chat-1a: byte-offset cursor for the per-session jsonl-tailer.
  // Stored inline on each session entry; survives daemon restart so
  // the tailer can resume without double-emitting or skipping lines.
  getOffset(id) {
    const e = this.map.get(id);
    return (e && typeof e.jsonl_offset === 'number') ? e.jsonl_offset : 0;
  }
  setOffset(id, offset) {
    const e = this.map.get(id);
    if (!e) return;
    e.jsonl_offset = offset;
    this._flush();
  }
  _flush() {
    const obj = Object.fromEntries(this.map);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { SessionStore };
