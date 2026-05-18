'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubagentTailer } = require('../src/subagent-tailer');
const { SessionStore } = require('../src/session-store');

function newTmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

test('SubagentTailer: starts in waiting_for_dir state if subagents/ absent',
async () => {
  const home = newTmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-root'),
    { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'sat-store-')));
  const t = new SubagentTailer({
    parentSessionId: 'sid-p', cwd: '/root', home, store,
    emit: () => {}
  });
  await t.start();
  assert.strictEqual(t.state, 'waiting_for_dir');
  await t.stop();
});

test('SubagentTailer: spawns sub-tailers on sidecar appearance', async () => {
  const home = newTmpHome();
  const projDir = path.join(home, '.claude', 'projects', '-root');
  const subDir = path.join(projDir, 'sid-p', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'sat-store-')));
  const events = [];
  const t = new SubagentTailer({
    parentSessionId: 'sid-p', cwd: '/root', home, store,
    emit: (f) => events.push(f)
  });
  await t.start();
  assert.strictEqual(t.state, 'watching');
  // Drop a fixture sidecar in.
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'jsonl', 'simple-session.jsonl'),
    'utf8'
  );
  fs.writeFileSync(path.join(subDir, 'sub-1.jsonl'), fixture);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(events.length >= 5, `got ${events.length} events`);
  // All emitted frames must be tagged is_sidechain.
  for (const e of events) {
    if (e.type === 'claude_msg') {
      assert.strictEqual(e.payload.extracted.is_sidechain, true,
        'subagent frames must be tagged');
    }
  }
  await t.stop();
});

test('SubagentTailer: stop closes all sub-tailers', async () => {
  const home = newTmpHome();
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-root', 'sid-p',
    'subagents'), { recursive: true });
  const store = new SessionStore(fs.mkdtempSync(
    path.join(os.tmpdir(), 'sat-store-')));
  const t = new SubagentTailer({
    parentSessionId: 'sid-p', cwd: '/root', home, store,
    emit: () => {}
  });
  await t.start();
  await t.stop();
  assert.strictEqual(t.state, 'stopped');
});
