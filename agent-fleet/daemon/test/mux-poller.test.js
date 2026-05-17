'use strict';
// vt-0336: unit tests for mux-poller's parse functions. The pollOnce
// + startPoller paths require a real tmux process and are covered by
// daemon integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseListSessionsOutput, parseEnvOutput } = require('../src/mux-poller');

test('parseListSessionsOutput: empty input', () => {
  assert.deepEqual(parseListSessionsOutput(''), []);
  assert.deepEqual(parseListSessionsOutput('\n'), []);
});

test('parseListSessionsOutput: single row', () => {
  const input = 'claude-foo-1700000000-1234|1700000000|1700000050|1|2';
  const rows = parseListSessionsOutput(input);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'claude-foo-1700000000-1234');
  assert.equal(rows[0].attached_clients, 1);
  assert.equal(rows[0].windows, 2);
  assert.equal(rows[0].created_at, new Date(1700000000 * 1000).toISOString());
  assert.equal(rows[0].last_activity, new Date(1700000050 * 1000).toISOString());
});

test('parseListSessionsOutput: multiple rows', () => {
  const input = 'a|100|150|0|1\nb|200|250|2|3';
  const rows = parseListSessionsOutput(input);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'a');
  assert.equal(rows[1].name, 'b');
  assert.equal(rows[1].attached_clients, 2);
});

test('parseEnvOutput: filters FLEET_* keys', () => {
  const input = 'FLEET_AGENT=claude\nFLEET_CWD=/home/u/work\nPATH=/usr/bin\nOTHER=x';
  const env = parseEnvOutput(input);
  assert.equal(env.FLEET_AGENT, 'claude');
  assert.equal(env.FLEET_CWD, '/home/u/work');
  assert.equal(env.PATH, undefined);
  assert.equal(env.OTHER, undefined);
});

test('parseEnvOutput: handles values containing = signs', () => {
  const input = 'FLEET_CWD=/path/with=equals/in/it';
  const env = parseEnvOutput(input);
  assert.equal(env.FLEET_CWD, '/path/with=equals/in/it');
});

test('parseEnvOutput: empty input → empty object', () => {
  assert.deepEqual(parseEnvOutput(''), {});
  assert.deepEqual(parseEnvOutput(null), {});
});

test('parseListSessionsOutput: bad timestamp → still produces row, dates Invalid', () => {
  const input = 'name|abc|def|0|1';
  const rows = parseListSessionsOutput(input);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'name');
  // NaN → "Invalid Date" via Date.toISOString throws; handle in caller.
  // The hub-side upsertTmuxSessions wraps in try/catch, so this is non-fatal.
});
