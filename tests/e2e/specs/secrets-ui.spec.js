'use strict';
// Covers: secrets REST roundtrip + UI list/reveal flow (vt-0415).
// Uses prefix E2E_TEST_SECRET_<ts> for cleanup safety.
// The vault /secrets/* REST is at /api/secrets/* (POST with JSON body).

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN, loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';
const TS = Date.now();
const SECRET_NAME = `E2E_TEST_SECRET_${TS}`;
const SECRET_VALUE = `e2e-value-${TS}`;

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function secretsPost(c, action, body) {
  return c.post(`/api/secrets/${action}`, { data: body });
}

test.describe('Secrets UI roundtrip @smoke @secrets', () => {
  // vt-0423: secrets/set is ROUTE_ADMIN_ONLY when FLEET_ADMIN_TOKEN is
  // configured on the hub. Skip the whole describe if the viewer-only
  // token is all we have — the tests would 503 with confusing failures.
  test.beforeEach(() => {
    test.skip(!ADMIN_TOKEN, 'secrets/set requires FLEET_ADMIN_TOKEN');
  });

  test.afterAll(async () => {
    // Cleanup: delete any E2E_TEST_SECRET_* leftovers
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    if (!token) return;
    const c = await client(token);
    try {
      const listR = await secretsPost(c, 'list', {});
      if (listR.ok()) {
        const { names } = await listR.json();
        for (const n of (names || [])) {
          if (n.startsWith('E2E_TEST_SECRET_')) {
            await secretsPost(c, 'delete', { name: n }).catch(() => {});
          }
        }
      }
    } catch (_) {}
    await c.dispose();
  });

  test('sec-01: @smoke POST /api/secrets/set creates test secret', async () => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    const c = await client(token);
    const r = await secretsPost(c, 'set', { name: SECRET_NAME, value: SECRET_VALUE });
    // 200 = set ok, 201 also acceptable if implementation returns it
    expect([200, 201]).toContain(r.status());
    await c.dispose();
  });

  test('sec-02: POST /api/secrets/list includes new secret name', async () => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    const c = await client(token);
    const r = await secretsPost(c, 'list', {});
    expect(r.status()).toBe(200);
    const { names } = await r.json();
    expect(names).toContain(SECRET_NAME);
    await c.dispose();
  });

  test('sec-03: POST /api/secrets/get returns correct value', async () => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    const c = await client(token);
    const r = await secretsPost(c, 'get', { name: SECRET_NAME });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.value).toBe(SECRET_VALUE);
    await c.dispose();
  });

  test('sec-04: UI vault secrets tab lists the secret name (not value)', async ({ page }) => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    await loginAs(page, token === ADMIN_TOKEN ? 'admin' : 'viewer');

    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    await page.waitForTimeout(200);

    // Check vault feature is enabled
    const vaultBtn = page.locator('#nav-vault');
    const isVaultHidden = await vaultBtn.evaluate(el => el.hidden).catch(() => true);
    if (isVaultHidden) {
      test.skip(true, 'vault_rag feature disabled — skipping UI secrets test');
      return;
    }

    // Navigate to vault
    await page.goto(`${BASE}/fleet/#/vault`);
    await page.waitForTimeout(500);

    // Click the secrets tab
    const secretsTab = page.locator('#vault-tab-secrets');
    await expect(secretsTab).toBeVisible({ timeout: 5_000 });

    const listResp = page.waitForResponse(
      r => r.url().includes('/api/secrets/list') && r.ok(),
      { timeout: 10_000 }
    );
    await secretsTab.click();
    await listResp;
    await page.waitForTimeout(300);

    // The vault-tree should contain our secret name
    const tree = page.locator('#vault-tree');
    await expect(tree).toBeVisible({ timeout: 5_000 });
    const treeText = await tree.textContent();
    expect(treeText).toContain(SECRET_NAME);
  });

  test('sec-05: POST /api/secrets/delete removes secret from list', async () => {
    const token = ADMIN_TOKEN || VIEWER_TOKEN;
    const c = await client(token);
    const r = await secretsPost(c, 'delete', { name: SECRET_NAME });
    expect([200, 204]).toContain(r.status());

    // Verify gone from list
    const listR = await secretsPost(c, 'list', {});
    expect(listR.status()).toBe(200);
    const { names } = await listR.json();
    expect(names).not.toContain(SECRET_NAME);
    await c.dispose();
  });
});
