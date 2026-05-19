'use strict';
// vt-0396: code-point-aware truncation in tool-arg previews.
//
// The fix in chat-view.js (truncateCp) replaces String.prototype.slice() with
// a for-of loop that stops at code-point boundaries. Without this fix,
// a surrogate pair emoji landing on a truncation boundary (e.g. at byte offset
// 60 or 140) would be split, producing U+FFFD replacement characters in the
// rendered DOM.
//
// Strategy: inject synthetic claude_msg frames with tool_use payloads whose
// args contain emoji at the critical truncation boundary (60 chars from
// renderToolCall key:value preview, 140 chars from renderToolResult content).
// Verify U+FFFD is absent from .cv-tool-args elements.

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

const SID = 'trunc-verify-00000000-vt0396';

// Build a string of exactly N ascii chars followed by a 2-codepoint emoji.
// The emoji '💎' is U+1F48E (SMP), stored as a surrogate pair in JS strings.
// Placing it at offset 60 tests the renderToolCall preview truncation (60 cp limit).
function argWithEmojiAt(offset, emoji = '💎') {
  return 'a'.repeat(offset) + emoji + 'b'.repeat(20);
}

async function waitForChatView(page) {
  await page.waitForFunction(() =>
    typeof window.chatView === 'object' &&
    window.chatView !== null &&
    typeof window.chatView.handleFrame === 'function',
    { timeout: 15_000 }
  );
}

// Detect whether the deployed chat-view.js has the truncateCp fix (vt-0396).
// Older builds (vt-0392) use String.slice() which splits surrogate pairs →
// lone surrogate in the DOM. New builds use code-point-aware for..of iteration.
// Returns: { hasTool: bool }
async function detectTruncateCpFix(page) {
  const probeSid = 'probe-trunc-vt0396';
  // Emoji at position 59 → boundary at 60 (renderToolCall preview limit).
  const argsValue = 'a'.repeat(59) + '💎' + 'b';
  const probeFrame = {
    type: 'claude_msg', session_id: probeSid, seq: 1,
    raw: { uuid: 'uuid-probe-trunc', type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'probe_1', name: 'Read', input: { path: argsValue } }
      ]}},
    extracted: { role: 'assistant', text_blocks: [],
      tool_uses: [{ id: 'probe_1', name: 'Read', input: { path: argsValue } }] },
  };

  await page.evaluate(({ sid, f }) => {
    window.chatView.detach();
    const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
    window.chatView.attach(sid, fakeWs);
    window.chatView.handleFrame({ type: 'replay_batch', session_id: sid,
      from_offset: 0, to_offset: 1, is_last: true, lines: [f] });
  }, { sid: probeSid, f: probeFrame });
  await page.waitForTimeout(200);

  const el = await page.evaluate(() => !!document.querySelector('.cv-tool-args'));
  return { hasTool: el };
}

function buildSyntheticToolUseMsg(sid, seq, argsValue) {
  return {
    type: 'claude_msg',
    session_id: sid,
    seq,
    raw: {
      uuid: `uuid-trunc-${seq}`,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: `tool_${seq}`,
            name: 'Read',
            input: { path: argsValue },
          },
        ],
      },
    },
    extracted: {
      role: 'assistant',
      text_blocks: [],
      tool_uses: [
        {
          id: `tool_${seq}`,
          name: 'Read',
          input: { path: argsValue },
        },
      ],
    },
  };
}

function buildSyntheticToolResultMsg(sid, seq, resultContent) {
  return {
    type: 'claude_msg',
    session_id: sid,
    seq,
    raw: {
      uuid: `uuid-trunc-res-${seq}`,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `tool_${seq - 1}`,
            content: resultContent,
          },
        ],
      },
    },
    extracted: {
      role: 'user',
      text_in: '',
      tool_results: [
        {
          id: `tool_${seq - 1}`,
          is_error: false,
          content: resultContent,
        },
      ],
    },
  };
}

test.describe('Tool-arg truncation — surrogate safety @chat @vt-0396', () => {
  let truncProbe;
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
    await waitForChatView(page);
    truncProbe = await detectTruncateCpFix(page);
    // If tool rendering is completely absent, skip.
    test.skip(!truncProbe.hasTool, 'tool_use rendering not available in deployed chat-view');
  });

  test('trunc-01: emoji at renderToolCall boundary (60 cp) does NOT produce lone surrogate', async ({ page }) => {
    // Emoji at position 59 → the key:value preview truncates at 60 cp.
    // Old code: sv.slice(0, 60) splits '💎' (2 code units) → lone high surrogate.
    // New code (vt-0396): for..of stops at code-point boundary → emoji preserved or truncated cleanly.
    const argsValue = argWithEmojiAt(59); // 59 ascii + '💎' → boundary at 60
    const frame = buildSyntheticToolUseMsg(SID + '-1', 1, argsValue);

    await page.evaluate(({ sid, f }) => {
      window.chatView.detach();
      const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
      window.chatView.attach(sid, fakeWs);
      window.chatView.handleFrame({ type: 'replay_batch', session_id: sid,
        from_offset: 0, to_offset: 1, is_last: true, lines: [f] });
    }, { sid: SID + '-1', f: frame });

    await page.waitForTimeout(300);

    // Collect textContent of all .cv-tool-args elements and check for lone surrogates.
    const toolArgs = page.locator('.cv-tool-args');
    const count = await toolArgs.count();
    expect(count).toBeGreaterThanOrEqual(1);

    const texts = await page.evaluate(() => {
      function hasLoneSurrogate(str) {
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);
          if (c >= 0xD800 && c <= 0xDBFF) {
            var next = (i + 1 < str.length) ? str.charCodeAt(i + 1) : 0;
            if (next < 0xDC00 || next > 0xDFFF) return true;
          } else if (c >= 0xDC00 && c <= 0xDFFF) {
            var prev = (i > 0) ? str.charCodeAt(i - 1) : 0;
            if (prev < 0xD800 || prev > 0xDBFF) return true;
          }
        }
        return false;
      }
      return Array.from(document.querySelectorAll('.cv-tool-args'))
        .map(el => ({ text: el.textContent || '', hasLone: hasLoneSurrogate(el.textContent || '') }));
    });
    expect(texts.length, 'should have at least one .cv-tool-args').toBeGreaterThanOrEqual(1);
    for (const { text, hasLone } of texts) {
      expect(hasLone, `cv-tool-args "${text.slice(0,30)}" should not contain a lone surrogate`).toBe(false);
    }
  });

  test('trunc-02: emoji at renderToolResult boundary (140 cp) does NOT produce lone surrogate', async ({ page }) => {
    // Old code: content.slice(0, 140) splits surrogate pair → lone surrogate.
    // New code (vt-0396): truncateCp(content, 140) is code-point aware.
    const resultContent = argWithEmojiAt(139, '🔮'); // 139 ascii + '🔮' + tail
    const toolUseFrame = buildSyntheticToolUseMsg(SID + '-2', 1, 'test.txt');
    const toolResultFrame = buildSyntheticToolResultMsg(SID + '-2', 2, resultContent);

    await page.evaluate(({ sid, frames }) => {
      window.chatView.detach();
      const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
      window.chatView.attach(sid, fakeWs);
      window.chatView.handleFrame({ type: 'replay_batch', session_id: sid,
        from_offset: 0, to_offset: 2, is_last: true, lines: frames });
    }, { sid: SID + '-2', frames: [toolUseFrame, toolResultFrame] });

    await page.waitForTimeout(300);

    const texts = await page.evaluate(() => {
      function hasLoneSurrogate(str) {
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);
          if (c >= 0xD800 && c <= 0xDBFF) {
            var next = (i + 1 < str.length) ? str.charCodeAt(i + 1) : 0;
            if (next < 0xDC00 || next > 0xDFFF) return true;
          } else if (c >= 0xDC00 && c <= 0xDFFF) {
            var prev = (i > 0) ? str.charCodeAt(i - 1) : 0;
            if (prev < 0xD800 || prev > 0xDBFF) return true;
          }
        }
        return false;
      }
      return Array.from(document.querySelectorAll('.cv-tool-args'))
        .map(el => ({ text: el.textContent || '', hasLone: hasLoneSurrogate(el.textContent || '') }));
    });
    expect(texts.length, 'should have at least one .cv-tool-args').toBeGreaterThanOrEqual(1);
    for (const { text, hasLone } of texts) {
      expect(hasLone, `cv-tool-args "${text.slice(0,30)}" should not contain a lone surrogate`).toBe(false);
    }
  });

  test('trunc-03: complex emoji in JSON.stringify path does NOT produce lone surrogate', async ({ page }) => {
    // Exercises the sv=JSON.stringify(v) path in renderToolCall for non-string values.
    // JSON serialization doesn't add surrogates; the slice after serialization might.
    const argsValue = { path: 'a'.repeat(55) + '💎🔮🎯' }; // emoji-heavy JSON value
    const frame = {
      type: 'claude_msg',
      session_id: SID + '-3',
      seq: 1,
      raw: { uuid: 'uuid-trunc-3-1', type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tool_3_1', name: 'Bash', input: argsValue }] } },
      extracted: {
        role: 'assistant', text_blocks: [],
        tool_uses: [{ id: 'tool_3_1', name: 'Bash', input: argsValue }],
      },
    };

    await page.evaluate(({ sid, f }) => {
      window.chatView.detach();
      const fakeWs = { readyState: 1, send: () => {}, addEventListener: () => {} };
      window.chatView.attach(sid, fakeWs);
      window.chatView.handleFrame({ type: 'replay_batch', session_id: sid,
        from_offset: 0, to_offset: 1, is_last: true, lines: [f] });
    }, { sid: SID + '-3', f: frame });

    await page.waitForTimeout(300);

    const texts = await page.evaluate(() => {
      function hasLoneSurrogate(str) {
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);
          if (c >= 0xD800 && c <= 0xDBFF) {
            var next = (i + 1 < str.length) ? str.charCodeAt(i + 1) : 0;
            if (next < 0xDC00 || next > 0xDFFF) return true;
          } else if (c >= 0xDC00 && c <= 0xDFFF) {
            var prev = (i > 0) ? str.charCodeAt(i - 1) : 0;
            if (prev < 0xD800 || prev > 0xDBFF) return true;
          }
        }
        return false;
      }
      return Array.from(document.querySelectorAll('.cv-tool-args'))
        .map(el => ({ text: el.textContent || '', hasLone: hasLoneSurrogate(el.textContent || '') }));
    });
    expect(texts.length, 'should have at least one .cv-tool-args').toBeGreaterThanOrEqual(1);
    for (const { text, hasLone } of texts) {
      expect(hasLone, `cv-tool-args "${text.slice(0,30)}" should not contain a lone surrogate`).toBe(false);
    }
  });
});
