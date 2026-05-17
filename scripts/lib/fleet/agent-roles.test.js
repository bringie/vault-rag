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

test('agent-roles: register() returns 13 routes (5 agent + 4 group + 4 host roles)', () => {
  const routes = register({
    fleetDb: {},
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  assert.strictEqual(routes.length, 13);
  assert.strictEqual(routes[0].method, 'GET');
  assert.match(routes[0].pattern.source, /agent-roles/);
  assert.strictEqual(routes[1].method, 'POST');
});

// vt-0370 (epic vt-0369): per-host role assignment routes.
test('agent-roles: POST /fleet/hosts/:id/roles empty body returns 422', async () => {
  const routes = register({
    fleetDb: {
      getAgentRole: async () => ({ id: 'r', prompt: 'p' }),
      getHost: async () => ({ id: 'h' }),
      listHostRoles: async () => [],
      assignRoleToHost: async () => {},
    },
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  const hostPost = routes.find(r => r.method === 'POST' && /hosts.*roles\$$/.test(r.pattern.source));
  assert.ok(hostPost, 'host-role POST route registered');
  const req = fakeReq({ body: null, url: '/fleet/hosts/abc/roles' });
  const res = fakeRes(); res.req = req;
  await hostPost.handler(req, res, { db: {} }, ['/fleet/hosts/abc/roles', 'abc']);
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /body required/);
});

test('agent-roles: POST /fleet/hosts/:id/roles missing role_id returns 422', async () => {
  const routes = register({
    fleetDb: {
      getAgentRole: async () => ({ id: 'r', prompt: 'p' }),
      getHost: async () => ({ id: 'h' }),
      listHostRoles: async () => [],
      assignRoleToHost: async () => {},
    },
    checkAdminAuth: () => true,
    validateAllowedToolsField: () => {},
  });
  const hostPost = routes.find(r => r.method === 'POST' && /hosts.*roles\$$/.test(r.pattern.source));
  const req = fakeReq({ body: {}, url: '/fleet/hosts/abc/roles' });
  const res = fakeRes(); res.req = req;
  await hostPost.handler(req, res, { db: {} }, ['/fleet/hosts/abc/roles', 'abc']);
  assert.strictEqual(res.statusCode, 422);
  assert.match(res.body.error, /role_id required/);
});

test('agent-roles: GET /fleet/hosts/:id/roles/effective is viewer-readable (admin:false)', () => {
  const routes = register({
    fleetDb: { resolveEffectiveRoles: async () => [] },
    checkAdminAuth: () => false,
    validateAllowedToolsField: () => {},
  });
  const effective = routes.find(r => r.method === 'GET' && /effective\$$/.test(r.pattern.source));
  assert.ok(effective, 'effective-roles GET route registered');
  assert.strictEqual(effective.admin, false);
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
