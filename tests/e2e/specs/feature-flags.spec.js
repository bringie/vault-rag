'use strict';
// Covers: feature-flag gating in the nav and route system (vt-0312, vt-0387).
// Catches: nav buttons showing when features are disabled, route access
//          bypassing feature gate, cost/prices wrongly gated (now always-visible
//          per vt-0387), deep-link race guard (vt-0377) not redirecting
//          gated routes to dashboard.

const { test, expect, request } = require('@playwright/test');
const { VIEWER_TOKEN, ADMIN_TOKEN, loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

function client(token) {
  return request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// ── REST surface: feature flags ────────────────────────────────────────────

test.describe('Feature flags REST @smoke @features', () => {
  test('feat-01: @smoke GET /api/fleet/features returns array with name+enabled', async () => {
    const c = await client(VIEWER_TOKEN);
    const r = await c.get('/api/fleet/features');
    expect(r.status()).toBe(200);
    const rows = await r.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.enabled).toBe('boolean');
    }
    await c.dispose();
  });

  test('feat-02: cost + prices are NOT in feature list (always-visible, vt-0387)', async () => {
    // vt-0387: tokmon + pixel_office rows deleted from DB. cost + prices
    // never had feature rows — they should remain absent.
    const c = await client(VIEWER_TOKEN);
    const rows = await (await c.get('/api/fleet/features')).json();
    const names = rows.map(r => r.name);
    // cost and prices must not be gated (no feature row means always-visible)
    expect(names).not.toContain('cost');
    expect(names).not.toContain('prices');
    // tokmon/pixel_office rows should also be gone
    expect(names).not.toContain('tokmon');
    expect(names).not.toContain('pixel_office');
    await c.dispose();
  });

  test('feat-03: known gatable features present (fleet, workflows, vault_rag, audit, agent_roles)', async () => {
    const c = await client(VIEWER_TOKEN);
    const rows = await (await c.get('/api/fleet/features')).json();
    const names = rows.map(r => r.name);
    // At least one of the known gatable features should be in the list.
    const known = ['fleet', 'workflows', 'vault_rag', 'audit', 'agent_roles'];
    const found = known.filter(n => names.includes(n));
    expect(found.length).toBeGreaterThan(0);
    await c.dispose();
  });

  test('feat-04: PATCH feature viewer → 403', async () => {
    test.skip(!ADMIN_TOKEN, 'two-token mode required');
    const c = await client(VIEWER_TOKEN);
    const r = await c.patch('/api/fleet/features/audit', { data: { enabled: true } });
    expect(r.status()).toBe(403);
    await c.dispose();
  });

  test('feat-05: PATCH feature admin → 200, reverts', async () => {
    test.skip(!ADMIN_TOKEN, 'admin token required');
    const c = await client(ADMIN_TOKEN);

    // Read current state first.
    const rows = await (await c.get('/api/fleet/features')).json();
    const auditRow = rows.find(r => r.name === 'audit');
    if (!auditRow) { test.skip(true, 'audit feature not in DB'); await c.dispose(); return; }

    const original = auditRow.enabled;

    // Toggle off.
    const off = await c.patch('/api/fleet/features/audit', { data: { enabled: !original } });
    expect(off.status()).toBe(200);

    // Revert.
    const on = await c.patch('/api/fleet/features/audit', { data: { enabled: original } });
    expect(on.status()).toBe(200);
    expect((await on.json()).enabled).toBe(original);

    await c.dispose();
  });
});

// ── UI: feature gates visible in nav ───────────────────────────────────────

test.describe('Feature flags UI gating @features', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'admin');
  });

  test('feat-06: cost nav button always visible (not feature-gated)', async ({ page }) => {
    // Register waitForResponse BEFORE navigation — the features fetch fires
    // synchronously on app boot and would race a post-goto registration.
    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    await page.waitForTimeout(200);

    const costBtn = page.locator('#nav-cost');
    await expect(costBtn).toBeVisible();
    const hidden = await costBtn.evaluate(el => el.hidden);
    expect(hidden).toBe(false);
  });

  test('feat-07: prices nav button always visible (not feature-gated)', async ({ page }) => {
    // Register waitForResponse BEFORE navigation to avoid race with early features fetch.
    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    await page.waitForTimeout(200);

    const pricesBtn = page.locator('#nav-prices');
    await expect(pricesBtn).toBeVisible();
    const hidden = await pricesBtn.evaluate(el => el.hidden);
    expect(hidden).toBe(false);
  });

  test('feat-08: vault nav button visible when vault_rag feature is enabled', async ({ page }) => {
    const c = await client(VIEWER_TOKEN);
    const rows = await (await c.get('/api/fleet/features')).json();
    await c.dispose();
    const vaultRow = rows.find(r => r.name === 'vault_rag');
    if (!vaultRow || !vaultRow.enabled) {
      test.skip(true, 'vault_rag feature disabled or not present — skip positive visibility check');
      return;
    }

    // Register waitForResponse BEFORE navigation to avoid race with early features fetch.
    const featuresResp = page.waitForResponse(
      r => r.url().includes('/api/fleet/features') && r.ok(),
      { timeout: 15_000 }
    );
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    await featuresResp;
    await page.waitForTimeout(200);

    const vaultBtn = page.locator('#nav-vault');
    // If vault_rag is enabled, button must NOT be hidden.
    await expect(vaultBtn).toBeVisible();
    const hidden = await vaultBtn.evaluate(el => el.hidden);
    expect(hidden).toBe(false);
  });

  test('feat-09: disabled feature gate redirects deep-link to dashboard (vt-0377)', async ({ page }) => {
    test.skip(!ADMIN_TOKEN, 'admin token required to toggle feature');

    const c = await client(ADMIN_TOKEN);
    // Disable audit temporarily.
    const before = await (await c.get('/api/fleet/features')).json();
    const auditRow = before.find(r => r.name === 'audit');
    if (!auditRow) { await c.dispose(); test.skip(true, 'audit feature not in DB'); return; }

    await c.patch('/api/fleet/features/audit', { data: { enabled: false } });

    try {
      // Navigate directly to the gated route.
      await page.goto(`${BASE}/fleet/#/audit`);
      await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
      // Give features time to load and gate to apply.
      await page.waitForTimeout(2_000);

      // Should have been redirected to dashboard (hash changes from #/audit → #/dashboard or #/).
      const hash = await page.evaluate(() => location.hash);
      expect(hash).not.toBe('#/audit');
    } finally {
      // Restore.
      await c.patch('/api/fleet/features/audit', { data: { enabled: auditRow.enabled } });
      await c.dispose();
    }
  });
});
