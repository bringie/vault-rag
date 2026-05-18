'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { computeBackoff, runDaemon, applySpawnFrame } = require('../src/ws-client');

test('computeBackoff caps at 30s and grows exponentially with jitter', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const v = computeBackoff(attempt);
    assert.ok(v >= 0, `attempt ${attempt}: ${v} < 0`);
    assert.ok(v <= 30_000 * 1.25, `attempt ${attempt}: ${v} > 30s+jitter`);
  }
  let saw = 0;
  for (let i = 0; i < 50; i++) {
    const v = computeBackoff(0);
    if (v >= 750 && v <= 1250) saw++;
  }
  assert.ok(saw > 30, `expected ~all attempt-0 backoffs in [750..1250]ms; got ${saw}/50`);
});

test('runDaemon reconnects on close (mock hub)', async () => {
  let acceptCount = 0;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    acceptCount++;
    ws.send(JSON.stringify({ type: 'welcome', host_id: 'host-x', server_version: '0' }));
    setTimeout(() => ws.close(), 50);
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const ctrl = new AbortController();
  const p = runDaemon({
    hub: `ws://127.0.0.1:${port}`,
    token: 'T', hostName: 't',
    stateDir: '/tmp/agent-fleet-test-' + process.pid,
    claudeBin: '/bin/true',
    abortSignal: ctrl.signal,
    backoffOverride: () => 50,
  });
  const start = Date.now();
  while (acceptCount < 3 && Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 25));
  }
  ctrl.abort();
  await p.catch(() => {});
  server.close();
  assert.ok(acceptCount >= 3, `expected ≥3 connection attempts, got ${acceptCount}`);
});

// vt-0122: backend modules build {argv, env, stdin} but the daemon used to
// drop `stdin`, so hermes/opencode/codex/openclaw wrappers hung on `RAW=$(cat)`
// waiting for a prompt that never arrived. applySpawnFrame forwards stdin via
// ptyMgr.writeInput after the spawn.
test('applySpawnFrame writes backend stdin to PTY after spawn (structured path)', () => {
  const calls = [];
  const ptyMgr = {
    spawn: (a) => calls.push({ k: 'spawn', ...a }),
    writeInput: (id, d) => calls.push({ k: 'write', id, d }),
  };
  const fakeBackend = {
    name: 'hermes', bin: '/usr/local/bin/hermes-wrapper.sh',
    buildSpawnArgs: () => ({ argv: [], env: { MODEL: 'h' }, stdin: '<<USER>>\nHELLO' }),
  };
  const backends = new Map([['hermes', fakeBackend]]);
  applySpawnFrame(
    { type: 'spawn', session_id: 's1', cwd: '/tmp', agent: 'hermes', prompt: 'HELLO' },
    { ptyMgr, backends, defaultBackend: 'hermes', baseBin: '/bin/claude' },
  );
  // vt-0392 v4: stdin is no longer written synchronously by applySpawnFrame
  // — it is stashed on f.__pending_stdin so the WS frame loop can route it
  // through the Ink-ready queue. Only the spawn call lands on ptyMgr here.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].k, 'spawn');
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].binOverride, '/usr/local/bin/hermes-wrapper.sh');
});

test('applySpawnFrame: stashes stdin on f.__pending_stdin for caller to queue', () => {
  const ptyMgr = { spawn: () => {}, writeInput: () => {} };
  const backends = new Map([['hermes', {
    name: 'hermes', bin: '/usr/local/bin/hermes-wrapper.sh',
    buildSpawnArgs: () => ({ argv: [], env: {}, stdin: '<<USER>>\nHELLO' }),
  }]]);
  const f = { type: 'spawn', session_id: 's1', cwd: '/tmp', agent: 'hermes', prompt: 'HELLO' };
  applySpawnFrame(f, { ptyMgr, backends, defaultBackend: 'hermes', baseBin: '/bin/claude' });
  assert.equal(f.__pending_stdin, '<<USER>>\nHELLO');
});

test('applySpawnFrame skips writeInput when backend returns null stdin', () => {
  const calls = [];
  const ptyMgr = {
    spawn: () => calls.push('spawn'),
    writeInput: () => calls.push('write'),
  };
  const fakeBackend = {
    name: 'nano', bin: '/bin/sh',
    buildSpawnArgs: () => ({ argv: ['nano-shim.sh'], env: {}, stdin: null, _shimBin: '/bin/sh' }),
  };
  const backends = new Map([['nano', fakeBackend]]);
  applySpawnFrame(
    { type: 'spawn', session_id: 's2', cwd: '/tmp', agent: 'nano', prompt: 'X' },
    { ptyMgr, backends, defaultBackend: 'nano', baseBin: '/bin/claude' },
  );
  assert.deepEqual(calls, ['spawn']);
});

test('applySpawnFrame legacy path: no backend lookup when no structured fields', () => {
  const calls = [];
  const ptyMgr = {
    spawn: (a) => calls.push({ k: 'spawn', ...a }),
    writeInput: () => calls.push('write'),
  };
  // Empty backends map — proves the legacy path never asks for a backend.
  applySpawnFrame(
    { type: 'spawn', session_id: 's3', cwd: '/tmp', args: ['-p', 'hi'] },
    { ptyMgr, backends: new Map(), defaultBackend: 'claude', baseBin: '/bin/claude' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].k, 'spawn');
  assert.equal(calls[0].binOverride, '/bin/claude');
  assert.deepEqual(calls[0].args, ['-p', 'hi']);
});

test('applySpawnFrame: __pending_stdin preserved verbatim (trailing \\n included)', () => {
  // vt-0392 v4: applySpawnFrame no longer normalises or submits the
  // initial stdin — that happens in the WS frame loop via the Ink-ready
  // queue. submitTextToPty (called later) is the one that strips the
  // trailing \n and appends \r. Here we just verify the raw stash.
  const ptyMgr = { spawn: () => {}, writeInput: () => {} };
  const backends = new Map([['x', {
    name: 'x', bin: '/bin/cat',
    buildSpawnArgs: () => ({ argv: [], env: {}, stdin: 'already-newlined\n' }),
  }]]);
  const f = { type: 'spawn', session_id: 'sN', agent: 'x', prompt: 'p' };
  applySpawnFrame(f, { ptyMgr, backends, defaultBackend: 'x', baseBin: '/bin/claude' });
  assert.equal(f.__pending_stdin, 'already-newlined\n');
});
