'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PtyManager } = require('../src/pty-manager');

const FAKE_CLAUDE = path.resolve(__dirname, '../../..', 'tests/fleet/fake-claude.sh');

test('spawn captures stdout and reports exit', async () => {
  const m = new PtyManager({ claudeBin: FAKE_CLAUDE });
  const events = [];
  m.on('data', (e) => events.push({ k: 'data', ...e }));
  m.on('exit', (e) => events.push({ k: 'exit', ...e }));
  m.spawn({ sessionId: 's1', cwd: '/tmp', args: ['--print', 'hello'] });
  await new Promise((resolve) => m.once('exit', resolve));
  const outBuf = Buffer.concat(events.filter(e => e.k === 'data' && e.sessionId === 's1').map(e => e.data));
  assert.ok(outBuf.toString().includes('hello'), `got: ${outBuf.toString()}`);
  const exit = events.find(e => e.k === 'exit');
  assert.equal(exit.exitCode, 0);
});

test('writeInput passes to stdin', async () => {
  const m = new PtyManager({ claudeBin: FAKE_CLAUDE });
  const dataEvents = [];
  m.on('data', (e) => dataEvents.push(e));
  m.spawn({ sessionId: 's2', cwd: '/tmp', args: [] });
  await new Promise(r => setTimeout(r, 100));
  m.writeInput('s2', 'hello\n');
  m.writeInput('s2', 'quit\n');
  await new Promise(r => setTimeout(r, 300));
  const out = Buffer.concat(dataEvents.map(e => e.data)).toString();
  assert.ok(out.includes('echo: hello'), `got: ${out}`);
});

test('kill SIGTERM then SIGKILL after grace', async () => {
  const m = new PtyManager({ claudeBin: FAKE_CLAUDE, killGraceMs: 100 });
  m.spawn({ sessionId: 's3', cwd: '/tmp', args: ['--hang'] });
  await new Promise(r => setTimeout(r, 100));
  m.kill('s3');
  const exit = await new Promise(r => m.once('exit', r));
  assert.equal(exit.sessionId, 's3');
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL' || exit.exitCode !== 0,
    `expected term/kill signal or non-zero exit, got: ${JSON.stringify(exit)}`);
});
