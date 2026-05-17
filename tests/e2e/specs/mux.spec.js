'use strict';
// vt-0337: REST coverage for /api/fleet/hosts/:id/tmux-sessions.
// Phase 3 ships GET (viewer-readable, cwd basename) + POST attach
// (admin-gated, 410 on dead session). Phase 4 will wire the real
// daemon side; for now POST attach succeeds when the daemon is
// connected and a row exists.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function firstHostId() {
  const c = await client(VIEWER_TOKEN);
  const r = await c.get('/api/fleet/hosts');
  const rows = await r.json();
  await c.dispose();
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

test.describe('Mux REST surface @smoke @mux', () => {
  test('mux-01: GET tmux-sessions viewer → 200 array', async () => {
    const id = await firstHostId();
    test.skip(!id, 'no hosts registered');
    const c = await client(VIEWER_TOKEN);
    const r = await c.get(`/api/fleet/hosts/${id}/tmux-sessions`);
    expect(r.status()).toBe(200);
    const rows = await r.json();
    expect(Array.isArray(rows)).toBe(true);
    await c.dispose();
  });

  test('mux-02: viewer sees cwd basename only, admin sees full path', async () => {
    const id = await firstHostId();
    test.skip(!id, 'no hosts registered');
    test.skip(!ADMIN_TOKEN, 'admin token required for comparison');
    const v = await client(VIEWER_TOKEN);
    const a = await client(ADMIN_TOKEN);
    const vRows = await (await v.get(`/api/fleet/hosts/${id}/tmux-sessions`)).json();
    const aRows = await (await a.get(`/api/fleet/hosts/${id}/tmux-sessions`)).json();
    await v.dispose(); await a.dispose();
    // If there are rows with non-null cwd, viewer's must NOT contain '/'
    // (basename only). Empty rowset → vacuous pass; skip.
    const withCwd = aRows.filter(r => r.cwd && r.cwd !== '/');
    if (!withCwd.length) test.skip(true, 'no rows with cwd to compare');
    for (const ar of withCwd) {
      const vr = vRows.find(x => x.name === ar.name);
      expect(vr).toBeDefined();
      if (ar.cwd && ar.cwd.includes('/')) {
        expect(vr.cwd).not.toContain('/');  // basename only for viewer
      }
    }
  });

  test('mux-03: GET unknown host → empty array (not 404 — viewer can probe)', async () => {
    const c = await client(VIEWER_TOKEN);
    // Use an obviously well-formed UUID that won't match any real host.
    const r = await c.get('/api/fleet/hosts/00000000-0000-0000-0000-000000000000/tmux-sessions');
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual([]);
    await c.dispose();
  });

  test('mux-04: POST attach viewer → 403 (admin-gated by outer isAdminPath)', async () => {
    test.skip(!ADMIN_TOKEN, 'two-token mode required for 403 gating');
    const id = await firstHostId();
    test.skip(!id, 'no hosts registered');
    const c = await client(VIEWER_TOKEN);
    const r = await c.post(`/api/fleet/hosts/${id}/tmux-sessions/never-exists/attach`, { data: {} });
    expect(r.status()).toBe(403);
    await c.dispose();
  });

  test('mux-05: POST attach admin + missing session → 410 Gone', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required');
    const id = await firstHostId();
    test.skip(!id, 'no hosts registered');
    const c = await client(ADMIN_TOKEN);
    const r = await c.post(`/api/fleet/hosts/${id}/tmux-sessions/never-exists/attach`, { data: {} });
    expect(r.status()).toBe(410);
    await c.dispose();
  });
});
