'use strict';
// Covers: agent-roles CRUD via REST + UI list/modal flow (vt-0416).
// Fixtures prefixed e2e-test-role- and cleaned in afterAll.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN, loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';
const TS = Date.now();
const ROLE_NAME = `e2e-test-role-${TS}`;
const ROLE_PROMPT = 'You are an E2E test agent role. Purpose: automated testing only.';

let createdRoleId = null;

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe('Agent roles CRUD @smoke @agent-roles', () => {
  test.afterAll(async () => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    if (!token) return;
    const c = await client(token);
    try {
      const list = await (await c.get('/api/fleet/agent-roles')).json();
      for (const r of list) {
        if (r.name && r.name.startsWith('e2e-test-role-')) {
          await c.delete(`/api/fleet/agent-roles/${r.id}`).catch(() => {});
        }
      }
    } catch (_) {}
    await c.dispose();
  });

  test('ar-01: @smoke POST /api/fleet/agent-roles creates test role', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required for role create');
    const c = await client(ADMIN_TOKEN);
    const r = await c.post('/api/fleet/agent-roles', {
      data: {
        name: ROLE_NAME,
        prompt: ROLE_PROMPT,
        description: 'E2E test role',
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe(ROLE_NAME);
    createdRoleId = body.id;
    await c.dispose();
  });

  test('ar-02: GET /api/fleet/agent-roles includes new role', async () => {
    test.skip(!ADMIN_TOKEN || !createdRoleId, 'depends on ar-01');
    const c = await client(ADMIN_TOKEN);
    const list = await (await c.get('/api/fleet/agent-roles')).json();
    const found = list.find(r => r.id === createdRoleId);
    expect(found).toBeTruthy();
    expect(found.name).toBe(ROLE_NAME);
    await c.dispose();
  });

  test('ar-03: PATCH /api/fleet/agent-roles/:id updates prompt', async () => {
    test.skip(!ADMIN_TOKEN || !createdRoleId, 'depends on ar-01');
    const c = await client(ADMIN_TOKEN);
    const newPrompt = ROLE_PROMPT + ' [updated by PATCH]';
    const r = await c.patch(`/api/fleet/agent-roles/${createdRoleId}`, {
      data: { prompt: newPrompt },
    });
    expect(r.status()).toBe(200);
    const updated = await r.json();
    expect(updated.prompt).toBe(newPrompt);
    await c.dispose();
  });

  test('ar-04: DELETE /api/fleet/agent-roles/:id removes role', async () => {
    test.skip(!ADMIN_TOKEN || !createdRoleId, 'depends on ar-01');
    const c = await client(ADMIN_TOKEN);
    const r = await c.delete(`/api/fleet/agent-roles/${createdRoleId}`);
    expect(r.status()).toBe(204);

    // Verify gone from list
    const list = await (await c.get('/api/fleet/agent-roles')).json();
    expect(list.find(r => r.id === createdRoleId)).toBeFalsy();
    await c.dispose();
  });

  test('ar-05: UI /fleet/#/agent-roles renders agentrolesview panel', async ({ page }) => {
    test.skip(!ADMIN_TOKEN, 'admin login required');
    await loginAs(page, 'admin');

    // Check agent_roles feature
    const c = await client(ADMIN_TOKEN);
    const features = await (await c.get('/api/fleet/features')).json();
    await c.dispose();
    const arFeature = features.find(f => f.name === 'agent_roles');
    if (arFeature && !arFeature.enabled) {
      test.skip(true, 'agent_roles feature is disabled — skipping UI test');
      return;
    }

    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    // vt-0424: wait deterministically for the nav button to appear once
    // features applied, instead of an arbitrary 200ms sleep.
    await expect(page.locator('#nav-dashboard')).toBeVisible({ timeout: 5_000 });

    // Register BEFORE hash navigation — the app fetches agent-roles synchronously
    // on route change and the response can arrive before a post-goto registration.
    const rolesRespP = page.waitForResponse(
      r => r.url().includes('/fleet/agent-roles') && r.ok(),
      { timeout: 10_000 }
    );
    await page.goto(`${BASE}/fleet/#/agent-roles`);
    await rolesRespP;
    // vt-0424: panel un-hide wait, deterministic.
    await page.waitForFunction(
      () => { const p = document.getElementById('agentrolesview'); return p && !p.hidden; },
      null, { timeout: 5_000 }
    );

    // agentrolesview panel should be visible
    const panel = page.locator('#agentrolesview');
    const hidden = await panel.evaluate(el => el.hidden);
    expect(hidden).toBe(false);

    // agent-roles-rows tbody should exist
    const tbody = page.locator('#agent-roles-rows');
    await expect(tbody).toBeVisible({ timeout: 5_000 });
  });

  test('ar-06: UI create role via modal (requires feature enabled)', async ({ page }) => {
    test.skip(!ADMIN_TOKEN, 'admin required');
    await loginAs(page, 'admin');

    const c = await client(ADMIN_TOKEN);
    const features = await (await c.get('/api/fleet/features')).json();
    await c.dispose();
    const arFeature = features.find(f => f.name === 'agent_roles');
    if (arFeature && !arFeature.enabled) {
      test.skip(true, 'agent_roles feature disabled — skip UI create test');
      return;
    }

    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;

    // Register BEFORE hash navigation to avoid race
    const rolesRespP2 = page.waitForResponse(
      r => r.url().includes('/fleet/agent-roles') && r.ok(),
      { timeout: 10_000 }
    );
    await page.goto(`${BASE}/fleet/#/agent-roles`);
    await rolesRespP2;
    // vt-0424: panel-visible wait replaces 300ms sleep.
    await page.waitForFunction(
      () => { const p = document.getElementById('agentrolesview'); return p && !p.hidden; },
      null, { timeout: 5_000 }
    );

    // Click "new" button to open modal
    const newBtn = page.locator('#ar-new');
    await expect(newBtn).toBeVisible({ timeout: 5_000 });
    await newBtn.click();

    // Modal should appear
    const modal = page.locator('#agent-role-modal');
    await expect(modal).toBeVisible({ timeout: 3_000 });

    // Fill in the form
    const uiRoleName = `e2e-test-role-ui-${TS}`;
    await page.locator('#ar-modal-name').fill(uiRoleName);
    await page.locator('#ar-modal-prompt').fill('E2E UI test prompt');

    // vt-0425: modal now has z-index:200 (above footbar's 100), so a
    // normal Playwright click() lands without dispatchEvent hack.
    const saveResp = page.waitForResponse(
      r => r.url().includes('/fleet/agent-roles') && r.request().method() === 'POST',
      { timeout: 10_000 }
    );
    await page.locator('#agent-role-modal [data-ar-save]').click();
    const saved = await saveResp;
    expect(saved.status()).toBe(201);

    // vt-0424: modal hide is observable on the element; poll for it via
    // waitForFunction with a 5s ceiling instead of a 500ms sleep.
    await page.waitForFunction(
      () => { const m = document.getElementById('agent-role-modal'); return !m || m.hidden; },
      null, { timeout: 5_000 }
    );
    const modalHidden = await modal.evaluate(el => el.hidden).catch(() => true);
    expect(modalHidden).toBe(true);

    // Cleanup: delete the UI-created role
    const respBody = await saved.json().catch(() => ({}));
    if (respBody.id) {
      const cc = await client(ADMIN_TOKEN);
      await cc.delete(`/api/fleet/agent-roles/${respBody.id}`).catch(() => {});
      await cc.dispose();
    }
  });
});
