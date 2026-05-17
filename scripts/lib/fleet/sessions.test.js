'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { register } = require('./sessions');

function fakeReq({ method = 'POST', url = '/fleet/sessions', body = null } = {}) {
  const r = new EventEmitter();
  r.method = method;
  r.url = url;
  r.headers = {};
  setImmediate(() => {
    if (body !== null) r.emit('data', Buffer.from(JSON.stringify(body)));
    r.emit('end');
  });
  return r;
}

function fakeRes() {
  const r = { headersSent: false, statusCode: 200, body: null };
  r.writeHead = (s, h) => { r.statusCode = s; r.headersSent = true; };
  r.end = (b) => { r.body = b ? JSON.parse(b) : null; };
  r.setHeader = () => {};
  r.req = null;
  return r;
}

test('sessions: register() returns 8 routes', () => {
  const routes = register({ fleetDb: {} });
  assert.strictEqual(routes.length, 8);
  const methods = routes.map(r => r.method);
  assert.strictEqual(methods.filter(m => m === 'GET').length, 2);
  assert.strictEqual(methods.filter(m => m === 'POST').length, 5);
  assert.strictEqual(methods.filter(m => m === 'PATCH').length, 1);
});

test('sessions: POST /fleet/sessions without host_id returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && r.pattern.test('/fleet/sessions'));
  const req = fakeReq({ body: { cwd: '/tmp' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {}, bus: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /host_id required/);
});

test('sessions: POST /fleet/sessions without cwd returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && r.pattern.test('/fleet/sessions'));
  const req = fakeReq({ body: { host_id: 'test-host' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {}, bus: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /cwd required/);
});

test('sessions: POST /fleet/sessions/cleanup with invalid older_than returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const cleanupRoute = routes.find(r => r.method === 'POST' && r.pattern.test('/fleet/sessions/cleanup'));
  const req = fakeReq({ method: 'POST', url: '/fleet/sessions/cleanup', body: { older_than: '999 years' } });
  const res = fakeRes();
  res.req = req;

  await cleanupRoute.handler(req, res, { db: {}, bus: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /invalid older_than/);
});

test('sessions: POST /fleet/broadcast without tag/group/all returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const bcRoute = routes.find(r => r.method === 'POST' && r.pattern.test('/fleet/broadcast'));
  const req = fakeReq({ method: 'POST', url: '/fleet/broadcast', body: { cwd: '/tmp' } });
  const res = fakeRes();
  res.req = req;

  await bcRoute.handler(req, res, { db: {}, bus: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /tag\|group\|all required/);
});
