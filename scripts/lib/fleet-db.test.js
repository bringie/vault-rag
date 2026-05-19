'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const fleetDb = require('./fleet-db');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || '127.0.0.1',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function reset(c) {
  await c.query('TRUNCATE fleet_hosts, fleet_sessions, fleet_events, fleet_groups, fleet_host_groups RESTART IDENTITY CASCADE');
}

test('upsertHost inserts new host on first call', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, {
      name: 'h1', os: 'linux', arch: 'x86_64',
      capabilities: ['docker'], daemonVersion: '0.1.0', claudeVersion: '1.2.3',
    });
    assert.ok(h.id);
    assert.equal(h.name, 'h1');
    assert.equal(h.status, 'online');
    assert.deepEqual(h.capabilities, ['docker']);
  });
});

test('upsertHost reuses id on second call with same name', async () => {
  await withClient(async (c) => {
    await reset(c);
    const a = await fleetDb.upsertHost(c, { name: 'h2', os: 'darwin' });
    const b = await fleetDb.upsertHost(c, { name: 'h2', os: 'darwin', claudeVersion: 'changed' });
    assert.equal(b.id, a.id);
    assert.equal(b.claude_version, 'changed');
  });
});

test('listHosts returns all hosts ordered by name', async () => {
  await withClient(async (c) => {
    await reset(c);
    await fleetDb.upsertHost(c, { name: 'b' });
    await fleetDb.upsertHost(c, { name: 'a' });
    const rows = await fleetDb.listHosts(c);
    assert.deepEqual(rows.map(r => r.name), ['a', 'b']);
  });
});

test('setHostOffline flips status', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'x' });
    await fleetDb.setHostOffline(c, h.id);
    const rows = await fleetDb.listHosts(c);
    assert.equal(rows[0].status, 'offline');
  });
});

test('deleteHost cascades sessions', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'd' });
    await c.query('INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, $2)', [h.id, '/tmp']);
    await fleetDb.deleteHost(c, h.id);
    const { rows } = await c.query('SELECT COUNT(*) FROM fleet_sessions');
    assert.equal(rows[0].count, '0');
  });
});

// --- Sessions (Task 3) ---

test('createSession returns id with status=pending', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'hs' });
    const s = await fleetDb.createSession(c, {
      hostId: h.id, cwd: '/tmp', args: ['--print', 'hi'],
      env: { FOO: 'bar' }, createdBy: 'test', label: 't1',
    });
    assert.ok(s.id);
    assert.equal(s.status, 'pending');
    assert.deepEqual(s.args, ['--print', 'hi']);
    assert.deepEqual(s.env, { FOO: 'bar' });
  });
});

test('markSessionRunning sets pid and status', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'hm' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/tmp' });
    await fleetDb.markSessionRunning(c, s.id, 12345);
    const got = await fleetDb.getSession(c, s.id);
    assert.equal(got.status, 'running');
    assert.equal(got.pid, 12345);
  });
});

test('markSessionExited sets exit_code + ended_at', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'he' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/tmp' });
    await fleetDb.markSessionExited(c, s.id, 137, 'killed');
    const got = await fleetDb.getSession(c, s.id);
    assert.equal(got.status, 'killed');
    assert.equal(got.exit_code, 137);
    assert.ok(got.ended_at);
  });
});

test('listSessions filters by host_id and status', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h1 = await fleetDb.upsertHost(c, { name: 'L1' });
    const h2 = await fleetDb.upsertHost(c, { name: 'L2' });
    await fleetDb.createSession(c, { hostId: h1.id, cwd: '/' });
    await fleetDb.createSession(c, { hostId: h2.id, cwd: '/' });
    const all = await fleetDb.listSessions(c, {});
    assert.equal(all.length, 2);
    const filtered = await fleetDb.listSessions(c, { hostId: h1.id });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].host_id, h1.id);
  });
});

test('orphanRunningSessions flips running → orphaned on hub restart', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'orph' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.markSessionRunning(c, s.id, 999);
    const n = await fleetDb.orphanRunningSessions(c);
    assert.ok(n >= 1);
    const got = await fleetDb.getSession(c, s.id);
    assert.equal(got.status, 'orphaned');
  });
});

// --- Events (Task 4) ---

test('appendEvents inserts batch and returns count', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'ev1' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    const n = await fleetDb.appendEvents(c, [
      { sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('hello') },
      { sessionId: s.id, kind: 'pty_out', seq: 1, payload: Buffer.from('world') },
    ]);
    assert.equal(n, 2);
    const { rows } = await c.query('SELECT seq, payload FROM fleet_events ORDER BY seq');
    assert.equal(rows[0].payload.toString(), 'hello');
    assert.equal(rows[1].seq, '1');
  });
});

test('appendEvents duplicates persist (dedup is caller responsibility)', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'ev2' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.appendEvents(c, [{ sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('a') }]);
    await fleetDb.appendEvents(c, [{ sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('a') }]);
    const { rows } = await c.query('SELECT COUNT(*) FROM fleet_events WHERE session_id=$1', [s.id]);
    assert.equal(rows[0].count, '2');
  });
});

test('maxSeq returns the highest seq for a session (or null)', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'ms' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    assert.equal(await fleetDb.maxSeq(c, s.id), null);
    await fleetDb.appendEvents(c, [
      { sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('a') },
      { sessionId: s.id, kind: 'pty_out', seq: 4, payload: Buffer.from('b') },
    ]);
    assert.equal(await fleetDb.maxSeq(c, s.id), 4);
  });
});

test('readTranscript returns events ordered by seq', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'tr' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.appendEvents(c, [
      { sessionId: s.id, kind: 'pty_out', seq: 1, payload: Buffer.from('B') },
      { sessionId: s.id, kind: 'pty_out', seq: 0, payload: Buffer.from('A') },
    ]);
    const rows = await fleetDb.readTranscript(c, s.id, { sinceSeq: 0 });
    assert.equal(rows[0].payload.toString(), 'A');
    assert.equal(rows[1].payload.toString(), 'B');
  });
});

test('purgeOldEvents deletes pty_* older than cutoff but keeps lifecycle', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'pg' });
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await c.query(
      `INSERT INTO fleet_events (session_id, ts, kind, seq, payload) VALUES
       ($1, now() - interval '60 days', 'pty_out', 0, decode('aa','hex')),
       ($1, now() - interval '60 days', 'lifecycle', 1, decode('bb','hex')),
       ($1, now() - interval '1 day', 'pty_out', 2, decode('cc','hex'))`,
      [s.id],
    );
    const r = await fleetDb.purgeOldEvents(c, '30 days');
    assert.equal(r.deleted, 1);
    assert.equal(r.limited, false);
    const { rows } = await c.query('SELECT kind, seq FROM fleet_events ORDER BY seq');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.kind), ['lifecycle', 'pty_out']);
  });
});

test('createGroup persists labels; updateGroup patches them', async () => {
  await withClient(async (c) => {
    await reset(c);
    const g = await fleetDb.createGroup(c, { name: 'g1', labels: ['backend', 'gpu'] });
    assert.deepEqual(g.labels.sort(), ['backend', 'gpu']);
    const u = await fleetDb.updateGroup(c, g.id, { labels: ['frontend'] });
    assert.deepEqual(u.labels, ['frontend']);
  });
});

test('getEffectiveCapabilities unions direct + group labels', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'h1', capabilities: ['docker'] });
    const g1 = await fleetDb.createGroup(c, { name: 'backend', labels: ['nodejs', 'pg'] });
    const g2 = await fleetDb.createGroup(c, { name: 'gpu', labels: ['cuda'] });
    await fleetDb.addHostToGroup(c, h.id, g1.id);
    await fleetDb.addHostToGroup(c, h.id, g2.id);
    const r = await fleetDb.getEffectiveCapabilities(c, h.id);
    assert.deepEqual(r.capabilities, ['docker']);
    assert.deepEqual(r.effective.sort(), ['cuda', 'docker', 'nodejs', 'pg']);
    assert.deepEqual(r.inherited.backend.sort(), ['nodejs', 'pg']);
    assert.deepEqual(r.inherited.gpu, ['cuda']);
  });
});

test('listHostsByEffectiveTag returns direct + via-group hosts', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h1 = await fleetDb.upsertHost(c, { name: 'direct', capabilities: ['gpu'] });
    const h2 = await fleetDb.upsertHost(c, { name: 'viagroup' });
    await fleetDb.upsertHost(c, { name: 'unrelated' });
    const g = await fleetDb.createGroup(c, { name: 'g', labels: ['gpu'] });
    await fleetDb.addHostToGroup(c, h2.id, g.id);
    const matches = await fleetDb.listHostsByEffectiveTag(c, 'gpu');
    const names = matches.map(h => h.name).sort();
    assert.deepEqual(names, ['direct', 'viagroup']);
  });
});

test('insertHostMetric + readMetricsSince', async () => {
  await withClient(async (c) => {
    await reset(c);
    await c.query('TRUNCATE fleet_host_metrics, fleet_host_metrics_5m');
    const h = await fleetDb.upsertHost(c, { name: 'h-met' });
    await fleetDb.insertHostMetric(c, h.id, {
      ts: new Date().toISOString(),
      cpu_pct: 42.3, ram_used_bytes: 1024, ram_total_bytes: 4096,
      disk: [{ mount: '/', size_bytes: 100, used_bytes: 50, avail_bytes: 50 }],
      net: { rx_bps: 1000, tx_bps: 500 },
    });
    const rows = await fleetDb.readMetricsSince(c, h.id, '1 hour');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].cpu_pct, 42.3);
    assert.deepStrictEqual(rows[0].disk[0].mount, '/');
  });
});

test('setHostInventory merges into metadata.inventory', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'h-inv' });
    await fleetDb.setHostInventory(c, h.id, {
      collected_at: new Date().toISOString(),
      skills: [{ plugin: 'p1', version: '1.0', name: 's1' }],
      mcp_servers: [{ name: 'vault-rag', enabled: true, command: 'node', args: [] }],
      claude_version: '1.5.2',
      settings: { model: 'claude-opus-4-7' },
    });
    const after = await fleetDb.getHost(c, h.id);
    assert.strictEqual(after.metadata.inventory.skills[0].name, 's1');
    assert.strictEqual(after.metadata.inventory.mcp_servers[0].name, 'vault-rag');
  });
});

test('readMetricsRollupSince returns 5-min buckets', async () => {
  await withClient(async (c) => {
    await reset(c);
    await c.query('TRUNCATE fleet_host_metrics_5m');
    const h = await fleetDb.upsertHost(c, { name: 'h-roll' });
    await c.query(`
      INSERT INTO fleet_host_metrics_5m (host_id, bucket, cpu_pct_avg, cpu_pct_max, ram_used_bytes)
      VALUES ($1, now() - interval '10 minutes', 25, 40, 1024),
             ($1, now() - interval '5 minutes',  30, 50, 2048)`, [h.id]);
    const rows = await fleetDb.readMetricsRollupSince(c, h.id, '1 hour');
    assert.strictEqual(rows.length, 2);
    assert.ok(rows[0].cpu_pct_avg !== null);
  });
});

// vt-0439: reapStuckSessions orphaned→exited promotion branch.
// A session stuck as 'orphaned' should be promoted to 'exited' (exit_code=-1)
// when the host has been seen recently (last_seen within 5 min), indicating
// the daemon reconnected but didn't reclaim the session.
test('reapStuckSessions: orphaned session promoted to exited when host is back online', async () => {
  await withClient(async (c) => {
    await reset(c);
    // Host that is currently online (last_seen = now).
    const h = await fleetDb.upsertHost(c, { name: 'reap-online' });
    // Create a session, mark it running, then manually flip to orphaned.
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.markSessionRunning(c, s.id, 1234);
    await fleetDb.markSessionExited(c, s.id, null, 'orphaned');
    // Verify precondition: status=orphaned, host online.
    const pre = await fleetDb.getSession(c, s.id);
    assert.strictEqual(pre.status, 'orphaned');
    // Call reaper — uses default hostStaleSec=180, maxAgeHours=24.
    // The orphaned→exited branch fires when host.last_seen > now()-5min.
    await fleetDb.reapStuckSessions(c);
    const post = await fleetDb.getSession(c, s.id);
    assert.strictEqual(post.status, 'exited',
      'orphaned session on a live host must be promoted to exited');
    assert.strictEqual(Number(post.exit_code), -1,
      'exit_code must be set to -1 for reaped orphaned sessions');
  });
});

test('reapStuckSessions: orphaned session on OFFLINE host NOT promoted until 1h+', async () => {
  await withClient(async (c) => {
    await reset(c);
    // Simulate a host that went offline 10 minutes ago (recent but NOT back online).
    const h = await fleetDb.upsertHost(c, { name: 'reap-offline' });
    await c.query(
      "UPDATE fleet_hosts SET last_seen = now() - interval '10 minutes' WHERE id=$1",
      [h.id],
    );
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.markSessionRunning(c, s.id, 5678);
    await fleetDb.markSessionExited(c, s.id, null, 'orphaned');
    // ended_at was just set to now() by markSessionExited — so ended_at < 1h check is false.
    // last_seen is 10 min ago → not within 5 min → first branch also false.
    // The session should remain 'orphaned'.
    await fleetDb.reapStuckSessions(c);
    const post = await fleetDb.getSession(c, s.id);
    assert.strictEqual(post.status, 'orphaned',
      'orphaned session on recently-offline host should NOT be promoted yet (wait 1h)');
  });
});

test('reapStuckSessions: running session on stale host flips to orphaned', async () => {
  await withClient(async (c) => {
    await reset(c);
    const h = await fleetDb.upsertHost(c, { name: 'reap-stale' });
    // Back-date last_seen to > 180 seconds ago to trigger the stale-host branch.
    await c.query(
      "UPDATE fleet_hosts SET last_seen = now() - interval '5 minutes' WHERE id=$1",
      [h.id],
    );
    const s = await fleetDb.createSession(c, { hostId: h.id, cwd: '/' });
    await fleetDb.markSessionRunning(c, s.id, 9999);
    // reap with a low hostStaleSec (200s) so the 5-min-old host_seen is stale.
    await fleetDb.reapStuckSessions(c, { hostStaleSec: 200 });
    const post = await fleetDb.getSession(c, s.id);
    assert.strictEqual(post.status, 'orphaned',
      'running session on stale-heartbeat host must be orphaned');
    assert.ok(post.ended_at, 'ended_at must be set when orphaned');
  });
});
