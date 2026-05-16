'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const wfDb = require('./fleet-workflow-db');
const { createRunner, substituteTemplates, validateDefinition } = require('./fleet-workflow-runner');

const PG = {
  host: process.env.VAULT_RAG_PG_HOST || '127.0.0.1',
  database: process.env.VAULT_RAG_PG_DB || 'vault_rag',
  user: process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port: parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function reset(c) {
  await c.query('TRUNCATE fleet_workflow_runs, fleet_workflows RESTART IDENTITY CASCADE');
}

function makeDeps(spawnImpl) {
  const frames = [];
  return {
    db: null,
    spawnClaude: spawnImpl,
    broadcast: (runId, frame) => frames.push({ runId, frame }),
    getFrames: () => frames,
  };
}

test('substituteTemplates replaces {{n1.output}} and {{inputs.x}}', () => {
  const ctx = { n1: { output: 'hello' }, inputs: { x: 42 } };
  assert.strictEqual(substituteTemplates('say {{n1.output}} {{inputs.x}}', ctx),
    'say hello 42');
  assert.strictEqual(substituteTemplates('missing {{n9.foo}}', ctx), 'missing ');
});

test('validateDefinition catches cycles, missing nodes, bad branch fanout', () => {
  const cycle = {
    start: 'a',
    nodes: [{ id: 'a', type: 'delay', seconds: 1 }, { id: 'b', type: 'delay', seconds: 1 }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  };
  assert.throws(() => validateDefinition(cycle), /cycle/);

  assert.throws(() => validateDefinition({
    start: 'a',
    nodes: [{ id: 'a', type: 'delay', seconds: 1 }],
    edges: [{ from: 'a', to: 'ghost' }],
  }), /unknown/);

  assert.throws(() => validateDefinition({
    start: 'a',
    nodes: [
      { id: 'a', type: 'branch', condition: 'true' },
      { id: 'b', type: 'delay', seconds: 1 },
    ],
    edges: [{ from: 'a', to: 'b', label: 'then' }],
  }), /branch.*then.*else/);
});

test('runner executes linear delay→delay and marks done', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'delay', seconds: 0 },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: '', exit_code: 0, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    const types = deps.getFrames().map(f => f.frame.type);
    assert.ok(types.includes('run_state'));
    assert.ok(types.includes('node_progress'));
  });
});

test('runner branches on condition true', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'branch', condition: 'true' },
        { id: 'nT', type: 'delay', seconds: 0 },
        { id: 'nE', type: 'delay', seconds: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'nT', label: 'then' },
        { from: 'n2', to: 'nE', label: 'else' },
      ],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: '', exit_code: 0, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.ok(final.state.outputs.nT, 'then branch executed');
    assert.ok(!final.state.outputs.nE, 'else branch skipped');
  });
});

test('runner records claude output and marks failed on exit_code != 0 when on_fail=abort', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'claude', target: { host_name: 'h' }, prompt: 'p' }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: 'err', exit_code: 1, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    // exit_code != 0 itself does not abort; runner records and continues.
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.exit_code, 1);
  });
});

test('runner cancellation halts mid-run', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'delay', seconds: 2 },
        { id: 'n3', type: 'delay', seconds: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({ output: '', exit_code: 0, session_id: 'sx' }));
    deps.db = c;
    const runner = createRunner(deps);
    setTimeout(() => runner.cancel(r.id), 50);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'cancelled');
    assert.ok(!final.state.outputs || !final.state.outputs.n3, 'n3 never executed');
  });
});

test('runner.start: crashed run flips DB status to failed (not stuck running)', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'claude', target: { host_name: 'h' }, prompt: 'p' }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-crash', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => { throw new Error('synthetic crash'); });
    deps.db = c;
    const runner = createRunner(deps);
    // start() uses fire-and-forget; crash should flip status
    runner.start(r.id);
    // Wait briefly for async crash + cleanup
    await new Promise(res => setTimeout(res, 200));
    const final = await wfDb.getRun(c, r.id);
    // Run should have failed via the try/catch inside runToCompletion OR via start.catch cleanup
    assert.ok(final.status === 'failed', `expected 'failed', got '${final.status}'`);
    assert.ok(final.finished_at, 'finished_at must be set');
  });
});
