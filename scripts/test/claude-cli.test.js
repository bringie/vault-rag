const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callClaude } = require('../lib/claude-cli');

function writeFakeBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeclaude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('callClaude: returns stdout on exit 0', async () => {
  const bin = writeFakeBin(`echo '{"result":"{\\"target_folder\\":\\"01-knowledge\\",\\"tags\\":[],\\"summary\\":\\"s\\",\\"type\\":\\"note\\",\\"confidence\\":0.9}"}'`);
  const out = await callClaude({ prompt: 'x', binary: bin, timeoutMs: 5000 });
  assert.match(out, /target_folder/);
});

test('callClaude: ENOENT when binary missing', async () => {
  await assert.rejects(
    callClaude({ prompt: 'x', binary: '/nonexistent/claude', timeoutMs: 5000 }),
    (err) => err.code === 'ENOENT' || /ENOENT|not found/.test(err.message),
  );
});

test('callClaude: auth error mapped to claude_auth', async () => {
  const bin = writeFakeBin('echo "Please run claude login" >&2 ; exit 2');
  await assert.rejects(
    callClaude({ prompt: 'x', binary: bin, timeoutMs: 5000 }),
    (err) => err.code === 'claude_auth',
  );
});

test('callClaude: timeout mapped to claude_timeout', async () => {
  const bin = writeFakeBin('sleep 5');
  await assert.rejects(
    callClaude({ prompt: 'x', binary: bin, timeoutMs: 200 }),
    (err) => err.code === 'claude_timeout',
  );
});
