const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claim, markDone, markDeadletter, release, lookup, recoverStaleProcessing } =
  require('../lib/classifier-state');

function fakePg() {
  const rows = new Map();
  const queries = [];
  return {
    rows,
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const op = sql.replace(/\s+/g, ' ').trim();

      if (op.startsWith('SELECT * FROM inbox_classifier_state WHERE path=')) {
        const r = rows.get(params[0]);
        return { rows: r ? [r] : [] };
      }
      if (op.startsWith('INSERT INTO inbox_classifier_state')) {
        const [path, sha] = params;
        const row = { path, sha, status: 'pending', attempts: 0, last_error: null,
                      classified_at: null, started_at: null, target_folder: null,
                      confidence: null };
        rows.set(path, row);
        return { rows: [row] };
      }
      if (op.startsWith("UPDATE inbox_classifier_state SET status='pending'") &&
          op.includes("status='processing'")) {
        return { rows: [], rowCount: 0 };
      }
      if (op.startsWith('UPDATE inbox_classifier_state SET status=')) {
        const path = params[params.length - 1];
        const row = rows.get(path) || {};
        rows.set(path, row);
        return { rowCount: row ? 1 : 0 };
      }
      throw new Error(`unhandled query: ${op}`);
    },
  };
}

test('claim: inserts row when path is new', async () => {
  const pg = fakePg();
  await claim(pg, '00-inbox/foo.md', 'sha1');
  assert.equal(pg.rows.get('00-inbox/foo.md').status, 'pending');
  assert.ok(pg.queries.some(q => q.sql.startsWith('INSERT INTO inbox_classifier_state')));
});

test('lookup: returns null when no row', async () => {
  const pg = fakePg();
  const r = await lookup(pg, '00-inbox/missing.md');
  assert.equal(r, null);
});

test('lookup: returns existing row', async () => {
  const pg = fakePg();
  pg.rows.set('00-inbox/foo.md', { path: '00-inbox/foo.md', sha: 's', status: 'done' });
  const r = await lookup(pg, '00-inbox/foo.md');
  assert.equal(r.status, 'done');
});

test('markDone: emits UPDATE with status=done', async () => {
  const pg = fakePg();
  pg.rows.set('p', { path: 'p', sha: 's', status: 'processing' });
  await markDone(pg, 'p', { target_folder: '01-knowledge', confidence: 0.9 });
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /SET status='done'/);
  assert.deepEqual(last.params.slice(0, 3), ['01-knowledge', 0.9, 'p']);
});

test('markDeadletter: sets status=deadletter and last_error', async () => {
  const pg = fakePg();
  pg.rows.set('p', { path: 'p', sha: 's', status: 'processing', attempts: 2 });
  await markDeadletter(pg, 'p', { last_error: 'low_conf:0.4', attempts: 3 });
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /SET status='deadletter'/);
  assert.deepEqual(last.params.slice(0, 3), ['low_conf:0.4', 3, 'p']);
});

test('release: returns row to pending and bumps attempts', async () => {
  const pg = fakePg();
  await release(pg, 'p', { last_error: 'parse_error', attempts: 1 });
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /SET status='pending'/);
  assert.deepEqual(last.params.slice(0, 3), ['parse_error', 1, 'p']);
});

test('recoverStaleProcessing: emits UPDATE with status filter', async () => {
  const pg = fakePg();
  await recoverStaleProcessing(pg);
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /UPDATE inbox_classifier_state SET status='pending'/);
  assert.match(last.sql, /status='processing'/);
  assert.match(last.sql, /interval '5 min'/);
});
