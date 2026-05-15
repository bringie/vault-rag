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
  await new Promise(r => setTimeout(r, 150));
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
