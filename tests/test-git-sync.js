const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function tmpVault({ withSync = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-'));
  if (withSync) {
    fs.mkdirSync(path.join(d, '.sync'), { recursive: true });
    const log = path.join(d, '.sync', 'calls.log');
    const script = path.join(d, '.sync', 'vault-sync.sh');
    fs.writeFileSync(script, `#!/bin/bash\necho "$(date +%s%N) $1" >> "${log}"\n`);
    fs.chmodSync(script, 0o755);
    return { dir: d, log };
  }
  return { dir: d };
}

function freshModule() {
  const p = require.resolve('../scripts/lib/git-sync');
  delete require.cache[p];
  return require('../scripts/lib/git-sync');
}

test('trigger: no-op when .sync/vault-sync.sh missing', async () => {
  const { dir } = tmpVault();
  const gitSync = freshModule();
  gitSync.trigger(dir);
  await new Promise(r => setTimeout(r, 1700));
  // no log to check; just assert no throw and no .sync/ created
  assert.ok(!fs.existsSync(path.join(dir, '.sync')));
});

test('trigger: no-op when vault is empty/null', () => {
  const gitSync = freshModule();
  assert.doesNotThrow(() => gitSync.trigger(null));
  assert.doesNotThrow(() => gitSync.trigger(''));
  assert.doesNotThrow(() => gitSync.trigger(undefined));
});

test('trigger: debounces burst into single call', async () => {
  const { dir, log } = tmpVault({ withSync: true });
  const gitSync = freshModule();
  for (let i = 0; i < 10; i++) gitSync.trigger(dir);
  await new Promise(r => setTimeout(r, 2200));
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.strictEqual(calls.length, 1, `expected 1 call after debounce, got ${calls.length}`);
  assert.match(calls[0], /push$/);
});

test('trigger: separate vaults debounce independently', async () => {
  const a = tmpVault({ withSync: true });
  const b = tmpVault({ withSync: true });
  const gitSync = freshModule();
  gitSync.trigger(a.dir);
  gitSync.trigger(b.dir);
  await new Promise(r => setTimeout(r, 2200));
  const ac = fs.readFileSync(a.log, 'utf8').trim().split('\n').filter(Boolean);
  const bc = fs.readFileSync(b.log, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(ac.length, 1);
  assert.strictEqual(bc.length, 1);
});
