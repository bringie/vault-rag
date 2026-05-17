'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { register } = require('./agent-roles');

function fakeReq({ method = 'POST', url = '/fleet/agent-roles', body = null } = {}) {
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

test('agent-roles: register() returns 9 routes', () => {
  const routes = register({
    fleetDb: {},
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  assert.strictEqual(routes.length, 9);
  assert.strictEqual(routes[0].method, 'GET');
  assert.match(routes[0].pattern.source, /agent-roles/);
  assert.strictEqual(routes[1].method, 'POST');
});

test('agent-roles: POST /fleet/agent-roles with empty body returns 422', async () => {
  const routes = register({
    fleetDb: {},
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  const postRoute = routes.find(r => r.method === 'POST' && /agent-roles\$$/.test(r.pattern.source));
  const req = fakeReq({ body: null });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {}, adminToken: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /body required/);
});

test('agent-roles: POST with missing name returns 422', async () => {
  const routes = register({
    fleetDb: {},
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  const postRoute = routes.find(r => r.method === 'POST' && /agent-roles\$$/.test(r.pattern.source));
  const req = fakeReq({ body: { prompt: 'test' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {}, adminToken: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /name required/);
});

test('agent-roles: POST with name > 64 chars returns 422', async () => {
  const routes = register({
    fleetDb: {},
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  const postRoute = routes.find(r => r.method === 'POST' && /agent-roles\$$/.test(r.pattern.source));
  const longName = 'x'.repeat(65);
  const req = fakeReq({ body: { name: longName, prompt: 'test' } });
  const res = fakeRes();
  res.req = req;

  await postRoute.handler(req, res, { db: {}, adminToken: null });
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /name/);
});
