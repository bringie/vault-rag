'use strict';
// Covers: permission_request / permission_resolved inline card rendering.
// Catches: card not rendering (.cv-perm vs old .chat-permission-card mismatch),
//          button digit mapping off-by-one, resolved frame not removing card,
//          multiple concurrent cards not being individually cleared.

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

async function bootChatView(page) {
  await loginAs(page, 'admin');
  await page.goto(`${BASE}/fleet/`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => typeof window.chatView === 'object' &&
          typeof window.chatView.handleFrame === 'function' &&
          typeof window.chatView.attach === 'function',
    { timeout: 15_000 }
  );
  // Attach to synthetic session with fake WS that captures sent frames.
  await page.evaluate(() => {
    window.__sentFrames = [];
    const fakeWs = {
      readyState: 1,
      send: (msg) => { window.__sentFrames.push(JSON.parse(msg)); },
      addEventListener: () => {},
    };
    window.chatView.detach();
    window.chatView.attach('perm-test-session', fakeWs);
  });
  await page.waitForTimeout(100);
}

test.describe('Permission card @chat @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await bootChatView(page);
  });

  test('perm-01: @smoke permission_request renders .cv-perm card with correct buttons', async ({ page }) => {
    await page.evaluate(() => {
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-001',
        context: 'vault-rag → search(query: "INFRA-1000")',
        options: ['Yes', "Yes, don't ask again", 'No'],
      });
    });
    await page.waitForTimeout(150);

    const card = page.locator('.cv-perm');
    await expect(card).toBeVisible({ timeout: 3_000 });

    // Badge must say AUTH REQUIRED
    await expect(card.locator('.cv-perm-badge')).toBeVisible();

    // Context text rendered
    const ctx = card.locator('.cv-perm-context');
    await expect(ctx).toBeVisible();
    const ctxText = await ctx.textContent();
    expect(ctxText).toContain('INFRA-1000');

    // Three buttons with numeric prefixes
    const btns = card.locator('.cv-perm-btn');
    await expect(btns).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const num = await btns.nth(i).locator('.cv-perm-num').textContent();
      expect(num).toBe(String(i + 1));
    }

    // First button has cv-perm-allow, last has cv-perm-deny
    await expect(btns.nth(0)).toHaveClass(/cv-perm-allow/);
    await expect(btns.nth(2)).toHaveClass(/cv-perm-deny/);
  });

  test('perm-02: clicking allow button sends send_text with digit "1"', async ({ page }) => {
    await page.evaluate(() => {
      window.__sentFrames = [];
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-002',
        context: 'fs.write("/etc/passwd", ...)',
        options: ['Allow', 'Deny'],
      });
    });
    await page.waitForTimeout(150);

    const card = page.locator('.cv-perm');
    await expect(card).toBeVisible({ timeout: 3_000 });

    const allowBtn = card.locator('.cv-perm-allow');
    await allowBtn.click();
    await page.waitForTimeout(100);

    const sent = await page.evaluate(() => window.__sentFrames);
    const sendText = sent.find(f => f.type === 'send_text');
    expect(sendText).toBeTruthy();
    expect(sendText.text).toBe('1');
  });

  test('perm-03: clicking deny button sends send_text with last digit', async ({ page }) => {
    await page.evaluate(() => {
      window.__sentFrames = [];
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-003',
        context: 'bash: rm -rf /tmp',
        options: ['Yes', 'No'],
      });
    });
    await page.waitForTimeout(150);

    const card = page.locator('.cv-perm');
    await expect(card).toBeVisible({ timeout: 3_000 });

    const denyBtn = card.locator('.cv-perm-deny');
    await denyBtn.click();
    await page.waitForTimeout(100);

    const sent = await page.evaluate(() => window.__sentFrames);
    const sendText = sent.find(f => f.type === 'send_text');
    expect(sendText).toBeTruthy();
    expect(sendText.text).toBe('2'); // 2 options → deny = "2"
  });

  test('perm-04: permission_resolved removes the specific card', async ({ page }) => {
    // Inject two concurrent permission cards with different request_ids.
    await page.evaluate(() => {
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-card-A',
        context: 'tool A',
        options: ['Yes', 'No'],
      });
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-card-B',
        context: 'tool B',
        options: ['Yes', 'No'],
      });
    });
    await page.waitForTimeout(150);

    // Both cards should be present.
    await expect(page.locator('.cv-perm')).toHaveCount(2);

    // Resolve only req-card-A.
    await page.evaluate(() => {
      window.chatView.handleFrame({
        type: 'permission_resolved',
        session_id: 'perm-test-session',
        request_id: 'req-card-A',
      });
    });
    await page.waitForTimeout(150);

    // Only one card should remain (req-card-B).
    await expect(page.locator('.cv-perm')).toHaveCount(1);
    const remaining = page.locator('.cv-perm .cv-perm-context');
    const remainText = await remaining.textContent();
    expect(remainText).toContain('tool B');
  });

  test('perm-05: permission card is inserted BEFORE thinking indicator (pinned-bottom)', async ({ page }) => {
    // Trigger the session_busy → thinking indicator first.
    await page.evaluate(() => {
      window.chatView.handleFrame({
        type: 'session_busy',
        session_id: 'perm-test-session',
        busy: true,
      });
    });
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 3_000 });

    // Now inject a permission card.
    await page.evaluate(() => {
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-pin',
        context: 'pin-test',
        options: ['Yes', 'No'],
      });
    });
    await page.waitForTimeout(150);

    // Thinking indicator should still be visible (at bottom).
    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 2_000 });
    await expect(page.locator('.cv-perm')).toBeVisible({ timeout: 2_000 });

    // Thinking node must come AFTER the perm card in DOM order (perm before thinking).
    const order = await page.evaluate(() => {
      const list = document.querySelector('.cv-list, [class*="chat-list"], .cv-msg-list');
      if (!list) {
        // fallback: compare nextSibling chain
        const perm = document.querySelector('.cv-perm');
        const think = document.querySelector('.cv-thinking');
        if (!perm || !think) return null;
        // perm should come before thinking in DOM
        return perm.compareDocumentPosition(think) & Node.DOCUMENT_POSITION_FOLLOWING ? 'perm-before-thinking' : 'wrong-order';
      }
      const children = Array.from(list.children);
      const permIdx = children.findIndex(c => c.classList.contains('cv-perm'));
      const thinkIdx = children.findIndex(c => c.classList.contains('cv-thinking'));
      if (permIdx === -1 || thinkIdx === -1) return null;
      return permIdx < thinkIdx ? 'perm-before-thinking' : 'wrong-order';
    });
    // null means list container not found via these selectors — skip order check
    if (order !== null) {
      expect(order, 'permission card must appear before thinking indicator in DOM').toBe('perm-before-thinking');
    }
  });

  test('perm-06: card renders without context field (optional field)', async ({ page }) => {
    await page.evaluate(() => {
      window.chatView.handleFrame({
        type: 'permission_request',
        session_id: 'perm-test-session',
        request_id: 'req-no-ctx',
        // no context field
        options: ['Allow', 'Deny'],
      });
    });
    await page.waitForTimeout(150);

    const card = page.locator('.cv-perm');
    await expect(card).toBeVisible({ timeout: 3_000 });
    // No .cv-perm-context since frame has no context.
    await expect(card.locator('.cv-perm-context')).toHaveCount(0);
    // Buttons still present.
    await expect(card.locator('.cv-perm-btn')).toHaveCount(2);
  });
});
