'use strict';
// vt-0332: navigation smoke — every nav button opens its panel without
// throwing a JS error, and the panel is actually visible on-screen (not
// just hidden=false off-viewport).

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin');
});

const NAV_ROUTES = [
  { id: 'nav-dashboard', hash: '#/dashboard', panel: null },
  { id: 'nav-vault',     hash: '#/vault',     panel: '#vaultview' },
  { id: 'nav-archive',   hash: '#/archive',   panel: '#archive' },
  { id: 'nav-cost',      hash: '#/cost',      panel: '#costview' },
  { id: 'nav-groups',    hash: '#/groups',    panel: '#groupsview' },
  { id: 'nav-workflows', hash: '#/workflows', panel: '#workflowsview' },
  { id: 'nav-prices',    hash: '#/prices',    panel: '#pricesview' },
  { id: 'nav-health',    hash: '#/health',    panel: '#healthview' },
  { id: 'nav-audit',     hash: '#/audit',     panel: '#auditview' },
  { id: 'nav-agent-roles', hash: '#/agent-roles', panel: '#agentrolesview' },
];

test.describe('Navigation smoke @smoke', () => {
  for (const { id, hash, panel } of NAV_ROUTES) {
    test(`nav-04: ${id} → panel visible, viewport-on, no console errors`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

      await page.goto('/fleet/');
      // App should auto-show given admin token pre-seeded.
      await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

      const btn = page.locator(`#${id}`);
      await expect(btn).toBeVisible();
      await btn.click();

      // Hash should change to the route.
      await expect.poll(() => new URL(page.url()).hash).toBe(hash);

      if (panel) {
        const el = page.locator(panel);
        await expect(el).toBeVisible({ timeout: 5_000 });
        // viewport-on: top-of-panel sits within the visible window.
        const box = await el.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(box.y).toBeLessThan(200);
        }
      }

      // No console errors expected. Some CSP/font noise is tolerable;
      // anything mentioning Uncaught or undefined fails.
      const fatal = errors.filter(e => /Uncaught|TypeError|ReferenceError|Cannot read/i.test(e));
      expect(fatal, fatal.join('\n')).toEqual([]);
    });
  }

  test('nav-05: back-button (#vaultview-close) returns to dashboard', async ({ page }) => {
    await page.goto('/fleet/#/vault');
    await expect(page.locator('#vaultview')).toBeVisible({ timeout: 10_000 });
    await page.locator('#vaultview-close').click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/dashboard');
    await expect(page.locator('#vaultview')).toBeHidden();
  });

  test('nav-06: direct hash route boots straight into target', async ({ page }) => {
    await page.goto('/fleet/#/agent-roles');
    await expect(page.locator('#agentrolesview')).toBeVisible({ timeout: 10_000 });
    const box = await page.locator('#agentrolesview').boundingBox();
    expect(box?.y).toBeLessThan(200);
  });
});

test.describe('Vault tab @vault', () => {
  test('vault-01: notes tree loads', async ({ page }) => {
    await page.goto('/fleet/#/vault');
    const tree = page.locator('#vault-tree');
    await expect(tree).toBeVisible({ timeout: 10_000 });
    // Either has child nodes or shows an explicit empty state — but
    // not "auth required" or an error.
    const txt = (await tree.textContent({ timeout: 5_000 })) || '';
    expect(txt).not.toMatch(/auth required|error/i);
  });

  test('vault-04: graph tab switch', async ({ page }) => {
    await page.goto('/fleet/#/vault');
    const tGraph = page.locator('#vault-tab-graph');
    if (await tGraph.count() > 0) {
      await tGraph.click();
      // Canvas may live under #vault-graph-pane.
      await expect(page.locator('#vault-graph-pane')).toBeVisible({ timeout: 5_000 });
    } else {
      test.skip(true, 'graph tab not present');
    }
  });
});

test.describe('Agent roles tab @roles', () => {
  test('roles-01: list opens', async ({ page }) => {
    await page.goto('/fleet/#/agent-roles');
    await expect(page.locator('#agentrolesview')).toBeVisible({ timeout: 10_000 });
    // Wait for the API call to settle — the route fires GET /agent-roles
    // immediately on open; we don't assert on row count because the
    // table can legitimately be empty.
    await page.waitForResponse(r => r.url().includes('/api/fleet/agent-roles') && r.ok(), { timeout: 10_000 });
  });
});

test.describe('Health tab @health', () => {
  test('health-01: subsystem grid visible', async ({ page }) => {
    await page.goto('/fleet/#/health');
    await expect(page.locator('#healthview')).toBeVisible({ timeout: 10_000 });
    await page.waitForResponse(r => r.url().includes('/api/healthz/detail') && r.ok(), { timeout: 10_000 });
  });
});

test.describe('Audit tab @audit', () => {
  test('audit-01: feed opens', async ({ page }) => {
    await page.goto('/fleet/#/audit');
    await expect(page.locator('#auditview')).toBeVisible({ timeout: 10_000 });
    await page.waitForResponse(r => r.url().includes('/api/audit') && r.ok(), { timeout: 10_000 });
  });
});

test.describe('Console hygiene @hygiene', () => {
  test('console-01: visit every nav route, no fatal console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

    await page.goto('/fleet/');
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

    for (const { hash } of NAV_ROUTES) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(400);
    }

    const fatal = errors.filter(e => /Uncaught|TypeError|ReferenceError|Cannot read/i.test(e));
    expect(fatal, fatal.join('\n')).toEqual([]);
  });
});
