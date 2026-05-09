const { test } = require('node:test');
const assert = require('node:assert');
const { isReady, readyTasks } = require('../scripts/lib/vt-graph');

const t = (id, status, blocked_by = []) => ({ fm: { id, status, blocked_by, priority: 2 } });

test('isReady: open with no blockers', () => {
  assert.strictEqual(isReady(t('vt-1', 'open'), new Map()), true);
});

test('isReady: in_progress excluded', () => {
  assert.strictEqual(isReady(t('vt-1', 'in_progress'), new Map()), false);
});

test('isReady: blocked by active task', () => {
  const blocker = t('vt-2', 'open');
  const map = new Map([['vt-2', blocker]]);
  assert.strictEqual(isReady(t('vt-1', 'open', ['vt-2']), map), false);
});

test('isReady: blocker closed -> ready', () => {
  const blocker = t('vt-2', 'closed');
  const map = new Map([['vt-2', blocker]]);
  assert.strictEqual(isReady(t('vt-1', 'open', ['vt-2']), map), true);
});

test('readyTasks sorts by priority asc', () => {
  const tasks = [
    { fm: { id: 'a', status: 'open', priority: 3, blocked_by: [] } },
    { fm: { id: 'b', status: 'open', priority: 0, blocked_by: [] } },
  ];
  const r = readyTasks(tasks).map(x => x.fm.id);
  assert.deepStrictEqual(r, ['b', 'a']);
});
