'use strict';
// vt-0338: regression test for the claude --session-id auto-inject
// guard. When binOverride is set to a non-claude binary (e.g.
// 'tmux'), the pty-manager must NOT prepend --session-id <uuid> to
// the argv — otherwise mux_attach would run
// `tmux --session-id <uuid> attach-session -t name` and tmux would
// error out.
//
// This test stubs out `node-pty` so we don't actually spawn anything;
// we just intercept the args the manager would pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Monkey-patch require('node-pty') → stub that records spawn calls.
const realResolve = Module._resolveFilename;
const recorded = [];
Module._resolveFilename = function (request, ...rest) {
  if (request === 'node-pty') return require.resolve('node:path'); // any module that exists
  return realResolve.call(this, request, ...rest);
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-pty') {
    return {
      spawn(bin, args /*, opts*/) {
        recorded.push({ bin, args });
        return {
          pid: 999,
          onData() {}, onExit() {},
          write() {}, kill() {}, resize() {},
        };
      },
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { PtyManager } = require('../src/pty-manager');

test('binOverride=tmux skips --session-id injection', () => {
  recorded.length = 0;
  const mgr = new PtyManager({ claudeBin: 'claude' });
  const uuid = '11111111-2222-3333-4444-555555555555';
  mgr.spawn({
    sessionId: uuid,
    cwd: '/tmp',
    args: ['attach-session', '-t', 'foo'],
    env: {},
    binOverride: 'tmux',
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].bin, 'tmux');
  // CRITICAL: no --session-id flag must appear in the argv.
  assert.equal(recorded[0].args.includes('--session-id'), false,
    `expected no --session-id in argv, got: ${JSON.stringify(recorded[0].args)}`);
  // The supplied args must be present unchanged.
  assert.deepEqual(recorded[0].args, ['attach-session', '-t', 'foo']);
});

test('binOverride=null (claude default) still injects --session-id', () => {
  recorded.length = 0;
  const mgr = new PtyManager({ claudeBin: 'claude' });
  const uuid = '11111111-2222-3333-4444-555555555555';
  mgr.spawn({
    sessionId: uuid,
    cwd: '/tmp',
    args: ['-p', 'hello'],
    env: {},
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].bin, 'claude');
  // Sanity: claude path should get --session-id injected.
  const idx = recorded[0].args.indexOf('--session-id');
  assert.ok(idx >= 0, `expected --session-id in claude argv, got: ${JSON.stringify(recorded[0].args)}`);
  assert.equal(recorded[0].args[idx + 1], uuid);
});
