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
