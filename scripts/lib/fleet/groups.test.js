'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { register } = require('./groups');

function fakeReq({ method = 'POST', url = '/fleet/groups', body = null } = {}) {
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

test('groups: register() returns 7 routes', () => {
  const routes = register({ fleetDb: {} });
  assert.strictEqual(routes.length, 7);
  const methods = routes.map(r => r.method);
  assert.strictEqual(methods.filter(m => m === 'GET').length, 2);
  assert.strictEqual(methods.filter(m => m === 'POST').length, 2);
  assert.strictEqual(methods.filter(m => m === 'PATCH').length, 1);
  assert.strictEqual(methods.filter(m => m === 'DELETE').length, 2);
});

test('groups: POST without name returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /groups\$$/.test(r.pattern.source));
  const req = fakeReq({ body: {} });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /name required/);
});

test('groups: POST with invalid color returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /groups\$$/.test(r.pattern.source));
  const req = fakeReq({ body: { name: 'test', color: 'not-hex' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /color/);
});

test('groups: POST with brain_prompt > 32768 chars returns 422', async () => {
  const routes = register({ fleetDb: {} });
  const postRoute = routes.find(r => r.method === 'POST' && /groups\$$/.test(r.pattern.source));
  const longPrompt = 'x'.repeat(32769);
  const req = fakeReq({ body: { name: 'test', brain_prompt: longPrompt } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {} });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /brain_prompt.*too long/);
});
