'use strict';
// vt-0397: DOM virtualization — mounted node cap + scroll-up load-older.
//
// Tests:
// 1. After a large replay (>500 msgs), STATE._mountedMsgNodes.length ≤ 500.
// 2. Scroll to top → .cv-load-older-btn appears (unmounted nodes exist).
// 3. Click "load older" → 200 nodes prepend, scroll position preserved (jump < 30px).
// 4. Repeat 3 times — vt-0399 bug: mounted count grows past 500 on each load.
//    This test documents the expected behavior (eviction) AND flags the regression.
//
// Strategy: inject >600 synthetic claude_msg frames in a single replay_batch.
// All frames become cv-msg nodes eligible for virtualization.

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';
const SID = 'virt-verify-00000000-vt0397';
const MAX_MOUNTED = 500;
const LOAD_OLDER_BATCH = 200;
// Generate N synthetic assistant text frames.
function makeSyntheticFrames(sid, count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      type: 'claude_msg',
      session_id: sid,
      seq: i + 1,
      raw: {
        uuid: `uuid-virt-${i}`,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Message ${i + 1}: ${'x'.repeat(40)}` }],
        },
      },
      extracted: {
        role: 'assistant',
        text_blocks: [{ type: 'text', text: `Message ${i + 1}: ${'x'.repeat(40)}` }],
        tool_uses: [],
      },
    });
  }
  return frames;
}

async function waitForChatView(page) {
  await page.waitForFunction(() =>
    typeof window.chatView === 'object' &&
    window.chatView !== null &&
    typeof window.chatView.handleFrame === 'function',
    { timeout: 15_000 }
  );
}

// Detect whether the deployed chat-view has vt-0397 DOM virtualization.
// The feature is identified by the presence of the cv-load-older-btn element
// AFTER mounting (it's created during mount() in vt-0397 code).
// In older builds (vt-0392) the scroller has only the cv-list child.
async function detectVirtualization(page) {
  return page.evaluate(() => {
    const chatEl = document.querySelector('#chat-view');
    if (!chatEl) return false;
    // cv-load-older-btn is created in mount() for vt-0397 builds.
    return !!(chatEl.querySelector('.cv-load-older-btn'));
  });
}

async function injectFrames(page, sid, frames) {
  await page.evaluate(({ sid, frames }) => {
    window.chatView.detach();
    const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
    window.chatView.attach(sid, fakeWs);
    // Deliver all frames as a single replay_batch (triggers flushEvictionAfterReplay).
    window.chatView.handleFrame({
      type: 'replay_batch',
      session_id: sid,
      from_offset: 0,
      to_offset: frames.length,
      is_last: true,
      lines: frames,
    });
  }, { sid, frames });
  // Allow the batch processing + eviction flush to complete.
  await page.waitForTimeout(500);
}

test.describe('DOM virtualization @chat @vt-0397', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
    await waitForChatView(page);
    const hasFeature = await detectVirtualization(page);
    test.skip(!hasFeature, 'DOM virtualization (vt-0397) not yet deployed to this environment');
  });

  test('virt-01: replay of 600+ frames caps mounted count at 500', async ({ page }) => {
    const FRAME_COUNT = 620;
    const frames = makeSyntheticFrames(SID + '-a', FRAME_COUNT);
    await injectFrames(page, SID + '-a', frames);

    const mountedCount = await page.evaluate(() => {
      // Access STATE via the module IIFE — it's private. We can count DOM nodes instead.
      // .cv-msg elements currently in the DOM approximates mountedMsgNodes length.
      return document.querySelectorAll('#chat-view .cv-msg').length;
    });

    expect(mountedCount, `mounted count should be ≤ ${MAX_MOUNTED}`).toBeLessThanOrEqual(MAX_MOUNTED);
  });

  test('virt-02: scroll to top makes .cv-load-older-btn visible (unmounted nodes present)', async ({ page }) => {
    const FRAME_COUNT = 620;
    const frames = makeSyntheticFrames(SID + '-b', FRAME_COUNT);
    await injectFrames(page, SID + '-b', frames);

    // The load-older button should be visible when there are unmounted nodes.
    // It's hidden by CSS display:none when no unmounted nodes exist.
    const btn = page.locator('.cv-load-older-btn');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    // Verify its text mentions the batch size.
    const btnText = (await btn.textContent()) || '';
    expect(btnText).toMatch(/older|load/i);
  });

  test('virt-03: clicking load-older prepends nodes, scroll position preserved (< 30px jump)', async ({ page }) => {
    const FRAME_COUNT = 620;
    const frames = makeSyntheticFrames(SID + '-c', FRAME_COUNT);
    await injectFrames(page, SID + '-c', frames);

    // Find the chat scroller element (parent of .chat-list / STATE.list).
    // Scroll to top to expose the load-older button.
    const chatContainer = page.locator('#chat-view .cv-scroller, #chat-view .cv-frame, #chat-view').first();

    // Capture DOM count before load.
    const countBefore = await page.evaluate(() =>
      document.querySelectorAll('#chat-view .cv-msg').length
    );

    // Measure scroll anchor position before load.
    // We use the first visible .cv-msg top as anchor.
    const anchorBefore = await page.evaluate(() => {
      const msgs = document.querySelectorAll('#chat-view .cv-msg');
      if (!msgs.length) return 0;
      return msgs[0].getBoundingClientRect().top;
    });

    // Click the load-older button.
    const btn = page.locator('.cv-load-older-btn');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await btn.click();
    await page.waitForTimeout(300);

    // After load: more nodes should be in DOM.
    const countAfter = await page.evaluate(() =>
      document.querySelectorAll('#chat-view .cv-msg').length
    );
    expect(countAfter, 'load-older should increase mounted count').toBeGreaterThan(countBefore);
    expect(countAfter - countBefore, 'prepended ~200 nodes').toBeLessThanOrEqual(LOAD_OLDER_BATCH + 5);

    // Scroll position should be preserved — the anchor element shouldn't
    // jump more than 30px (vt-0397 CRIT fix: scrollBehavior=auto prevents
    // smooth-scroll interference during the scrollTop delta adjustment).
    const anchorAfter = await page.evaluate(() => {
      // Re-query — the old first msg is no longer the first (200 were prepended).
      // Instead, check the node that was first before the load (now at index 200).
      const msgs = document.querySelectorAll('#chat-view .cv-msg');
      if (msgs.length <= 200) return 0;
      return msgs[200].getBoundingClientRect().top;
    });
    const jump = Math.abs(anchorAfter - anchorBefore);
    expect(jump, `viewport jump should be < 30px, got ${jump.toFixed(1)}px`).toBeLessThan(30);
  });

  test('virt-04: vt-0399 load-older eviction — mounted count must not grow past 500 after 3 loads', async ({ page }) => {
    // vt-0399: known potential bug — loadOlderBatch() prepends nodes but does NOT
    // evict from the tail, so _mountedMsgNodes can exceed MAX_MOUNTED=500 after
    // repeated load-older clicks. This test documents the expected behavior
    // (total stays ≤ 500) and flags any regression.
    //
    // If this test FAILS, it confirms vt-0399 is still open.
    // If this test PASSES, eviction is working as expected.

    const FRAME_COUNT = 1200; // enough for 3+ load cycles
    const frames = makeSyntheticFrames(SID + '-d', FRAME_COUNT);
    await injectFrames(page, SID + '-d', frames);

    const btn = page.locator('.cv-load-older-btn');

    for (let round = 0; round < 3; round++) {
      const btnVisible = await btn.isVisible().catch(() => false);
      if (!btnVisible) break; // no more unmounted nodes

      await btn.click();
      await page.waitForTimeout(300);

      const mountedCount = await page.evaluate(() =>
        document.querySelectorAll('#chat-view .cv-msg').length
      );

      // This assertion captures the vt-0399 question.
      // If loadOlderBatch evicts from the tail, count stays ≤ 500.
      // If it doesn't, count will grow by ~200 each round.
      expect(
        mountedCount,
        `After load #${round + 1}: mounted count (${mountedCount}) should stay ≤ ${MAX_MOUNTED} (vt-0399)`
      ).toBeLessThanOrEqual(MAX_MOUNTED);
    }
  });

  test('virt-05: replay eviction is batched — single flush after replay completes', async ({ page }) => {
    // vt-0397: evictExcess() is skipped during replay (replayInFlight=true),
    // and called once via flushEvictionAfterReplay() when the batch is fully drained.
    // Verify: after replaying 600 frames, the mounted count is ≤ 500.
    // (This is the same as virt-01 but explicitly verifies the batch-eviction path
    // rather than incremental eviction, distinguishing the two code paths.)
    const FRAME_COUNT = 600;
    const frames = makeSyntheticFrames(SID + '-e', FRAME_COUNT);

    // Inject as a single is_last=true batch to trigger flushEvictionAfterReplay.
    await page.evaluate(({ sid, frames }) => {
      window.chatView.detach();
      const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
      window.chatView.attach(sid, fakeWs);
      window.chatView.handleFrame({
        type: 'replay_batch',
        session_id: sid,
        from_offset: 0,
        to_offset: frames.length,
        is_last: true,
        lines: frames,
      });
    }, { sid: SID + '-e', frames });

    await page.waitForTimeout(400);

    const mountedCount = await page.evaluate(() =>
      document.querySelectorAll('#chat-view .cv-msg').length
    );

    expect(mountedCount, `batch-evict path: mounted count (${mountedCount}) ≤ ${MAX_MOUNTED}`).toBeLessThanOrEqual(MAX_MOUNTED);
  });
});
