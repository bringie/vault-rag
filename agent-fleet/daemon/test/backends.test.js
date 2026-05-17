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

test('loadBackends: malformed config → throws with .parseError flag (vt-0183)', () => {
  // vt-0183 changed the contract: parse error during hot-reload must NOT
  // silently fall back to claude-only (would drop already-loaded third-party
  // backends). It throws; the caller (reloadBackends or startup wrapper in
  // ws-client.js) is expected to catch and keep the prior good registry.
  // This test asserts the new contract.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backends-'));
  fs.writeFileSync(path.join(tmp, 'backends.json'), 'NOT JSON {{{');
  let thrown = null;
  try { loadBackends({ configPath: path.join(tmp, 'backends.json') }); }
  catch (e) { thrown = e; }
  assert.ok(thrown, 'expected loadBackends to throw');
  assert.strictEqual(thrown.parseError, true, 'expected .parseError flag for caller-side classification');
  assert.match(thrown.message, /failed to parse/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- vt-0097 additional backends ---

const opencode = require('../src/backends/opencode');
const codex = require('../src/backends/codex');
const hermes = require('../src/backends/hermes');

test('opencode: model→--model, system→--system, dangerous→--auto-approve', () => {
  const r = opencode.buildSpawnArgs({
    model: 'anthropic/claude-opus-4-7',
    system_prompt: 'sys',
    dangerous: true,
    args: ['--extra'],
    prompt: 'hi',
  });
  assert.deepStrictEqual(r.argv, [
    '--model', 'anthropic/claude-opus-4-7',
    '--system', 'sys',
    '--auto-approve',
    '--extra',
  ]);
  assert.strictEqual(r.stdin, 'hi');
});

test('opencode: allowed_tools warns once and is dropped', () => {
  const r = opencode.buildSpawnArgs({ allowed_tools: 'Bash' });
  assert.deepStrictEqual(r.argv, []);
});

test('codex: model→--model, system→--instructions, drops unsupported', () => {
  const r = codex.buildSpawnArgs({
    model: 'gpt-5',
    system_prompt: 'be terse',
    resume_session_id: 'X',   // dropped
    args: ['--foo'],
  });
  assert.deepStrictEqual(r.argv, [
    '--model', 'gpt-5',
    '--instructions', 'be terse',
    '--foo',
  ]);
});

test('hermes: model→$MODEL env, system+prompt framed in stdin', () => {
  const r = hermes.buildSpawnArgs({
    model: 'hermes-3-llama-3.1-8b',
    system_prompt: 'rules',
    prompt: 'do thing',
  });
  assert.strictEqual(r.env.MODEL, 'hermes-3-llama-3.1-8b');
  assert.match(r.stdin, /<<SYSTEM>>\nrules\n<<USER>>\ndo thing/);
});

// --- vt-0104/0105: openclaw + nanoclaw ---

const openclaw = require('../src/backends/openclaw');
const nanoclaw = require('../src/backends/nanoclaw');

test('openclaw: first args entry → OPENCLAW_SKILL env, rest argv', () => {
  const r = openclaw.buildSpawnArgs({
    args: ['browser', '--tab', 'gh'],
    prompt: 'open repo',
    model: 'claude-opus-4-7',
  });
  assert.strictEqual(r.env.OPENCLAW_SKILL, 'browser');
  assert.strictEqual(r.env.OPENCLAW_MODEL, 'claude-opus-4-7');
  assert.deepStrictEqual(r.argv, ['--tab', 'gh']);
  assert.strictEqual(r.stdin, 'open repo');
});

test('openclaw: default skill = chat when args is empty', () => {
  const r = openclaw.buildSpawnArgs({ prompt: 'hi' });
  assert.strictEqual(r.env.OPENCLAW_SKILL, 'chat');
});

test('nanoclaw: spawn returns shim that fails with exit 22', () => {
  const r = nanoclaw.buildSpawnArgs({ prompt: 'hi' });
  // Sidecar mode: argv is a /bin/sh -c that prints + exits 22.
  assert.strictEqual(r.argv[0], '-c');
  assert.match(r.argv[1], /sidecar.*not supported/i);
});
