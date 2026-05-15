'use strict';
const fs = require('node:fs');
const path = require('node:path');

class SessionStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'sessions.json');
    fs.mkdirSync(stateDir, { recursive: true });
    this.map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {}
  }
  put(id, info) { this.map.set(id, info); this._flush(); }
  get(id) { return this.map.get(id) || null; }
  delete(id) { this.map.delete(id); this._flush(); }
  list() { return Array.from(this.map.entries()); }
  _flush() {
    const obj = Object.fromEntries(this.map);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { SessionStore };
