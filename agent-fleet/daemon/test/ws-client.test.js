'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { computeBackoff, runDaemon } = require('../src/ws-client');

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
