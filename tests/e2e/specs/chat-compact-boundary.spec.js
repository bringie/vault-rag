'use strict';
// Covers: compact_boundary frame rendering (↻ divider with token stats).
// Catches: compact_boundary not rendering a .cv-compact element,
//          metadata fields (trigger, preTokens, postTokens) not displayed,
//          compact node wrongly entering virtualization (should be
//          virtualized like other conv nodes, but NOT managed as
//          thinking/perm/empty).

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';
const SID = 'compact-test-00000000';

async function bootChatView(page, sid = SID) {
  await loginAs(page, 'admin');
  await page.goto(`${BASE}/fleet/`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => typeof window.chatView === 'object' &&
          typeof window.chatView.handleFrame === 'function',
    { timeout: 15_000 }
  );
  await page.evaluate((s) => {
    const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
    window.chatView.detach();
    window.chatView.attach(s, fakeWs);
  }, sid);
  await page.waitForTimeout(100);
}

test.describe('Compact boundary rendering @chat @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await bootChatView(page);
  });

  test('compact-01: @smoke compact_boundary renders .cv-compact divider', async ({ page }) => {
    await page.evaluate((sid) => {
      window.chatView.handleFrame({
        type: 'compact_boundary',
        session_id: sid,
        metadata: { trigger: 'auto', preTokens: 8500, postTokens: 1200, durationMs: 340 },
      });
    }, SID);
    await page.waitForTimeout(150);

    const compact = page.locator('.cv-compact');
    await expect(compact).toBeVisible({ timeout: 3_000 });
  });

  test('compact-02: compact divider shows token stats and trigger', async ({ page }) => {
    await page.evaluate((sid) => {
      window.chatView.handleFrame({
        type: 'compact_boundary',
        session_id: sid,
        metadata: { trigger: 'manual', preTokens: 12000, postTokens: 800 },
      });
    }, SID);
    await page.waitForTimeout(150);

    const compact = page.locator('.cv-compact');
    await expect(compact).toBeVisible({ timeout: 3_000 });

    const labelText = await compact.locator('.cv-compact-label').textContent();
    expect(labelText).toContain('manual');
    expect(labelText).toContain('12000');
    expect(labelText).toContain('800');
    expect(labelText).toContain('↻');
  });

  test('compact-03: compact_boundary with missing metadata uses fallback labels', async ({ page }) => {
    await page.evaluate((sid) => {
      window.chatView.handleFrame({
        type: 'compact_boundary',
        session_id: sid,
        // no metadata at all
      });
    }, SID);
    await page.waitForTimeout(150);

    const compact = page.locator('.cv-compact');
    await expect(compact).toBeVisible({ timeout: 3_000 });

    // Should still render — metadata is optional (uses '?' fallbacks).
    const labelText = await compact.locator('.cv-compact-label').textContent();
    expect(labelText).toContain('auto'); // trigger fallback
    expect(labelText).toContain('?');    // preTokens/postTokens fallback
  });

  test('compact-04: compact node appears between conversation messages', async ({ page }) => {
    // Inject pre-compact messages, then compact boundary, then post-compact message.
    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'replay_batch', session_id: sid,
        from_offset: 0, to_offset: 3, is_last: true,
        lines: [
          // pre-compact user msg
          { type: 'claude_msg', session_id: sid, seq: 1,
            raw: { uuid: 'cmp-u1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
            extracted: { role: 'user', text_in: 'hello', tool_results: [] } },
          // compact_boundary frame embedded in replay_batch
          { type: 'compact_boundary', session_id: sid,
            metadata: { trigger: 'auto', preTokens: 5000, postTokens: 500 } },
          // post-compact assistant msg
          { type: 'claude_msg', session_id: sid, seq: 3,
            raw: { uuid: 'cmp-a1', type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } },
            extracted: { role: 'assistant', text_blocks: [{ type: 'text', text: 'world' }],
              tool_uses: [], stop_reason: 'end_turn' } },
        ],
      });
    }, SID);
    await page.waitForTimeout(300);

    // All three nodes should be visible.
    await expect(page.locator('.cv-msg')).toHaveCount(2); // user + assistant
    await expect(page.locator('.cv-compact')).toHaveCount(1);

    // Compact should sit between the two messages in DOM order.
    const order = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll('.cv-msg, .cv-compact'));
      return msgs.map(m => m.classList.contains('cv-compact') ? 'compact' : 'msg');
    });
    expect(order).toEqual(['msg', 'compact', 'msg']);
  });

  test('compact-05: multiple compact boundaries accumulate when given distinct seq values', async ({ page }) => {
    // compact_boundary frames go through renderFrame() which uses
    // dedupKey = frame.raw?.uuid || 'seq:' + frame.seq.
    // Frames with distinct seq values won't collide in seenUuids.
    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'compact_boundary', session_id: sid,
        seq: 100, metadata: { trigger: 'auto', preTokens: 1000, postTokens: 100 } });
      window.chatView.handleFrame({ type: 'compact_boundary', session_id: sid,
        seq: 200, metadata: { trigger: 'manual', preTokens: 2000, postTokens: 200 } });
    }, SID);
    await page.waitForTimeout(200);

    // Both compact dividers should be present — distinct seq → distinct dedupKeys.
    const count = await page.locator('.cv-compact').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
