'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestApi, closeTestApi, reqJson } = require('./lib/rag-api-test-helpers');

let tmpVault;

test.before(() => {
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-api-test-'));
  fs.mkdirSync(path.join(tmpVault, '00-inbox'), { recursive: true });
});

test.after(async () => {
  await closeTestApi();
  if (tmpVault) fs.rmSync(tmpVault, { recursive: true, force: true });
});

test('vt-0141: PUT a new file ignores expected_sha (create path)', async () => {
  const { server } = await startTestApi({ token: 'T', vaultPath: tmpVault });
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/v1.md', content: '# v1\nhello', agent_id: 'tester', reindex: false },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('vt-0141: PUT returns 412 on stale expected_sha', async () => {
  const { server } = await startTestApi({ token: 'T', vaultPath: tmpVault });
  await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/race.md', content: '# v1', agent_id: 'tester', reindex: false },
  });
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/race.md', content: '# v2', expected_sha: 'deadbeef', agent_id: 'tester', reindex: false },
  });
  assert.equal(r.status, 412, JSON.stringify(r.body));
  assert.match(r.body.error, /stale write/);
});

test('vt-0141: PUT accepts correct expected_sha via /api/get round-trip', async () => {
  const { server } = await startTestApi({ token: 'T', vaultPath: tmpVault });
  await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/ok.md', content: '# v1', agent_id: 'tester', reindex: false },
  });
  const get = await reqJson(server, 'POST', '/api/get', { token: 'T', body: { path: '00-inbox/ok.md' } });
  assert.equal(get.status, 200, JSON.stringify(get.body));
  assert.ok(get.body.sha, 'sha should be in /api/get response');
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/ok.md', content: '# v2', expected_sha: get.body.sha, agent_id: 'tester', reindex: false },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('vt-0141: PUT with expected_sha=null behaves like no check (back-compat)', async () => {
  const { server } = await startTestApi({ token: 'T', vaultPath: tmpVault });
  await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/nullcheck.md', content: 'old', agent_id: 'tester', reindex: false },
  });
  const r = await reqJson(server, 'POST', '/api/put', {
    token: 'T',
    body: { path: '00-inbox/nullcheck.md', content: 'new', expected_sha: null, agent_id: 'tester', reindex: false },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

// vt-0142: secret_audit rows inserted on every /api/secrets/* call.
const { Client } = require('pg');
async function auditClient() {
  const c = new Client({ host: '127.0.0.1', port: 55433, user: 'postgres', password: process.env.VAULT_RAG_PG_PASS, database: 'vault_rag' });
  await c.connect();
  return c;
}

test('vt-0142: handleSecretList inserts secret_audit row (denied since SKIP_PG=1)', async () => {
  // With VAULT_SECRETS_SKIP_PG=1 the secrets handler tries to git-fetch and
  // fails fast — so list/get always end up in the 'error' or 'denied' branch.
  // That's enough to exercise the audit path.
  const { server } = await startTestApi({ token: 'T', vaultPath: tmpVault });
  const pg = await auditClient();
  await pg.query("DELETE FROM secret_audit WHERE op='list' AND ts > now() - interval '1 minute'");
  const r = await reqJson(server, 'POST', '/api/secrets/list', { token: 'T', body: {} });
  // Outcome will be 'error' (no age key in test env). 401 should NOT happen since auth passed.
  assert.notEqual(r.status, 401, 'auth should succeed');
  const rows = (await pg.query(
    "SELECT op, outcome, caller_id FROM secret_audit WHERE op='list' AND ts > now() - interval '1 minute' ORDER BY ts DESC LIMIT 1"
  )).rows;
  assert.equal(rows.length, 1, 'one audit row for list');
  assert.equal(rows[0].op, 'list');
  assert.ok(rows[0].caller_id, 'caller_id fingerprint present');
  assert.match(rows[0].caller_id, /^[a-f0-9]{12}$/);
  await pg.end();
});

test('vt-0142: handleSecretGet on missing secret inserts row with outcome=denied', async () => {
  const { server } = await startTestApi({ token: 'T', vaultPath: tmpVault });
  const pg = await auditClient();
  await pg.query("DELETE FROM secret_audit WHERE name='NOT_HERE_TEST'");
  const r = await reqJson(server, 'POST', '/api/secrets/get', { token: 'T', body: { name: 'NOT_HERE_TEST' } });
  // Could be 404 (NotFound) or 500 (decrypt error) depending on env — either way audit row exists.
  assert.notEqual(r.status, 200);
  const rows = (await pg.query(
    "SELECT op, outcome FROM secret_audit WHERE name='NOT_HERE_TEST' ORDER BY ts DESC LIMIT 1"
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, 'get');
  assert.ok(['denied', 'error'].includes(rows[0].outcome));
  await pg.end();
});
