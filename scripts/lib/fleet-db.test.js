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
    const n = await fleetDb.purgeOldEvents(c, '30 days');
    assert.equal(n, 1);
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
