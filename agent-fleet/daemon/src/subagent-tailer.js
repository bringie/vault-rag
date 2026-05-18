'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { encodeProjectDir } = require('./jsonl-path');
const { JsonlTailer } = require('./jsonl-tailer');

// SubagentTailer — one per parent session. Watches
// ~/.claude/projects/<enc>/<parentSid>/subagents/ for new sidecar
// jsonl files. Each file gets its own JsonlTailer (configured to
// point directly at the sidecar) whose emitted frames are wrapped
// to set extracted.is_sidechain = true.
class SubagentTailer {
  constructor({ parentSessionId, cwd, home, store, emit }) {
    if (!parentSessionId) throw new Error('parentSessionId required');
    if (!cwd) throw new Error('cwd required');
    if (!home) throw new Error('home required');
    if (!store) throw new Error('store required');
    if (typeof emit !== 'function') throw new Error('emit fn required');
    this.parentSessionId = parentSessionId;
    this.cwd = cwd;
    this.home = home;
    this.store = store;
    this.emit = emit;
    this.state = 'idle';
    this._dirWatcher = null;
    this._subTailers = new Map();
    this._subagentDir = path.join(
      home, '.claude', 'projects',
      encodeProjectDir(cwd), parentSessionId, 'subagents'
    );
  }

  async start() {
    if (this.state !== 'idle') return;
    if (!fs.existsSync(this._subagentDir)) {
      this.state = 'waiting_for_dir';
      const parent = path.dirname(this._subagentDir);
      if (fs.existsSync(parent)) {
        this._dirWatcher = fs.watch(parent, (eventType, filename) => {
          if (filename !== 'subagents') return;
          if (this.state !== 'waiting_for_dir') return;
          if (fs.existsSync(this._subagentDir)) {
            this._dirWatcher.close();
            this._dirWatcher = null;
            this._enterWatching().catch(e =>
              console.error(`[subagent-tailer] enter failed: ${e.message}`));
          }
        });
      }
      return;
    }
    await this._enterWatching();
  }

  async _enterWatching() {
    this.state = 'watching';
    // Sweep existing sidecars first.
    for (const f of fs.readdirSync(this._subagentDir)) {
      if (f.endsWith('.jsonl')) await this._addSidecar(f);
    }
    this._dirWatcher = fs.watch(this._subagentDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (this._subTailers.has(filename)) return;
      this._addSidecar(filename).catch(e =>
        console.error(`[subagent-tailer] addSidecar failed: ${e.message}`));
    });
  }

  async _addSidecar(filename) {
    const subSid = filename.replace(/\.jsonl$/, '');
    const wrapEmit = (frame) => {
      if (frame.type === 'claude_msg') {
        frame.payload.extracted.is_sidechain = true;
      }
      this.emit(frame);
    };
    // Reuse JsonlTailer for the per-sidecar read loop. JsonlTailer
    // normally derives its path from (cwd, sessionId, home); we override
    // _jsonlPath + _projectDir after construction so it points directly
    // at the sidecar file under the parent session's subagents dir.
    const childCwd = '/' + path.relative('/', this._subagentDir);
    const t = new JsonlTailer({
      sessionId: subSid,
      cwd: childCwd,
      home: this.home,
      store: this.store,
      emit: wrapEmit,
    });
    t._jsonlPath = path.join(this._subagentDir, filename);
    t._projectDir = this._subagentDir;
    this._subTailers.set(filename, t);
    // Ensure the store has an entry so setOffset is not a no-op.
    if (!this.store.get(subSid)) {
      this.store.put(subSid, { pid: 0, last_seq: 0, is_sidechain: true });
    }
    await t.start();
  }

  async stop() {
    this.state = 'stopped';
    if (this._dirWatcher) { this._dirWatcher.close(); this._dirWatcher = null; }
    for (const t of this._subTailers.values()) await t.stop();
    this._subTailers.clear();
  }
}

module.exports = { SubagentTailer };
