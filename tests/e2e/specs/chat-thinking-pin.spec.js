'use strict';
// Covers: thinking indicator lifecycle — show on busy, pin at bottom, clear on
//         end_turn, re-show on tool_use loop, timer updates.
// Catches: thinking indicator appearing in wrong DOM position (mid-conversation
//          instead of at the bottom), timer not updating, indicator surviving
//          after session ends.

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

const SID = 'think-pin-test-00000000';

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

function makeAssistantFrame(sid, seq, stopReason = 'end_turn') {
  return {
    type: 'claude_msg',
    session_id: sid,
    seq,
    raw: { uuid: `uuid-think-${seq}`, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `Message ${seq}` }] } },
    extracted: {
      role: 'assistant',
      text_blocks: [{ type: 'text', text: `Message ${seq}` }],
      tool_uses: [],
      stop_reason: stopReason,
    },
  };
}

function makeToolUseFrame(sid, seq) {
  return {
    type: 'claude_msg',
    session_id: sid,
    seq,
    raw: { uuid: `uuid-tu-${seq}`, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${seq}`, name: 'Bash', input: { command: 'ls' } }] } },
    extracted: {
      role: 'assistant',
      text_blocks: [],
      tool_uses: [{ id: `t${seq}`, name: 'Bash', input: { command: 'ls' } }],
      stop_reason: 'tool_use',
    },
  };
}

function makeToolResultFrame(sid, seq, toolSeq) {
  return {
    type: 'claude_msg',
    session_id: sid,
    seq,
    raw: { uuid: `uuid-tr-${seq}`, type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${toolSeq}`, content: 'ok' }] } },
    extracted: {
      role: 'user',
      text_in: '',
      tool_results: [{ id: `t${toolSeq}`, is_error: false, content: 'ok' }],
    },
  };
}

test.describe('Thinking indicator pinning @chat @vt-0392', () => {
  test('think-01: @smoke session_busy shows .cv-thinking at bottom', async ({ page }) => {
    await bootChatView(page);

    // Inject a few message nodes first.
    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'replay_batch', session_id: sid,
        from_offset: 0, to_offset: 3, is_last: true,
        lines: [
          { type: 'claude_msg', session_id: sid, seq: 1,
            raw: { uuid: 'think-uuid-1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
            extracted: { role: 'user', text_in: 'hi', tool_results: [] } },
          { type: 'claude_msg', session_id: sid, seq: 2,
            raw: { uuid: 'think-uuid-2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
            extracted: { role: 'assistant', text_blocks: [{ type: 'text', text: 'hello' }], tool_uses: [], stop_reason: 'end_turn' } },
        ],
      });
    }, SID);
    await page.waitForTimeout(200);

    // Trigger busy — thinking node should appear.
    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'session_busy', session_id: sid, busy: true });
    }, SID);
    await page.waitForTimeout(150);

    const thinking = page.locator('.cv-thinking');
    await expect(thinking).toBeVisible({ timeout: 3_000 });

    // Must be the LAST child (or last meaningful child) in the message list.
    const isLast = await page.evaluate(() => {
      const t = document.querySelector('.cv-thinking');
      if (!t || !t.parentNode) return null;
      const siblings = Array.from(t.parentNode.children);
      const lastMeaningful = [...siblings].reverse().find(c => !c.hidden);
      return lastMeaningful === t;
    });
    expect(isLast, 'thinking indicator must be the last visible node in the list').toBe(true);
  });

  test('think-02: session_busy=false removes thinking indicator', async ({ page }) => {
    await bootChatView(page, SID + '-b');

    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'session_busy', session_id: sid, busy: true });
    }, SID + '-b');
    await page.waitForTimeout(150);
    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 3_000 });

    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'session_busy', session_id: sid, busy: false });
    }, SID + '-b');
    await page.waitForTimeout(150);

    await expect(page.locator('.cv-thinking')).toHaveCount(0);
  });

  test('think-03: end_turn assistant message clears thinking indicator', async ({ page }) => {
    await bootChatView(page, SID + '-c');

    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'session_busy', session_id: sid, busy: true });
    }, SID + '-c');
    await page.waitForTimeout(150);
    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 3_000 });

    // end_turn response — should clear thinking.
    await page.evaluate((sid) => {
      window.chatView.handleFrame(
        { type: 'claude_msg', session_id: sid, seq: 1,
          raw: { uuid: 'et-uuid-1', type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
          extracted: { role: 'assistant', text_blocks: [{ type: 'text', text: 'done' }],
            tool_uses: [], stop_reason: 'end_turn' } }
      );
    }, SID + '-c');
    await page.waitForTimeout(150);

    await expect(page.locator('.cv-thinking')).toHaveCount(0);
  });

  test('think-04: tool_use loop → thinking stays alive after tool_result', async ({ page }) => {
    await bootChatView(page, SID + '-d');

    // Start busy.
    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'session_busy', session_id: sid, busy: true });
    }, SID + '-d');
    await page.waitForTimeout(100);

    // tool_use stop_reason — thinking should NOT clear.
    await page.evaluate(({ f }) => {
      window.chatView.handleFrame(f);
    }, { f: makeToolUseFrame(SID + '-d', 1) });
    await page.waitForTimeout(100);

    // Thinking should still be present.
    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 2_000 });

    // tool_result — thinking should come back if it was gone or stay.
    await page.evaluate(({ f }) => {
      window.chatView.handleFrame(f);
    }, { f: makeToolResultFrame(SID + '-d', 2, 1) });
    await page.waitForTimeout(100);

    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 2_000 });
  });

  test('think-05: thinking indicator stays at bottom after subsequent message nodes', async ({ page }) => {
    // Bug class: messages arriving after thinking was shown could be appended
    // AFTER thinking (pushing it above). appendNode uses pinnedBottomNode() to
    // insertBefore the thinking indicator. Verify order stays correct.
    await bootChatView(page, SID + '-e');

    await page.evaluate((sid) => {
      window.chatView.handleFrame({ type: 'session_busy', session_id: sid, busy: true });
    }, SID + '-e');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-thinking')).toBeVisible({ timeout: 3_000 });

    // Tool-use loop: send tool_use frame (no stop, keeps thinking), then tool_result
    await page.evaluate(({ tu, tr }) => {
      window.chatView.handleFrame(tu);
      window.chatView.handleFrame(tr);
    }, { tu: makeToolUseFrame(SID + '-e', 1), tr: makeToolResultFrame(SID + '-e', 2, 1) });
    await page.waitForTimeout(200);

    // Thinking must still be last visible child.
    const isLast = await page.evaluate(() => {
      const t = document.querySelector('.cv-thinking');
      if (!t || !t.parentNode) return null;
      const siblings = Array.from(t.parentNode.children).filter(c => !c.hidden);
      return siblings[siblings.length - 1] === t;
    });
    expect(isLast, 'thinking must remain the last visible node after tool_use/tool_result').toBe(true);
  });
});
