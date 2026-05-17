'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { register } = require('./webhooks');

function fakeReq({ method = 'POST', url = '/fleet/webhooks', body = null } = {}) {
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

test('webhooks: register() returns 7 routes', () => {
  const routes = register({ fleetDb: {} });
  assert.strictEqual(routes.length, 7);
  const methods = routes.map(r => r.method);
  assert.strictEqual(methods.filter(m => m === 'GET').length, 3);
  assert.strictEqual(methods.filter(m => m === 'POST').length, 2);
  assert.strictEqual(methods.filter(m => m === 'PATCH').length, 1);
  assert.strictEqual(methods.filter(m => m === 'DELETE').length, 1);
});

test('webhooks: POST /fleet/webhooks empty body returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /webhooks\$$/.test(r.pattern.source));
  const req = fakeReq({ body: null });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /body required/);
});

test('webhooks: POST with missing url returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /webhooks\$$/.test(r.pattern.source));
  const req = fakeReq({ body: { events: [] } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /url required/);
});

test('webhooks: POST with non-http(s) url returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /webhooks\$$/.test(r.pattern.source));
  const req = fakeReq({ body: { url: 'ftp://example.com/hook' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /http/);
});

test('webhooks: POST with non-array events returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /webhooks\$$/.test(r.pattern.source));
  const req = fakeReq({ body: { url: 'https://example.com/hook', events: 'not-array' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /events.*array/);
});
