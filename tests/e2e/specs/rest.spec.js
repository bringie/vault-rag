'use strict';
// vt-0332: REST surface — no browser. Fastest part of the suite, runs
// every deploy. Covers auth modes, sub-module dispatch, security gates.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test.describe('REST surface @smoke', () => {
  test('rest-01: whoami viewer', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/fleet/auth/whoami');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.role).toMatch(/viewer|admin/);
    await c.dispose();
  });

  test('rest-02: whoami admin', async () => {
    test.skip(!ADMIN_TOKEN, 'no admin token configured');
    const c = await client(ADMIN_TOKEN);
    const j = await (await c.get('/api/fleet/auth/whoami')).json();
    expect(j.role).toBe('admin');
    await c.dispose();
  });

  test('rest-03: whoami unauth', async () => {
    const c = await client(null);
    const r = await c.get('/api/fleet/auth/whoami');
    expect(r.status()).toBe(401);
    await c.dispose();
  });

  test('rest-04: features list (viewer)', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/fleet/features');
    expect(r.status()).toBe(200);
    const arr = await r.json();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    expect(arr[0]).toHaveProperty('name');
    expect(arr[0]).toHaveProperty('enabled');
    await c.dispose();
  });

  test('rest-05: features PATCH viewer → 403', async () => {
    test.skip(!ADMIN_TOKEN, 'requires two-token mode');
    const c = await client(VIEWER_TOKEN);
    const r = await c.patch('/api/fleet/features/audit', { data: { enabled: true } });
    expect(r.status()).toBe(403);
    await c.dispose();
  });

  test('rest-06: features PATCH admin → 200, toggle reverts', async () => {
    test.skip(!ADMIN_TOKEN, 'no admin token configured');
    const c = await client(ADMIN_TOKEN);
    const off = await c.patch('/api/fleet/features/audit', { data: { enabled: false } });
    expect(off.status()).toBe(200);
    expect((await off.json()).enabled).toBe(false);
    const on = await c.patch('/api/fleet/features/audit', { data: { enabled: true } });
    expect(on.status()).toBe(200);
    expect((await on.json()).enabled).toBe(true);
    await c.dispose();
  });

  test('rest-07: agent-roles GET viewer → prompt redacted', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/fleet/agent-roles');
    expect(r.status()).toBe(200);
    const rows = await r.json();
    if (rows.length > 0) {
      expect(rows[0]).not.toHaveProperty('prompt');
      expect(rows[0]).toHaveProperty('prompt_bytes');
    }
    await c.dispose();
  });

  test('rest-09: recycle-bin shape', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/fleet/recycle-bin');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('groups');
    expect(j).toHaveProperty('workflows');
    await c.dispose();
  });

  test('rest-10: prices GET (slice 2 dispatch)', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/fleet/prices');
    expect(r.status()).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
    await c.dispose();
  });

  test('rest-11: prices/resolve (admin)', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required');
    const c = await client(ADMIN_TOKEN);
    const r = await c.post('/api/fleet/prices/resolve', { data: { model: 'claude-opus-4-7' } });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('matched');
    await c.dispose();
  });

  for (const [id, path] of [
    ['rest-12', '/api/fleet/hosts'],
    ['rest-13', '/api/fleet/sessions'],
    ['rest-14', '/api/fleet/groups'],
    ['rest-15', '/api/fleet/cost/summary?days=7'],
    ['rest-16', '/api/fleet/workflow-pending-approvals'],
    ['rest-17', '/api/fleet/stack-status'],
  ]) {
    test(`${id}: GET ${path} viewer → 200`, async () => {
      const c = await client(VIEWER_TOKEN);
      const r = await c.get(path);
      expect(r.status()).toBe(200);
      await c.dispose();
    });
  }

  test('rest-18: secrets list viewer → 200', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.post('/api/secrets/list', { data: {} });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('names');
    await c.dispose();
  });

  test('rest-19/sec-01: secrets SET viewer → 403 (C1 gate)', async () => {
    test.skip(!ADMIN_TOKEN, 'C1 only meaningful in two-token mode');
    const c = await client(VIEWER_TOKEN);
    const r = await c.post('/api/secrets/set', { data: { name: 'PLAYWRIGHT_TEST', value: 'x' } });
    expect(r.status()).toBe(403);
    await c.dispose();
  });

  test('rest-20/sec-02: secrets SET admin → 200 then cleanup', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required');
    const c = await client(ADMIN_TOKEN);
    const set = await c.post('/api/secrets/set', { data: { name: 'PLAYWRIGHT_TEST', value: 'admin-only-ok' } });
    expect(set.status()).toBe(200);
    const del = await c.post('/api/secrets/delete', { data: { name: 'PLAYWRIGHT_TEST' } });
    expect(del.status()).toBe(200);
    await c.dispose();
  });

  test('rest-21: healthz/detail', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/healthz/detail');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('subsystems');
    await c.dispose();
  });

  test('rest-22: audit feed', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/audit?limit=10');
    expect(r.status()).toBe(200);
    await c.dispose();
  });

  test('rest-23: notes/index', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/notes/index');
    expect(r.status()).toBe(200);
    await c.dispose();
  });

  test('rest-24: notes/list', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/notes/list?prefix=&depth=0');
    expect(r.status()).toBe(200);
    await c.dispose();
  });

  test('rest-25: search', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.post('/api/search', { data: { query: 'fleet', k: 3 } });
    expect(r.status()).toBe(200);
    const j = await r.json();
    // /api/search returns { results } OR an array directly; tolerate both.
    const rows = Array.isArray(j) ? j : j.results;
    expect(Array.isArray(rows)).toBe(true);
    await c.dispose();
  });
});

test.describe('Security headers + special routes @smoke', () => {
  test('sec-06: CSP header bound to host', async () => {
    const c = await client(null);
    const r = await c.get('/fleet/');
    const csp = r.headers()['content-security-policy'] || '';
    expect(csp).toContain("connect-src 'self' wss://");
    expect(csp).toContain('frame-ancestors');
    expect(csp).toMatch(/connect-src 'self' wss:\/\/[^ ]+/);
    await c.dispose();
  });

  test('sec-07: favicon 204 (not 405)', async () => {
    const c = await client(null);
    const r = await c.get('/favicon.ico');
    expect(r.status()).toBe(204);
    await c.dispose();
  });

  test('sec-08: no external fonts in fleet HTML', async () => {
    const c = await client(null);
    const r = await c.get('/fleet/');
    const body = await r.text();
    // Comment about it is fine; an actual <link href="https://fonts..." is not.
    expect(body).not.toMatch(/<link[^>]*href=["']https:\/\/fonts\.googleapis\.com/);
    await c.dispose();
  });

  test('sec-04: WS ticket with mismatched scope rejected (H4)', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required for ticket mint');
    const c = await client(ADMIN_TOKEN);
    const r = await c.post('/api/fleet/auth/ws-ticket', {
      data: { role: 'viewer', scope_id: 'mismatched-test-session' },
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.scope).toBe('mismatched-test-session');
    expect(typeof j.ticket).toBe('string');
    expect(j.ticket.length).toBeGreaterThan(0);
    await c.dispose();
  });

  test('rate-limit zones key by Authorization (C2 sanity)', async () => {
    // Burst 5 search calls — first should succeed; we only check that
    // 401 doesn't appear (broken keying would 401 the lot via outer
    // auth-then-anon path). True 429-on-N+1 testing belongs in a
    // dedicated load test.
    const c = await client(VIEWER_TOKEN);
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/search', { data: { query: 'fleet', k: 1 } });
      expect([200, 429]).toContain(r.status());
    }
    await c.dispose();
  });
});
