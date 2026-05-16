'use strict';
// vt-0140: watch ~/.claude/projects/*/<session>.jsonl, parse new usage
// events, POST to fleet hub /api/tokmon/ingest. Replaces the external
// token-monitor shipper for hosts that already run the daemon.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const BATCH_MAX = 1000;

// Parse a single Claude Code conversation jsonl line. Only the
// assistant-with-usage shape produces an ingest event; everything else
// (user messages, system frames, malformed JSON) → null.
function parseUsageEvent(line, sourceFile, byteOffset) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'assistant' || !j.message || !j.message.usage) return null;
  const u = j.message.usage;
  return {
    host_id: process.env.AGENT_FLEET_HOST_NAME || os.hostname(),
    message_uuid: j.uuid || `m-${crypto.randomUUID()}`,
    ts: j.timestamp || new Date().toISOString(),
    session_id: j.sessionId || (j.message && j.message.id) || 'unknown',
    project_path: j.cwd
      || (sourceFile.split('/projects/')[1] || '').split('/')[0]
      || null,
    model: (j.message && j.message.model) || 'unknown',
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_5m: u.cache_creation_input_tokens || 0,
    cache_creation_1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    cache_read: u.cache_read_input_tokens || 0,
    service_tier: u.service_tier || null,
    active_skill: null,
    source_file: sourceFile,
    source_offset: byteOffset,
    raw_hash: crypto.createHash('sha256').update(line).digest('hex').slice(0, 16),
    raw: line.length > 8192 ? null : j,
  };
}

class TokmonWatcher {
  constructor({ hubUrl, token, projectsDir, flushIntervalMs }) {
    this.hubUrl = hubUrl;
    this.token = token;
    this.projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    this.flushIntervalMs = flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;
    this.offsets = new Map();    // path → bytes read
    this.batch = [];
    this.timer = null;
    this.stopped = false;
  }

  async start() {
    if (!fs.existsSync(this.projectsDir)) {
      console.log(`[tokmon-watcher] ${this.projectsDir} not found — disabled`);
      return;
    }
    await this._scan();
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this._scan().catch(e => console.error('[tokmon-watcher]', e.message));
    }, this.flushIntervalMs);
    this.timer.unref && this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async _scan() {
    let projects;
    try { projects = fs.readdirSync(this.projectsDir, { withFileTypes: true }); }
    catch { return; }
    for (const d of projects) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.projectsDir, d.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        const prev = this.offsets.get(full) || 0;
        // File rotation: shrink → reset offset.
        if (stat.size < prev) { this.offsets.set(full, 0); continue; }
        if (stat.size === prev) continue;
        let buf;
        try {
          const fd = fs.openSync(full, 'r');
          buf = Buffer.alloc(stat.size - prev);
          fs.readSync(fd, buf, 0, buf.length, prev);
          fs.closeSync(fd);
        } catch { continue; }
        const text = buf.toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        let off = prev;
        for (const line of lines) {
          const ev = parseUsageEvent(line, full, off);
          if (ev) this.batch.push(ev);
          off += Buffer.byteLength(line, 'utf8') + 1;
        }
        this.offsets.set(full, stat.size);
      }
    }
    await this._flush();
  }

  async _flush() {
    if (this.stopped || !this.batch.length) return;
    const events = this.batch.splice(0, BATCH_MAX);
    try {
      const res = await fetch(`${this.hubUrl}/api/tokmon/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tokmon-token': this.token,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.batch.unshift(...events);
        console.error('[tokmon-watcher] ingest status', res.status);
      }
    } catch (e) {
      this.batch.unshift(...events);
      console.error('[tokmon-watcher] ingest fail:', e.message);
    }
  }
}

module.exports = { TokmonWatcher, parseUsageEvent };
