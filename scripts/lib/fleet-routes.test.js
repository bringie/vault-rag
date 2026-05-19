'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Client } = require('pg');
const WebSocket = require('ws');
const fleetRoutes = require('./fleet-routes');

const PG = {
  host: '127.0.0.1', port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
  user: 'postgres', password: process.env.VAULT_RAG_PG_PASS, database: 'vault_rag',
};

async function startTestServer(opts) {
  const server = http.createServer();
  fleetRoutes.attach(server, opts);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}

async function reqJson(server, method, path, { body, token } = {}) {
  const port = server.address().port;
  return await new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let parsed = null;
        if (buf) { try { parsed = JSON.parse(buf); } catch { parsed = buf; } }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function startWithDb() {
  const pg = new Client(PG);
  await pg.connect();
  await pg.query('TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE');
  const server = await startTestServer({ token: 'T', db: pg });
  return { server, pg, close: async () => { server.close(); await pg.end(); } };
}

// --- Task 7: auth + skeleton ---

test('rejects missing auth with 401', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/hosts');
  assert.equal(r.status, 401);
  await close();
});

test('rejects wrong token with 401', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/hosts', { token: 'WRONG' });
  assert.equal(r.status, 401);
  await close();
});

test('404 on unknown route', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/unknown', { token: 'T' });
  assert.equal(r.status, 404);
  await close();
});

test('healthz is reachable without auth', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  await close();
});

// vt-0136: WS auth via short-lived signed ticket instead of bearer-in-subprotocol.
test('vt-0136: POST /fleet/auth/ws-ticket mints a viewer ticket', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'POST', '/fleet/auth/ws-ticket', {
    token: 'T', body: { role: 'viewer' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.ticket);
  assert.equal(r.body.role, 'viewer');
  assert.ok(r.body.expires_in_ms > 0);
  // Ticket shape: base64.hex
  assert.match(r.body.ticket, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  await close();
});

test('vt-0136: POST /fleet/auth/ws-ticket rejects role=daemon', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'POST', '/fleet/auth/ws-ticket', {
    token: 'T', body: { role: 'daemon' },
  });
  assert.equal(r.status, 403);
  await close();
});

test('vt-0136: POST /fleet/auth/ws-ticket rejects unknown role', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'POST', '/fleet/auth/ws-ticket', {
    token: 'T', body: { role: 'attacker' },
  });
  assert.equal(r.status, 422);
  await close();
});

test('vt-0136: WS upgrade accepts ticket.<payload>.<sig> subprotocol', async () => {
  const { server, pg, close } = await startWithDb();
  // 1. Mint ticket
  const port = server.address().port;
  const minted = await reqJson(server, 'POST', '/fleet/auth/ws-ticket', {
    token: 'T', body: { role: 'viewer' },
  });
  assert.equal(minted.status, 200);
  const ticket = minted.body.ticket;
  // 2. Insert a session so WS has something to attach to.
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('hT') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status, exit_code, ended_at) VALUES ($1,'/','exited',0,now()) RETURNING id", [h])).rows[0].id;
  // 3. Open WS with ticket subprotocol — no Authorization header
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=viewer&session_id=${s}`,
    [`ticket.${ticket}`]);
  const msg = await new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    ws.once('message', b => { ws.off('error', onErr); resolve(JSON.parse(b.toString())); });
    ws.once('error', onErr);
    setTimeout(() => { ws.off('error', onErr); reject(new Error('timeout')); }, 2000);
  });
  assert.equal(msg.type, 'hello');
  // Detach all listeners + force-terminate so the post-`close()` socket
  // tear-down doesn't bubble an "Error: Connection terminated" unhandled
  // rejection from the ws internals.
  ws.removeAllListeners();
  ws.on('error', () => {});
  ws.terminate();
  await close();
});

test('vt-0136: WS upgrade rejects forged ticket', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('hF') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status, exit_code, ended_at) VALUES ($1,'/','exited',0,now()) RETURNING id", [h])).rows[0].id;
  // Random base64 + random hex — should fail HMAC verification
  const bad = 'aGVsbG8.' + 'a'.repeat(64);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=viewer&session_id=${s}`,
    [`ticket.${bad}`]);
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
    setTimeout(() => resolve(0), 2000);
  });
  assert.equal(code, 4001);
  await close();
});

// vt-0125: /fleet/sessions/by-bucket used to silently return all sessions on
// a day for dim=model|group|label (set dim_unfiltered:true). Drill-down now
// narrows correctly, or returns 422 for unknown dims.
test('vt-0125: by-bucket dim=label narrows to matching sessions', async () => {
  const { server, pg, close } = await startWithDb();
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('hb') RETURNING id")).rows[0].id;
  await pg.query(`INSERT INTO fleet_sessions (host_id, cwd, status, started_at, label)
                  VALUES ($1, '/', 'exited', now(), 'alpha'),
                         ($1, '/', 'exited', now(), 'beta'),
                         ($1, '/', 'exited', now(), null)`, [h]);
  const day = new Date().toISOString().slice(0, 10);

  const alpha = await reqJson(server, 'GET', `/fleet/sessions/by-bucket?day=${day}&dim=label&value=alpha`, { token: 'T' });
  assert.equal(alpha.status, 200);
  assert.equal(alpha.body.sessions.length, 1);
  assert.equal(alpha.body.sessions[0].label, 'alpha');
  assert.equal(alpha.body.dim_unfiltered, false);

  const unlabeled = await reqJson(server, 'GET', `/fleet/sessions/by-bucket?day=${day}&dim=label&value=${encodeURIComponent('(unlabeled)')}`, { token: 'T' });
  assert.equal(unlabeled.body.sessions.length, 1);
  assert.equal(unlabeled.body.sessions[0].label, null);
  await close();
});

test('vt-0125: by-bucket dim=group narrows via host group membership', async () => {
  const { server, pg, close } = await startWithDb();
  const h1 = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('hg1') RETURNING id")).rows[0].id;
  const h2 = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('hg2') RETURNING id")).rows[0].id;
  const g = (await pg.query("INSERT INTO fleet_groups (name) VALUES ('grp-x') RETURNING id")).rows[0].id;
  await pg.query("INSERT INTO fleet_host_groups (host_id, group_id) VALUES ($1, $2)", [h1, g]);
  await pg.query(`INSERT INTO fleet_sessions (host_id, cwd, status, started_at, label)
                  VALUES ($1, '/', 'exited', now(), 's-in-grp'),
                         ($2, '/', 'exited', now(), 's-orphan')`, [h1, h2]);
  const day = new Date().toISOString().slice(0, 10);

  const inGrp = await reqJson(server, 'GET', `/fleet/sessions/by-bucket?day=${day}&dim=group&value=grp-x`, { token: 'T' });
  assert.equal(inGrp.body.sessions.length, 1);
  assert.equal(inGrp.body.sessions[0].label, 's-in-grp');

  const unGrp = await reqJson(server, 'GET', `/fleet/sessions/by-bucket?day=${day}&dim=group&value=${encodeURIComponent('(ungrouped)')}`, { token: 'T' });
  assert.equal(unGrp.body.sessions.length, 1);
  assert.equal(unGrp.body.sessions[0].label, 's-orphan');
  await close();
});

test('vt-0125: by-bucket unknown dim returns 422', async () => {
  const { server, close } = await startWithDb();
  const day = new Date().toISOString().slice(0, 10);
  const r = await reqJson(server, 'GET', `/fleet/sessions/by-bucket?day=${day}&dim=zorglub&value=x`, { token: 'T' });
  assert.equal(r.status, 422);
  await close();
});

test('vt-0125: by-bucket dim=host with non-uuid value returns 422', async () => {
  const { server, close } = await startWithDb();
  const day = new Date().toISOString().slice(0, 10);
  const r = await reqJson(server, 'GET', `/fleet/sessions/by-bucket?day=${day}&dim=host&value=not-a-uuid`, { token: 'T' });
  assert.equal(r.status, 422);
  await close();
});

// vt-0124: admin/viewer token split for fleet API. The viewer token can only
// read; mutating + execution endpoints require the admin token when configured.
async function startWithAdminSplit() {
  const pg = new Client(PG);
  await pg.connect();
  await pg.query('TRUNCATE fleet_workflow_runs, fleet_workflows RESTART IDENTITY CASCADE');
  await pg.query('TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE');
  const server = http.createServer();
  fleetRoutes.attach(server, { token: 'VIEWER', adminToken: 'ADMIN', db: pg });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, pg, close: async () => { server.close(); await pg.end(); } };
}

test('vt-0124: viewer token can GET but NOT POST workflows', async () => {
  const { server, close } = await startWithAdminSplit();
  const getR = await reqJson(server, 'GET', '/fleet/workflows', { token: 'VIEWER' });
  assert.equal(getR.status, 200);
  const postR = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'VIEWER',
    body: { name: 'attempt', definition: { nodes: [{ id: 'n1', type: 'delay', seconds: 0, position: { x: 0, y: 0 } }], edges: [], start: 'n1' } },
  });
  assert.equal(postR.status, 403);
  assert.match(postR.body?.error || '', /admin token required/);
  await close();
});

test('vt-0124: admin token can POST workflows', async () => {
  const { server, close } = await startWithAdminSplit();
  const r = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'ADMIN',
    body: { name: 'ok', definition: { nodes: [{ id: 'n1', type: 'delay', seconds: 0, position: { x: 0, y: 0 } }], edges: [], start: 'n1' } },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body?.id);
  await close();
});

test('vt-0124: cost-batch (read-shaped POST) is allowed for viewer', async () => {
  const { server, close } = await startWithAdminSplit();
  const r = await reqJson(server, 'POST', '/fleet/sessions/cost-batch', {
    token: 'VIEWER',
    body: { ids: [] },
  });
  // 200 with empty list (or 422 if validation says ids non-empty) — but NOT 403.
  assert.notEqual(r.status, 403);
  await close();
});

// vt-0133: /fleet/exec used to dispatch unbounded — 100 concurrent POSTs
// pinned every host to a session row + viewer hook + 600s timeout each.
// Now capped at MAX_EXEC_PER_HOST (default 5, configurable via env).
test('vt-0133: /fleet/exec returns 429 when host at capacity', async () => {
  const { server, pg, close } = await startWithDb();
  const h = (await pg.query("INSERT INTO fleet_hosts (name, status) VALUES ('hex', 'online') RETURNING id")).rows[0].id;
  // Fill the host with 5 running sessions
  for (let i = 0; i < 5; i++) {
    await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status, started_at, args) VALUES ($1, '/', 'running', now(), '{}')", [h]);
  }
  const r = await reqJson(server, 'POST', '/fleet/exec', {
    token: 'T',
    body: { host_id: h, prompt: 'hi' },
  });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /capacity/);
  await close();
});

// vt-0126: body-size caps. PUT /fleet/hosts/:id/file content used to be
// unbounded — a 100 MiB body would OOM the API + the daemon.
test('vt-0126: readBody rejects body > 1 MiB with 413', async () => {
  const { server, close } = await startWithDb();
  // Use a route that always reads JSON (sessions/cost-batch is read-shape).
  const port = server.address().port;
  // 1.1 MiB of JSON
  const huge = JSON.stringify({ ids: Array(50000).fill('00000000-0000-0000-0000-000000000000') });
  assert.ok(huge.length > 1024 * 1024);
  const r = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/fleet/sessions/cost-batch',
      headers: { 'content-type': 'application/json', authorization: 'Bearer T', 'content-length': Buffer.byteLength(huge) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    req.write(huge);
    req.end();
  });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /exceeds/);
  await close();
});

test('vt-0126: PUT /fleet/hosts/:id/file rejects content > 128 KiB with 413', async () => {
  const { server, pg, close } = await startWithDb();
  const h = (await pg.query("INSERT INTO fleet_hosts (name, status) VALUES ('hf', 'online') RETURNING id")).rows[0].id;
  const oversized = 'x'.repeat(200 * 1024); // 200 KiB
  const r = await reqJson(server, 'PUT', `/fleet/hosts/${h}/file`, {
    token: 'T', body: { path: 'CLAUDE.md', content: oversized },
  });
  assert.equal(r.status, 413);
  await close();
});

test('vt-0124: legacy mode (no admin token) still accepts viewer for writes', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'T',
    body: { name: 'legacy', definition: { nodes: [{ id: 'n1', type: 'delay', seconds: 0, position: { x: 0, y: 0 } }], edges: [], start: 'n1' } },
  });
  assert.equal(r.status, 201);
  await close();
});

// --- Task 8: hosts REST ---

test('GET /fleet/hosts returns empty list initially', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/hosts', { token: 'T' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  await close();
});

test('GET /fleet/hosts returns inserted hosts', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query("INSERT INTO fleet_hosts (name, os, status) VALUES ('mac', 'darwin', 'online')");
  const r = await reqJson(server, 'GET', '/fleet/hosts', { token: 'T' });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].name, 'mac');
  await close();
});

test('GET /fleet/hosts/:id returns 404 for missing', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'GET', '/fleet/hosts/00000000-0000-0000-0000-000000000000', { token: 'T' });
  assert.equal(r.status, 404);
  await close();
});

test('DELETE /fleet/hosts/:id removes host', async () => {
  const { server, pg, close } = await startWithDb();
  const { rows } = await pg.query("INSERT INTO fleet_hosts (name) VALUES ('h') RETURNING id");
  const r = await reqJson(server, 'DELETE', `/fleet/hosts/${rows[0].id}`, { token: 'T' });
  assert.equal(r.status, 204);
  const after = await pg.query('SELECT COUNT(*) FROM fleet_hosts');
  assert.equal(after.rows[0].count, '0');
  await close();
});

// --- Task 9: sessions REST ---

test('POST /fleet/sessions returns 422 without host_id', async () => {
  const { server, close } = await startWithDb();
  const r = await reqJson(server, 'POST', '/fleet/sessions', { token: 'T', body: { cwd: '/' } });
  assert.equal(r.status, 422);
  await close();
});

test('POST /fleet/sessions creates session', async () => {
  const { server, pg, close } = await startWithDb();
  const { rows } = await pg.query("INSERT INTO fleet_hosts (name) VALUES ('h') RETURNING id");
  const r = await reqJson(server, 'POST', '/fleet/sessions', {
    token: 'T', body: { host_id: rows[0].id, cwd: '/tmp', args: ['--print', 'hi'] },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.session_id);
  await close();
});

test('GET /fleet/sessions filters by host_id', async () => {
  const { server, pg, close } = await startWithDb();
  const h1 = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('a') RETURNING id")).rows[0].id;
  const h2 = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('b') RETURNING id")).rows[0].id;
  await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/')", [h1]);
  await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/')", [h2]);
  const r = await reqJson(server, 'GET', `/fleet/sessions?host_id=${h1}`, { token: 'T' });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  await close();
});

test('GET /fleet/sessions/:id/transcript.txt returns plain text', async () => {
  const { server, pg, close } = await startWithDb();
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('t') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/') RETURNING id", [h])).rows[0].id;
  await pg.query(`INSERT INTO fleet_events (session_id, kind, seq, payload) VALUES
    ($1, 'pty_out', 0, decode('48656c6c6f','hex')),
    ($1, 'pty_out', 1, decode('20576f726c64','hex'))`, [s]);
  const port = server.address().port;
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/fleet/sessions/${s}/transcript.txt`,
      method: 'GET', headers: { authorization: 'Bearer T' } }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'Hello World');
  await close();
});

// --- Task 10: WS upgrade ---

test('WS rejects connection without bearer', async () => {
  const { server, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=x`);
  const code = await new Promise(r => ws.on('close', (c) => r(c)));
  assert.equal(code, 4001);
  await close();
});

test('WS rejects unknown role with 4003', async () => {
  const { server, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=bogus`, {
    headers: { authorization: 'Bearer T' },
  });
  const code = await new Promise(r => ws.on('close', (c) => r(c)));
  assert.equal(code, 4003);
  await close();
});

test('WS daemon connect: receives welcome', async () => {
  const { server, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=t1`, {
    headers: { authorization: 'Bearer T' },
  });
  await new Promise(r => ws.on('open', r));
  const msg = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  assert.equal(msg.type, 'welcome');
  assert.ok(msg.host_id);
  ws.close();
  await close();
});

// --- Task 11: daemon WS protocol ---

test('daemon spawn_ok marks session running with pid', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=h1`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd) VALUES ($1, '/') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  ws.send(JSON.stringify({ type: 'spawn_ok', session_id: sid, pid: 4242 }));
  await new Promise(r => setTimeout(r, 100));
  const after = await pg.query('SELECT status, pid FROM fleet_sessions WHERE id=$1', [sid]);
  assert.equal(after.rows[0].status, 'running');
  assert.equal(after.rows[0].pid, 4242);
  ws.close();
  await close();
});

test('daemon pty_data appended to fleet_events', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=h2`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  ws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: 0, data: Buffer.from('hi').toString('base64') }));
  await new Promise(r => setTimeout(r, 400));
  const ev = await pg.query("SELECT payload FROM fleet_events WHERE session_id=$1 AND kind='pty_out'", [sid]);
  assert.equal(ev.rows[0].payload.toString(), 'hi');
  ws.close();
  await close();
});

test('daemon session_exit marks session exited', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=h3`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => ws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  ws.send(JSON.stringify({ type: 'session_exit', session_id: sid, exit_code: 0 }));
  await new Promise(r => setTimeout(r, 100));
  const after = await pg.query('SELECT status, exit_code FROM fleet_sessions WHERE id=$1', [sid]);
  assert.equal(after.rows[0].status, 'exited');
  assert.equal(after.rows[0].exit_code, 0);
  ws.close();
  await close();
});

test('reconciliation flips dead session to exited', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('r1') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status, pid) VALUES ($1, '/', 'running', 999) RETURNING id", [h])).rows[0].id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=r1`,
    { headers: { authorization: 'Bearer T' } });
  await new Promise(r => ws.on('message', () => r()));
  ws.send(JSON.stringify({
    type: 'reconciliation',
    sessions: [{ session_id: s, pid: 999, alive: false, exit_code: 137, last_seq: 50 }],
  }));
  await new Promise(r => setTimeout(r, 100));
  const after = await pg.query('SELECT status, exit_code FROM fleet_sessions WHERE id=$1', [s]);
  assert.equal(after.rows[0].status, 'killed');
  assert.equal(after.rows[0].exit_code, 137);
  ws.close();
  await close();
});

// --- Task 12: viewer WS ---

test('viewer receives backfill from ring buffer + live frames', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const dws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=v1`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => dws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1,'/','running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  dws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: 0, data: Buffer.from('first').toString('base64') }));
  await new Promise(r => setTimeout(r, 50));
  const vws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=viewer&session_id=${sid}`,
    { headers: { authorization: 'Bearer T' } });
  const msgs = [];
  vws.on('message', (b) => msgs.push(JSON.parse(b.toString())));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(msgs[0].type, 'hello');
  assert.equal(msgs[1].type, 'backfill');
  assert.equal(Buffer.from(msgs[1].data, 'base64').toString(), 'first');
  dws.send(JSON.stringify({ type: 'pty_data', session_id: sid, seq: 1, data: Buffer.from('live').toString('base64') }));
  await new Promise(r => setTimeout(r, 100));
  const live = msgs.find(m => m.type === 'pty_data' && m.seq === 1);
  assert.ok(live, 'live frame should arrive');
  dws.close(); vws.close();
  await close();
});

test('viewer attached to an exited session gets hello + backfill replay', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('xv') RETURNING id")).rows[0].id;
  const s = (await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status, exit_code, ended_at) VALUES ($1,'/','exited',0,now()) RETURNING id", [h])).rows[0].id;
  await pg.query(`INSERT INTO fleet_events (session_id, kind, seq, payload) VALUES
    ($1, 'pty_out', 0, decode('616263','hex'))`, [s]);
  const port2 = server.address().port;
  const vws = new WebSocket(`ws://127.0.0.1:${port2}/fleet/ws?role=viewer&session_id=${s}`,
    { headers: { authorization: 'Bearer T' } });
  const msgs = [];
  vws.on('message', (b) => msgs.push(JSON.parse(b.toString())));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(msgs[0].type, 'hello');
  const bf = msgs.find(m => m.type === 'backfill');
  assert.ok(bf, 'exited session should backfill');
  assert.equal(Buffer.from(bf.data, 'base64').toString(), 'abc');
  vws.close();
  await close();
});

test('viewer input forwards to daemon ws', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const dws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=v2`,
    { headers: { authorization: 'Bearer T' } });
  const welcome = await new Promise(r => dws.on('message', (b) => r(JSON.parse(b.toString()))));
  const sess = await pg.query("INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1,'/','running') RETURNING id", [welcome.host_id]);
  const sid = sess.rows[0].id;
  const received = [];
  dws.on('message', (b) => received.push(JSON.parse(b.toString())));
  const vws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=viewer&session_id=${sid}`,
    { headers: { authorization: 'Bearer T' } });
  // Wait for server-side handler to register message listener (hello frame = ready)
  await new Promise(r => vws.on('message', (b) => { if (JSON.parse(b.toString()).type === 'hello') r(); }));
  vws.send(JSON.stringify({ type: 'input', data: 'echo hi\n' }));
  await new Promise(r => setTimeout(r, 100));
  const inputFrame = received.find(f => f.type === 'input' && f.session_id === sid);
  assert.ok(inputFrame, `no input frame received: ${JSON.stringify(received)}`);
  assert.equal(inputFrame.data, 'echo hi\n');
  dws.close(); vws.close();
  await close();
});

// --- Workflows ---

async function startWithWorkflows() {
  const pg = new Client(PG);
  await pg.connect();
  await pg.query('TRUNCATE fleet_workflow_runs, fleet_workflows RESTART IDENTITY CASCADE');
  await pg.query('TRUNCATE fleet_hosts, fleet_sessions, fleet_events RESTART IDENTITY CASCADE');
  const server = await startTestServer({ token: 'T', db: pg });
  return { server, pg, close: async () => { server.close(); await pg.end(); } };
}

const TINY_DEF = {
  start: 'n1',
  nodes: [{ id: 'n1', type: 'delay', seconds: 0, position: { x: 0, y: 0 } }],
  edges: [],
};

test('POST /fleet/workflows creates workflow', async () => {
  const { server, close } = await startWithWorkflows();
  const r = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'T', body: { name: 'wf-test', definition: TINY_DEF },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.id);
  await close();
});

test('GET /fleet/workflows lists workflows', async () => {
  const { server, close } = await startWithWorkflows();
  await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'T', body: { name: 'wf-list', definition: TINY_DEF },
  });
  const r = await reqJson(server, 'GET', '/fleet/workflows', { token: 'T' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.find(w => w.name === 'wf-list'));
  await close();
});

test('POST /fleet/workflows rejects invalid definition', async () => {
  const { server, close } = await startWithWorkflows();
  const r = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'T', body: { name: 'bad', definition: { start: 'ghost', nodes: [{ id: 'a', type: 'delay' }], edges: [] } },
  });
  assert.equal(r.status, 422);
  await close();
});

test('POST /fleet/workflows/:id/run starts a run', async () => {
  const { server, close } = await startWithWorkflows();
  const c = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'T', body: { name: 'wf-run', definition: TINY_DEF },
  });
  const r = await reqJson(server, 'POST', `/fleet/workflows/${c.body.id}/run`, {
    token: 'T', body: {},
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.run_id);
  // Give runner a moment so we don't leak open delays
  await new Promise(r => setTimeout(r, 100));
  await close();
});

test('WS role workflow_viewer streams run_state and node_progress', async () => {
  const { server, close } = await startWithWorkflows();
  const port = server.address().port;
  const c = await reqJson(server, 'POST', '/fleet/workflows', {
    token: 'T', body: { name: 'wf-ws', definition: TINY_DEF },
  });
  const r = await reqJson(server, 'POST', `/fleet/workflows/${c.body.id}/run`, {
    token: 'T', body: {},
  });
  // Sleep briefly so runner has begun (it's async)
  await new Promise(r => setTimeout(r, 50));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=workflow_viewer&run_id=${r.body.run_id}`,
    { headers: { authorization: 'Bearer T' } });
  const frames = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout, frames=${JSON.stringify(frames)}`)), 1000);
    ws.on('message', (b) => {
      const f = JSON.parse(b.toString());
      frames.push(f);
      // Either: live frames sent while we attach, or initial replay of done state
      if (f.type === 'run_state' && (f.status === 'done' || f.status === 'running')) {
        clearTimeout(timer); resolve();
      }
    });
    ws.on('error', reject);
  });
  ws.close();
  assert.ok(frames.find(f => f.type === 'run_state'), 'must receive run_state frame');
  await close();
});

test('WS role workflow_viewer rejects missing run_id', async () => {
  const { server, close } = await startWithWorkflows();
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=workflow_viewer`,
    { headers: { authorization: 'Bearer T' } });
  const closeCode = await new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
  assert.equal(closeCode, 4002);
  await close();
});

// --- Pricing ---

async function startWithPrices() {
  const pg = new Client(PG);
  await pg.connect();
  await pg.query('TRUNCATE fleet_model_prices RESTART IDENTITY');
  await pg.query(`
    INSERT INTO fleet_model_prices (match_pattern, priority, valid_from, input_per_mtok, output_per_mtok, cache_create_per_mtok, cache_read_per_mtok, flagged)
    VALUES
      ('claude-opus-%',   200, '1970-01-01', 15, 75, 18.75, 1.50, false),
      ('%',                 0, '1970-01-01',  0,  0,     0,    0, true)`);
  const server = await startTestServer({ token: 'T', db: pg });
  return { server, pg, close: async () => { server.close(); await pg.end(); } };
}

test('GET /fleet/prices lists active rows', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'GET', '/fleet/prices', { token: 'T' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.find(p => p.match_pattern === 'claude-opus-%'));
  await close();
});

test('POST /fleet/prices inserts new snapshot row', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'gpt-4o%', input_per_mtok: 2.5, output_per_mtok: 10 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.match_pattern, 'gpt-4o%');
  await close();
});

test('POST /fleet/prices rejects missing fields', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'x' },
  });
  assert.equal(r.status, 422);
  await close();
});

test('DELETE /fleet/prices/:id soft-deletes', async () => {
  const { server, pg, close } = await startWithPrices();
  const created = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'temp%', input_per_mtok: 1, output_per_mtok: 1 },
  });
  const id = created.body.id;
  const del = await reqJson(server, 'DELETE', `/fleet/prices/${id}`, { token: 'T' });
  assert.equal(del.status, 204);
  const { rows } = await pg.query('SELECT deleted_at FROM fleet_model_prices WHERE id = $1', [id]);
  assert.ok(rows[0].deleted_at);
  await close();
});

test('POST /fleet/prices/resolve returns matched row + ZERO_PRICE for unknown', async () => {
  const { server, close } = await startWithPrices();
  const known = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'claude-opus-4-7' },
  });
  assert.equal(known.status, 200);
  assert.equal(known.body.matched.input, 15);
  assert.equal(known.body.matched.flagged, false);

  const unknown = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'totally-new-llm' },
  });
  assert.equal(unknown.body.matched.flagged, true);
  await close();
});

test('POST /fleet/prices invalidates cache: subsequent resolve sees new price', async () => {
  const { server, close } = await startWithPrices();
  const r1 = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'claude-opus-4-7' },
  });
  assert.equal(r1.body.matched.input, 15);
  await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'claude-opus-4-7', priority: 500, input_per_mtok: 99, output_per_mtok: 99 },
  });
  const r2 = await reqJson(server, 'POST', '/fleet/prices/resolve', {
    token: 'T', body: { model: 'claude-opus-4-7' },
  });
  assert.equal(r2.body.matched.input, 99);
  await close();
});

test('GET /fleet/prices?history=1 includes soft-deleted rows', async () => {
  const { server, close } = await startWithPrices();
  const created = await reqJson(server, 'POST', '/fleet/prices', {
    token: 'T', body: { match_pattern: 'tmp-%', input_per_mtok: 5, output_per_mtok: 5 },
  });
  await reqJson(server, 'DELETE', `/fleet/prices/${created.body.id}`, { token: 'T' });

  const active = await reqJson(server, 'GET', '/fleet/prices', { token: 'T' });
  assert.ok(!active.body.find(p => p.id === created.body.id), 'soft-deleted hidden by default');

  const all = await reqJson(server, 'GET', '/fleet/prices?history=1', { token: 'T' });
  assert.ok(all.body.find(p => p.id === created.body.id), 'soft-deleted visible with history=1');
  await close();
});

test('GET /fleet/prices rejects missing auth', async () => {
  const { server, close } = await startWithPrices();
  const r = await reqJson(server, 'GET', '/fleet/prices');
  assert.equal(r.status, 401);
  await close();
});

// --- Host metrics + inventory ---

test('GET /fleet/hosts/:id/metrics returns time-series rows', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query(`TRUNCATE fleet_host_metrics`);
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('htm') RETURNING id`);
  const hostId = h.rows[0].id;
  await pg.query(`INSERT INTO fleet_host_metrics (host_id, ts, cpu_pct, ram_used_bytes, ram_total_bytes)
                  VALUES ($1, now(), 25, 1024, 4096)`, [hostId]);
  const r = await reqJson(server, 'GET', `/fleet/hosts/${hostId}/metrics?since=1h`, { token: 'T' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.strictEqual(r.body.length, 1);
  assert.strictEqual(r.body[0].cpu_pct, 25);
  await close();
});

test('GET /fleet/hosts/:id/metrics rejects invalid since param', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('htm2') RETURNING id`);
  const r = await reqJson(server, 'GET', `/fleet/hosts/${h.rows[0].id}/metrics?since=999d`, { token: 'T' });
  assert.equal(r.status, 422);
  await close();
});

test('GET /fleet/hosts/:id/inventory returns empty object if not set', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('hti') RETURNING id`);
  const r = await reqJson(server, 'GET', `/fleet/hosts/${h.rows[0].id}/inventory`, { token: 'T' });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, {});
  await close();
});

test('WS role metrics_viewer streams initial snapshot from metadata', async () => {
  const { server, pg, close } = await startWithDb();
  const h = await pg.query(`INSERT INTO fleet_hosts (name) VALUES ('mvs') RETURNING id`);
  const hostId = h.rows[0].id;
  await pg.query(
    `UPDATE fleet_hosts SET metadata = jsonb_build_object('latest_metrics', $2::jsonb) WHERE id=$1`,
    [hostId, JSON.stringify({ ts: new Date().toISOString(), cpu_pct: 17, ram_used_bytes: 100, ram_total_bytes: 4096 })],
  );
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/fleet/ws?role=metrics_viewer&host_id=${hostId}`,
    { headers: { authorization: 'Bearer T' } });
  const frame = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 1000);
    ws.on('message', (b) => { clearTimeout(t); resolve(JSON.parse(b.toString())); });
    ws.on('error', reject);
  });
  assert.strictEqual(frame.type, 'metrics');
  assert.strictEqual(frame.cpu_pct, 17);
  ws.close();
  await close();
});

test('PATCH /fleet/groups/:id rejects duplicate name with 409', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query(`TRUNCATE fleet_groups CASCADE`);
  const a = await pg.query(`INSERT INTO fleet_groups (name) VALUES ('alpha-r') RETURNING id`);
  await pg.query(`INSERT INTO fleet_groups (name) VALUES ('beta-r')`);
  const r = await reqJson(server, 'PATCH', `/fleet/groups/${a.rows[0].id}`, {
    token: 'T', body: { name: 'beta-r' },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already exists/);
  await close();
});

test('PATCH /fleet/groups/:id rejects invalid color hex with 422', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query(`TRUNCATE fleet_groups CASCADE`);
  const g = await pg.query(`INSERT INTO fleet_groups (name) VALUES ('g-color-test') RETURNING id`);
  const bad = await reqJson(server, 'PATCH', `/fleet/groups/${g.rows[0].id}`, {
    token: 'T', body: { color: 'javascript:alert(1)' },
  });
  assert.equal(bad.status, 422);
  const ok = await reqJson(server, 'PATCH', `/fleet/groups/${g.rows[0].id}`, {
    token: 'T', body: { color: '#abc123' },
  });
  assert.equal(ok.status, 200);
  await close();
});

test('POST /fleet/broadcast resolves tag via group-label inheritance', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query(`TRUNCATE fleet_hosts, fleet_groups, fleet_host_groups CASCADE`);
  // Host h-inh has no direct caps but is in group with label 'gpu-inherit'
  const h = await pg.query(`INSERT INTO fleet_hosts (name, status, capabilities) VALUES ('h-inh', 'online', '{}') RETURNING id`);
  const g = await pg.query(`INSERT INTO fleet_groups (name, labels) VALUES ('gr-inh', ARRAY['gpu-inherit']) RETURNING id`);
  await pg.query(`INSERT INTO fleet_host_groups (host_id, group_id) VALUES ($1, $2)`, [h.rows[0].id, g.rows[0].id]);
  const r = await reqJson(server, 'POST', '/fleet/broadcast', {
    token: 'T', body: { tag: 'gpu-inherit', cwd: '/' },
  });
  // Should find at least 1 host via group-label inheritance.
  // (response shape may vary; 4xx if zero matches means inheritance not working)
  assert.notEqual(r.status, 404, `broadcast should resolve inherited tag, got ${r.status} ${JSON.stringify(r.body)}`);
  await close();
});

// vt-0441 CRIT hotfix: reconciliation with sessions:[] MUST sweep all
// orphaned/running sessions on the host. Before the fix, empty mentionedIds
// produced `id NOT IN (NULL)` which is always UNKNOWN in SQL — so the sweep
// silently skipped every row. Test exercises the fixed code path.
test('vt-0441: reconciliation with sessions:[] sweeps orphaned rows to exited', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  // Use a unique host name to avoid cross-test contamination.
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('recon-empty-host') RETURNING id")).rows[0].id;
  // Seed two orphaned sessions on this host.
  const s1 = (await pg.query(
    "INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'orphaned') RETURNING id", [h]
  )).rows[0].id;
  const s2 = (await pg.query(
    "INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'orphaned') RETURNING id", [h]
  )).rows[0].id;
  // Connect daemon as this host (it will upsert the host row so host_id is resolved).
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=recon-empty-host`,
    { headers: { authorization: 'Bearer T' } },
  );
  // Wait for welcome (daemon is now the registered handler for this host).
  await new Promise(r => ws.on('message', () => r()));
  // Send reconciliation with an EMPTY sessions list — the hotfix case.
  ws.send(JSON.stringify({ type: 'reconciliation', sessions: [] }));
  await new Promise(r => setTimeout(r, 150));
  // Both orphaned sessions must be transitioned to 'exited'.
  const after = await pg.query(
    'SELECT id, status FROM fleet_sessions WHERE id = ANY($1::uuid[])',
    [[s1, s2]],
  );
  for (const row of after.rows) {
    assert.equal(row.status, 'exited',
      `session ${row.id} should be exited after empty-list reconciliation, got ${row.status}`);
  }
  ws.removeAllListeners();
  ws.on('error', () => {});
  ws.terminate();
  await close();
});

test('vt-0441: reconciliation with sessions:[] also sweeps running rows', async () => {
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('recon-running-host') RETURNING id")).rows[0].id;
  // A 'running' session left over from a previous daemon crash.
  const s = (await pg.query(
    "INSERT INTO fleet_sessions (host_id, cwd, status, pid) VALUES ($1, '/', 'running', 42) RETURNING id", [h]
  )).rows[0].id;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=recon-running-host`,
    { headers: { authorization: 'Bearer T' } },
  );
  await new Promise(r => ws.on('message', () => r()));
  ws.send(JSON.stringify({ type: 'reconciliation', sessions: [] }));
  await new Promise(r => setTimeout(r, 150));
  const after = await pg.query('SELECT status FROM fleet_sessions WHERE id=$1', [s]);
  assert.equal(after.rows[0].status, 'exited',
    `running session should be swept to exited by empty-list reconciliation`);
  ws.removeAllListeners();
  ws.on('error', () => {});
  ws.terminate();
  await close();
});

test('vt-0441: reconciliation with non-empty sessions: leaves mentioned sessions untouched', async () => {
  // Regression guard: the non-empty path must NOT sweep sessions it mentioned.
  const { server, pg, close } = await startWithDb();
  const port = server.address().port;
  const h = (await pg.query("INSERT INTO fleet_hosts (name) VALUES ('recon-partial-host') RETURNING id")).rows[0].id;
  const alive = (await pg.query(
    "INSERT INTO fleet_sessions (host_id, cwd, status, pid) VALUES ($1, '/', 'running', 77) RETURNING id", [h]
  )).rows[0].id;
  const dead = (await pg.query(
    "INSERT INTO fleet_sessions (host_id, cwd, status) VALUES ($1, '/', 'orphaned') RETURNING id", [h]
  )).rows[0].id;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/fleet/ws?role=daemon&host_name=recon-partial-host`,
    { headers: { authorization: 'Bearer T' } },
  );
  await new Promise(r => ws.on('message', () => r()));
  // Mention `alive` as alive=true, but NOT `dead`.
  ws.send(JSON.stringify({
    type: 'reconciliation',
    sessions: [{ session_id: alive, pid: 77, alive: true, last_seq: 0 }],
  }));
  await new Promise(r => setTimeout(r, 150));
  const aliveRow = await pg.query('SELECT status FROM fleet_sessions WHERE id=$1', [alive]);
  const deadRow  = await pg.query('SELECT status FROM fleet_sessions WHERE id=$1', [dead]);
  // `alive` session should stay running (marked via markSessionRunning).
  assert.equal(aliveRow.rows[0].status, 'running',
    'mentioned+alive session must stay running');
  // `dead` (orphaned, not mentioned) should be swept to exited.
  assert.equal(deadRow.rows[0].status, 'exited',
    'unmentioned orphaned session must be swept to exited');
  ws.removeAllListeners();
  ws.on('error', () => {});
  ws.terminate();
  await close();
});

test('PATCH /fleet/groups/:id with expected_version returns 409 on conflict', async () => {
  const { server, pg, close } = await startWithDb();
  await pg.query(`TRUNCATE fleet_groups CASCADE`);
  const g = await pg.query(`INSERT INTO fleet_groups (name) VALUES ('vc-test') RETURNING id, version`);
  const gid = g.rows[0].id;
  // First PATCH with expected_version=1 succeeds → version bumps to 2
  const r1 = await reqJson(server, 'PATCH', `/fleet/groups/${gid}`, {
    token: 'T', body: { description: 'first', expected_version: 1 },
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.version, 2, `version should bump to 2, got ${r1.body.version}`);
  // Second PATCH with stale expected_version=1 → 409
  const r2 = await reqJson(server, 'PATCH', `/fleet/groups/${gid}`, {
    token: 'T', body: { description: 'second', expected_version: 1 },
  });
  assert.equal(r2.status, 409);
  assert.match(r2.body.error, /version conflict/);
  assert.ok(r2.body.current, 'response should include current row for client to reconcile');
  // PATCH without expected_version still works (back-compat)
  const r3 = await reqJson(server, 'PATCH', `/fleet/groups/${gid}`, {
    token: 'T', body: { description: 'third' },
  });
  assert.equal(r3.status, 200);
  await close();
});
