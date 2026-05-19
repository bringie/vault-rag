'use strict';
// vt-0427: regression test for the Ink-CHA permission-dialog detection
// bug. Claude Code's Ink TUI emits each word of the permission dialog
// positioned by Cursor Horizontal Absolute (CSI N G) instead of literal
// spaces. The previous strip-ansi collapsed the whole CSI sequence and
// produced "Doyouwanttoproceed?" — the marker regex never matched.
const test = require('node:test');
const assert = require('node:assert');
const { stripAnsiForMarkers } = require('../src/ws-client');

const PERM_TITLE_RE = /Do you want to proceed\??/i;
const PERM_FOOTER_RE = /Esc to cancel/i;
const PERM_ASK_AGAIN_RE = /don[’']?t ask again/iu;

test('CHA-positioned title text becomes space-separated and matches', () => {
  // Captured byte-shape from production session f156e5e1.
  const raw = '\x1b[2GDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?';
  const stripped = stripAnsiForMarkers(raw);
  assert.match(stripped, PERM_TITLE_RE,
    `stripped=${JSON.stringify(stripped)} — title regex must match`);
});

test('CHA-positioned footer text matches', () => {
  const raw = '\x1b[2GEsc\x1b[6Gto\x1b[9Gcancel';
  const stripped = stripAnsiForMarkers(raw);
  assert.match(stripped, PERM_FOOTER_RE);
});

test('U+2019 typographic apostrophe in ask-again label matches', () => {
  // Real Claude TUI uses U+2019, not ASCII '. Wrapped in CHA positioning.
  const raw = '\x1b[2GYes,\x1b[7Gand\x1b[11Gdon’t\x1b[17Gask\x1b[21Gagain';
  const stripped = stripAnsiForMarkers(raw);
  assert.match(stripped, PERM_ASK_AGAIN_RE);
});

test('color + cursor-move + line-clear codes are stripped without harming markers', () => {
  // SGR colors + CUP cursor moves + EL erase-line interleaved with CHA words.
  const raw =
    '\x1b[2J\x1b[H' +                       // clear screen + cursor home
    '\x1b[38;5;212m\x1b[2GDo\x1b[39m' +       // colored "Do"
    '\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?\x1b[K';
  const stripped = stripAnsiForMarkers(raw);
  assert.match(stripped, PERM_TITLE_RE);
});

test('OSC window-title between markers does not fragment', () => {
  // tmux/screen window title sequence between two CHA words.
  const raw = '\x1b[2GDo\x1b]2;some title\x07\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?';
  const stripped = stripAnsiForMarkers(raw);
  assert.match(stripped, PERM_TITLE_RE);
});

test('without CHA→space conversion the regex would miss (negative)', () => {
  // Sanity check: the OLD strip (no CHA→space rule) collapses "Do" + "you"
  // into "Doyou". Confirm the test sample IS this hard case.
  const raw = '\x1b[2GDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?';
  const oldStrip = raw.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
  assert.doesNotMatch(oldStrip, PERM_TITLE_RE,
    'old strip path SHOULD fail — this is the vt-0427 regression we are guarding against');
});
