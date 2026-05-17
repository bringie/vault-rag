'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { register } = require('./features');

function fakeReq({ method = 'GET', url = '/fleet/features', body = null } = {}) {
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

test('features: register() returns 2 routes', () => {
  const routes = register({
    fleetDb: {},
    callerFp: () => 'test-fp',
  });
  assert.strictEqual(routes.length, 2);
  assert.strictEqual(routes[0].method, 'GET');
  assert.strictEqual(routes[1].method, 'PATCH');
});

test('features: PATCH with empty body returns 422', async () => {
  const routes = register({
    fleetDb: {},
    callerFp: () => 'test-fp',
  });
  const patchRoute = routes.find(r => r.method === 'PATCH');
  const req = fakeReq({ method: 'PATCH', url: '/fleet/features/test-flag', body: null });
  const res = fakeRes();
  res.req = req;

  await patchRoute.handler(req, res, { db: {} }, ['test-flag']);
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /body required/);
});

test('features: PATCH with non-boolean enabled returns 422', async () => {
  const routes = register({
    fleetDb: {},
    callerFp: () => 'test-fp',
  });
  const patchRoute = routes.find(r => r.method === 'PATCH');
  const req = fakeReq({ method: 'PATCH', url: '/fleet/features/test-flag', body: { enabled: 'yes' } });
  const res = fakeRes();
  res.req = req;

  await patchRoute.handler(req, res, { db: {} }, ['test-flag']);
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /enabled.*boolean/);
});
