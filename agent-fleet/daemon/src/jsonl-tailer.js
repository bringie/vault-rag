'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { expectedJsonlPath } = require('./jsonl-path');
const { makeStatefulParser } = require('./parsers/jsonl-parser');

// JsonlTailer — one per spawned session.
// States: waiting_for_file → tailing → stopped.
// The constructor records dependencies but does no I/O; .start() arms
// the dir watcher and (if the file already exists) opens it immediately.
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
  }

  async start() {
    if (this.state !== 'idle') return;
    if (fs.existsSync(this._jsonlPath)) {
      this.state = 'tailing';
      // Tail wiring lands in Task 6.
      return;
    }
    this.state = 'waiting_for_file';
    this._dirWatcher = fs.watch(this._projectDir, (eventType, filename) => {
      if (filename !== `${this.sessionId}.jsonl`) return;
      if (this.state !== 'waiting_for_file') return;
      if (fs.existsSync(this._jsonlPath)) {
        this.state = 'tailing';
        // Tail wiring lands in Task 6.
      }
    });
  }

  async stop() {
    this.state = 'stopped';
    if (this._dirWatcher) { this._dirWatcher.close(); this._dirWatcher = null; }
    if (this._fileWatcher) { this._fileWatcher.close(); this._fileWatcher = null; }
  }
}

module.exports = { JsonlTailer };
