'use strict';
// vt-0376: dense API coverage for the Pixel-Office surface.
// Covers per-host roles (vt-0370) + dispatch resolution + redaction
// regression caught by the architect+security review.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN, loginAs } = require('../fixtures/auth');

// Browser-side tests need auth; API-only tests use VIEWER/ADMIN tokens directly.
test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin');
});

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// Shared setup: grab a host id + a role id to test against.
async function fixtures(token) {
  const c = await client(token);
  const hosts = await (await c.get('/api/fleet/hosts')).json();
  const roles = await (await c.get('/api/fleet/agent-roles')).json();
  await c.dispose();
  return { host: hosts[0] || null, role: roles[0] || null };
}

test.describe('Per-host roles API @hostroles', () => {
  test('hostroles-01: empty list viewer → 200 []', async () => {
    const { host } = await fixtures(VIEWER_TOKEN || ADMIN_TOKEN);
    test.skip(!host, 'no hosts');
    const c = await client(VIEWER_TOKEN || ADMIN_TOKEN);
    const r = await c.get(`/api/fleet/hosts/${host.id}/roles`);
    expect(r.status()).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
    await c.dispose();
  });

  test('hostroles-02: POST viewer → 403 admin-gated', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required to seed cleanup');
    const { host, role } = await fixtures(ADMIN_TOKEN);
    test.skip(!host || !role, 'no host/role available');
    const c = await client(VIEWER_TOKEN);
    const r = await c.post(`/api/fleet/hosts/${host.id}/roles`, {
      data: { role_id: role.id },
    });
    expect(r.status()).toBe(403);
    await c.dispose();
  });

  test('hostroles-03: empty body → 422', async () => {
    test.skip(!ADMIN_TOKEN, 'admin required');
    const { host } = await fixtures(ADMIN_TOKEN);
    const c = await client(ADMIN_TOKEN);
    const r = await c.post(`/api/fleet/hosts/${host.id}/roles`, { data: '' });
    expect(r.status()).toBe(422);
    const j = await r.json();
    expect(j.error).toMatch(/body required|role_id required/);
    await c.dispose();
  });

  test('hostroles-04: missing role_id → 422', async () => {
    test.skip(!ADMIN_TOKEN, 'admin required');
    const { host } = await fixtures(ADMIN_TOKEN);
    const c = await client(ADMIN_TOKEN);
    const r = await c.post(`/api/fleet/hosts/${host.id}/roles`, { data: {} });
    expect(r.status()).toBe(422);
    expect((await r.json()).error).toMatch(/role_id required/);
    await c.dispose();
  });

  test('hostroles-05: unknown role_id → 404', async () => {
    test.skip(!ADMIN_TOKEN, 'admin required');
    const { host } = await fixtures(ADMIN_TOKEN);
    const c = await client(ADMIN_TOKEN);
    const r = await c.post(`/api/fleet/hosts/${host.id}/roles`, {
      data: { role_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status()).toBe(404);
    await c.dispose();
  });

  test('hostroles-06: full assign + redaction + delete cycle', async () => {
    test.skip(!ADMIN_TOKEN || !VIEWER_TOKEN, 'two-token mode required');
    const { host, role } = await fixtures(ADMIN_TOKEN);
    test.skip(!host || !role, 'no fixtures');
    const admin = await client(ADMIN_TOKEN);
    const viewer = await client(VIEWER_TOKEN);
    try {
      // Cleanup before assert — prior test runs may have left it assigned.
      await admin.delete(`/api/fleet/hosts/${host.id}/roles/${role.id}`);

      // Admin assigns.
      const post = await admin.post(`/api/fleet/hosts/${host.id}/roles`, {
        data: { role_id: role.id },
      });
      expect(post.status()).toBe(201);

      // Viewer reads — prompt MUST be redacted to prompt_bytes + prompt_sha.
      const viewerList = await (await viewer.get(`/api/fleet/hosts/${host.id}/roles`)).json();
      expect(Array.isArray(viewerList)).toBe(true);
      const v = viewerList.find(r => r.id === role.id);
      expect(v).toBeTruthy();
      expect(v.prompt).toBeUndefined();
      expect(typeof v.prompt_bytes).toBe('number');
      expect(v.prompt_sha).toMatch(/^[0-9a-f]{64}$/);

      // Admin reads — prompt MUST be present.
      const adminList = await (await admin.get(`/api/fleet/hosts/${host.id}/roles`)).json();
      const a = adminList.find(r => r.id === role.id);
      expect(typeof a.prompt).toBe('string');
      expect(a.prompt.length).toBeGreaterThan(0);

      // /effective endpoint should also redact for viewer.
      const eff = await (await viewer.get(`/api/fleet/hosts/${host.id}/roles/effective`)).json();
      if (eff.length) {
        for (const r of eff) {
          expect(r.prompt).toBeUndefined();
          expect(r.prompt_sha).toMatch(/^[0-9a-f]{64}$/);
        }
      }

      // Admin /effective sees prompts.
      const effAdmin = await (await admin.get(`/api/fleet/hosts/${host.id}/roles/effective`)).json();
      if (effAdmin.length) {
        // At least one entry has a non-empty prompt (sentinel for redaction NOT firing).
        expect(effAdmin.some(r => typeof r.prompt === 'string' && r.prompt.length > 0)).toBe(true);
      }

      // Cleanup.
      const del = await admin.delete(`/api/fleet/hosts/${host.id}/roles/${role.id}`);
      expect(del.status()).toBe(204);
    } finally {
      // Defensive cleanup in case any expect threw mid-flight.
      await admin.delete(`/api/fleet/hosts/${host.id}/roles/${role.id}`).catch(() => {});
      await admin.dispose();
      await viewer.dispose();
    }
  });

  test('hostroles-07: 8-role cap enforced', async () => {
    test.skip(!ADMIN_TOKEN, 'admin required');
    const { host } = await fixtures(ADMIN_TOKEN);
    const c = await client(ADMIN_TOKEN);
    const allRoles = await (await c.get('/api/fleet/agent-roles')).json();
    test.skip(allRoles.length < 9, 'need 9+ roles to test cap (have ' + allRoles.length + ')');
    try {
      for (const r of allRoles.slice(0, 8)) {
        await c.post(`/api/fleet/hosts/${host.id}/roles`, { data: { role_id: r.id } });
      }
      // Ninth should 422 with "max" in error.
      const r = await c.post(`/api/fleet/hosts/${host.id}/roles`, {
        data: { role_id: allRoles[8].id },
      });
      expect(r.status()).toBe(422);
      expect((await r.json()).error).toMatch(/max|exceed/);
    } finally {
      for (const r of allRoles.slice(0, 9)) {
        await c.delete(`/api/fleet/hosts/${host.id}/roles/${r.id}`).catch(() => {});
      }
      await c.dispose();
    }
  });
});

test.describe('Pixel-Office SPA @office', () => {
  test('office-02: canvas + status line populate after open', async ({ page }) => {
    await page.goto('/fleet/#/pixel-office');
    const view = page.locator('#pixelofficeview');
    if (!(await view.count())) test.skip(true, 'pixel-office DOM not present');
    await expect(view).toBeVisible({ timeout: 10_000 });
    // Status line populates after the first refreshState resolves.
    await expect.poll(
      async () => (await page.locator('#pixel-office-status').textContent()) || '',
      { timeout: 8000 }
    ).toMatch(/\d+ hosts/);
  });

  test('office-03: nav button lives in top header', async ({ page }) => {
    await page.goto('/fleet/');
    const btn = page.locator('#nav-pixel-office');
    await expect(btn).toBeVisible({ timeout: 10_000 });
    // Find the parent .controls (top header) — the button should be there,
    // not in the .footbar-settings cluster.
    const inHeader = await btn.evaluate(el => !!el.closest('.controls'));
    expect(inHeader).toBe(true);
  });
});
