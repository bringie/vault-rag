'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBackends, pick } = require('../src/backends');

test('claude backend always registered, returns argv for empty req', () => {
  const { registry, default: def } = loadBackends({});
  assert.ok(registry.has('claude'));
  assert.strictEqual(def, 'claude');
  const b = registry.get('claude');
  const r = b.buildSpawnArgs({});
  assert.deepStrictEqual(r.argv, []);
  assert.strictEqual(r.stdin, null);
});

test('claude buildSpawnArgs: structured fields → flags, args appended last', () => {
  const { registry } = loadBackends({});
  const b = registry.get('claude');
  const r = b.buildSpawnArgs({
    model: 'claude-opus-4-7',
    system_prompt: 'sys text',
    allowed_tools: 'Bash,Edit',
    resume_session_id: 'abc',
    dangerous: true,
    args: ['--extra-flag', 'val'],
    prompt: 'hello',
  });
  assert.deepStrictEqual(r.argv, [
    '--model', 'claude-opus-4-7',
    '--append-system-prompt', 'sys text',
    '--allowed-tools', 'Bash,Edit',
    '--resume', 'abc',
    '--dangerously-skip-permissions',
    '--extra-flag', 'val',
  ]);
  // Prompt is NOT inlined into argv — daemon sends via PTY stdin separately.
  assert.strictEqual(r.stdin, 'hello');
});

test('loadBackends honours backends.json + explicit bin override', () => {
  // Write a temp module + config to load.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backends-'));
  fs.writeFileSync(path.join(tmp, 'fake.js'), `module.exports = {
    name: 'fake',
    bin_default: '/bin/fake',
    async detectVersion(bin) { return 'fake-0.0.0 at ' + bin; },
    buildSpawnArgs(req) { return { argv: ['fake'], env: {}, stdin: null }; },
  };`);
  const cfg = {
    backends: [{ name: 'fake', module: './fake.js', bin: '/usr/local/bin/override' }],
    default: 'fake',
  };
  fs.writeFileSync(path.join(tmp, 'backends.json'), JSON.stringify(cfg));
  const { registry, default: def } = loadBackends({ configPath: path.join(tmp, 'backends.json') });
  assert.strictEqual(def, 'fake');
  assert.ok(registry.has('claude'));
  assert.ok(registry.has('fake'));
  assert.strictEqual(registry.get('fake').bin, '/usr/local/bin/override');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pick falls back to default, then to any registered', () => {
  const { registry } = loadBackends({});
  assert.strictEqual(pick(registry, 'claude', 'claude').name, 'claude');
  // Unknown name → default
  assert.strictEqual(pick(registry, 'nonsense', 'claude').name, 'claude');
  // Default missing → any
  assert.strictEqual(pick(registry, null, 'also-missing').name, 'claude');
});

test('loadBackends: malformed config → claude-only, no throw', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backends-'));
  fs.writeFileSync(path.join(tmp, 'backends.json'), 'NOT JSON {{{');
  const { registry } = loadBackends({ configPath: path.join(tmp, 'backends.json') });
  assert.ok(registry.has('claude'));
  assert.strictEqual(registry.size, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
