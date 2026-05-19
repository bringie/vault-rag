'use strict';
// Covers: workflow CRUD REST + UI list rendering (vt-0414).
// All fixture data prefixed with e2e-test- and cleaned in afterAll.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN, loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';
const TS = Date.now();
const WF_NAME = `e2e-test-workflow-${TS}`;

// Minimal valid definition: single delay node
const MINIMAL_DEF = {
  start: 'n1',
  nodes: [{ id: 'n1', type: 'delay', seconds: 1 }],
  edges: [],
};

let createdId = null;

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe('Workflows CRUD @smoke @workflows', () => {
  test.afterAll(async () => {
    // Hard-delete any leftover e2e-test-* workflows via DELETE
    if (!ADMIN_TOKEN) return;
    const c = await client(ADMIN_TOKEN);
    try {
      const list = await (await c.get('/api/fleet/workflows')).json();
      for (const w of list) {
        if (w.name && w.name.startsWith('e2e-test-')) {
          await c.delete(`/api/fleet/workflows/${w.id}`).catch(() => {});
        }
      }
      // Also check deleted list
      const bin = await (await c.get('/api/fleet/recycle-bin')).json().catch(() => ({ workflows: [] }));
      for (const w of bin.workflows || []) {
        if (w.name && w.name.startsWith('e2e-test-')) {
          // No hard-delete endpoint on recycle-bin; soft-delete already done — leave in bin
        }
      }
    } catch (_) {}
    await c.dispose();
  });

  test('wf-01: @smoke POST /api/fleet/workflows creates fixture workflow', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required for workflow create');
    const c = await client(ADMIN_TOKEN);
    const r = await c.post('/api/fleet/workflows', {
      data: { name: WF_NAME, definition: MINIMAL_DEF },
    });
    expect(r.status()).toBe(201);
    const w = await r.json();
    expect(w.id).toBeTruthy();
    expect(w.name).toBe(WF_NAME);
    createdId = w.id;
    await c.dispose();
  });

  test('wf-02: GET /api/fleet/workflows includes new workflow', async () => {
    test.skip(!ADMIN_TOKEN || !createdId, 'depends on wf-01');
    const c = await client(ADMIN_TOKEN);
    const list = await (await c.get('/api/fleet/workflows')).json();
    const found = list.find(w => w.id === createdId);
    expect(found).toBeTruthy();
    expect(found.name).toBe(WF_NAME);
    await c.dispose();
  });

  test('wf-03: PATCH /api/fleet/workflows/:id renames + updates definition', async () => {
    test.skip(!ADMIN_TOKEN || !createdId, 'depends on wf-01');
    const c = await client(ADMIN_TOKEN);
    const patchedName = WF_NAME + '-renamed';
    const updatedDef = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'delay', seconds: 2, label: 'e2e patched' }],
      edges: [],
    };
    const r = await c.patch(`/api/fleet/workflows/${createdId}`, {
      data: { name: patchedName, definition: updatedDef },
    });
    expect(r.status()).toBe(200);
    const w = await r.json();
    expect(w.name).toBe(patchedName);
    await c.dispose();
  });

  test('wf-04: DELETE /api/fleet/workflows/:id soft-deletes workflow', async () => {
    test.skip(!ADMIN_TOKEN || !createdId, 'depends on wf-01');
    const c = await client(ADMIN_TOKEN);
    const r = await c.delete(`/api/fleet/workflows/${createdId}`);
    expect(r.status()).toBe(204);

    // Workflow should no longer appear in active list
    const list = await (await c.get('/api/fleet/workflows')).json();
    expect(list.find(w => w.id === createdId)).toBeFalsy();
    await c.dispose();
  });

  test('wf-05: deleted workflow appears in recycle-bin', async () => {
    test.skip(!ADMIN_TOKEN || !createdId, 'depends on wf-04');
    const c = await client(ADMIN_TOKEN);
    const bin = await (await c.get('/api/fleet/recycle-bin')).json();
    const workflows = Array.isArray(bin?.workflows) ? bin.workflows
                    : (bin?.workflows?.rows || []);
    // The renamed workflow should appear in the bin
    const found = workflows.find(w => w.id === createdId);
    expect(found).toBeTruthy();
    await c.dispose();
  });

  test('wf-06: UI /fleet/#/workflows renders workflow list panel', async ({ page }) => {
    test.skip(!ADMIN_TOKEN, 'admin login required');
    await loginAs(page, 'admin');
    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    await page.waitForTimeout(200);

    // Register BEFORE hash navigation to avoid the race where the app
    // fetches /api/fleet/workflows synchronously on route change.
    const wfRespP = page.waitForResponse(
      r => r.url().includes('/fleet/workflows') && r.ok(),
      { timeout: 10_000 }
    );
    await page.goto(`${BASE}/fleet/#/workflows`);
    await wfRespP;
    await page.waitForTimeout(300);

    // workflowsview panel should be visible (not hidden)
    const panel = page.locator('#workflowsview');
    const hidden = await panel.evaluate(el => el.hidden);
    expect(hidden).toBe(false);

    // wf-list-body should contain something (table or empty message)
    const body = page.locator('#wf-list-body');
    await expect(body).toBeVisible({ timeout: 5_000 });
  });
});
