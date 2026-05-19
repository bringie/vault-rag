'use strict';
// Covers: recycle-bin REST (list deleted items, restore, hard-delete N/A) +
// UI panel rendering (vt-0417).
// Uses a fixture workflow created in beforeAll and soft-deleted to populate bin.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN, loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';
const TS = Date.now();
const WF_NAME = `e2e-test-recycle-${TS}`;

const MINIMAL_DEF = {
  start: 'n1',
  nodes: [{ id: 'n1', type: 'delay', seconds: 1 }],
  edges: [],
};

let fixtureId = null;

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe('Recycle bin @smoke @recycle-bin', () => {
  test.beforeAll(async () => {
    if (!ADMIN_TOKEN) return;
    const c = await client(ADMIN_TOKEN);
    try {
      // Create a workflow to soft-delete
      const r = await c.post('/api/fleet/workflows', {
        data: { name: WF_NAME, definition: MINIMAL_DEF },
      });
      if (r.ok()) {
        const w = await r.json();
        fixtureId = w.id;
        // Soft-delete it immediately
        await c.delete(`/api/fleet/workflows/${fixtureId}`).catch(() => {});
      }
    } catch (_) {}
    await c.dispose();
  });

  test.afterAll(async () => {
    // vt-0423: clean both active AND recycle-bin scopes. No HTTP
    // purge endpoint exists (purgeWorkflow is only called by the 30-day
    // reaper internally), so soft-deleted fixtures will continue to
    // accumulate until that reaper runs. The cleanup below at least
    // ensures we don't leak ACTIVE e2e-test-recycle-* between runs.
    // Documented known issue: long-running test environments will
    // accumulate ~1 soft-deleted e2e fixture per full suite run.
    if (!ADMIN_TOKEN) return;
    const c = await client(ADMIN_TOKEN);
    try {
      const list = await (await c.get('/api/fleet/workflows')).json().catch(() => []);
      for (const w of list) {
        if (w.name && w.name.startsWith('e2e-test-recycle-')) {
          await c.delete(`/api/fleet/workflows/${w.id}`).catch(() => {});
        }
      }
    } catch (_) {}
    await c.dispose();
  });

  test('rb-01: @smoke GET /api/fleet/recycle-bin returns groups + workflows shape', async () => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    const c = await client(token);
    const r = await c.get('/api/fleet/recycle-bin');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('groups');
    expect(body).toHaveProperty('workflows');
    // Both may be arrays or paged objects
    const groups = Array.isArray(body.groups) ? body.groups : (body.groups?.rows || []);
    const workflows = Array.isArray(body.workflows) ? body.workflows : (body.workflows?.rows || []);
    expect(Array.isArray(groups)).toBe(true);
    expect(Array.isArray(workflows)).toBe(true);
    await c.dispose();
  });

  test('rb-02: fixture workflow appears in recycle-bin after soft-delete', async () => {
    test.skip(!ADMIN_TOKEN || !fixtureId, 'depends on beforeAll fixture creation');
    const c = await client(ADMIN_TOKEN);
    const body = await (await c.get('/api/fleet/recycle-bin')).json();
    const workflows = Array.isArray(body.workflows) ? body.workflows : (body.workflows?.rows || []);
    const found = workflows.find(w => w.id === fixtureId);
    expect(found).toBeTruthy();
    expect(found.name).toBe(WF_NAME);
    await c.dispose();
  });

  test('rb-03: POST /api/fleet/workflows/:id/restore restores to active list', async () => {
    test.skip(!ADMIN_TOKEN || !fixtureId, 'depends on rb-02');
    const c = await client(ADMIN_TOKEN);
    const r = await c.post(`/api/fleet/workflows/${fixtureId}/restore`);
    expect(r.status()).toBe(200);
    const restored = await r.json();
    expect(restored.id).toBe(fixtureId);

    // Should appear in active list
    const list = await (await c.get('/api/fleet/workflows')).json();
    expect(list.find(w => w.id === fixtureId)).toBeTruthy();

    // Should NOT be in recycle-bin anymore
    const bin = await (await c.get('/api/fleet/recycle-bin')).json();
    const wfs = Array.isArray(bin.workflows) ? bin.workflows : (bin.workflows?.rows || []);
    expect(wfs.find(w => w.id === fixtureId)).toBeFalsy();

    // vt-0423: don't re-delete here — afterAll's active-list scan will
    // soft-delete the now-restored fixture once. Re-deleting in this test
    // body created a duplicate in-bin entry that afterAll couldn't see
    // (no HTTP purge endpoint exists), causing permanent accumulation.
    await c.dispose();
  });

  test('rb-04: UI /fleet/#/recycle-bin renders recyclebinview panel', async ({ page }) => {
    test.skip(!ADMIN_TOKEN, 'admin login required');
    await loginAs(page, 'admin');

    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    // vt-0424: deterministic wait — recycle-bin nav button appears once
    // features applied. Then navigate and wait for panel un-hide.
    await expect(page.locator('#nav-groups')).toBeVisible({ timeout: 5_000 });

    const binResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/recycle-bin') && r.ok(),
      { timeout: 10_000 }
    );
    await page.goto(`${BASE}/fleet/#/recycle-bin`);
    await binResp;
    await page.waitForFunction(
      () => { const p = document.getElementById('recyclebinview'); return p && !p.hidden; },
      null, { timeout: 5_000 }
    );

    // recyclebinview panel must be visible
    const panel = page.locator('#recyclebinview');
    const hidden = await panel.evaluate(el => el.hidden);
    expect(hidden).toBe(false);

    // Both tbody rows sections should exist
    await expect(page.locator('#recycle-groups-rows')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#recycle-workflows-rows')).toBeVisible({ timeout: 5_000 });
  });
});
