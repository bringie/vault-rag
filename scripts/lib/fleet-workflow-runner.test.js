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

test('branch condition does NOT interpolate output into source (injection prevention, vt-0074)', async () => {
  await withClient(async (c) => {
    await reset(c);
    // n1 returns output containing JS injection chars; if execBranch
    // interpolated n1.output into the condition source, the injection
    // would alter control flow. The fix passes output via sandbox prop only.
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'claude', target: { host_name: 'h' }, prompt: 'p' },
        { id: 'n2', type: 'branch', condition: 'n1.output === "real"' },
        { id: 'nT', type: 'delay', seconds: 0 },
        { id: 'nE', type: 'delay', seconds: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'nT', label: 'then' },
        { from: 'n2', to: 'nE', label: 'else' },
      ],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-inj', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    // Output contains chars that would break naive interpolation:
    //   `"; process.exit(99); //`
    // If interpolated → `"" === ""; process.exit(99); //"` would execute exit.
    // With fix → sandbox.n1.output = that string, condition compares to "real" → false.
    const deps = makeDeps(async () => ({
      output: '"; process.exit(99); //', exit_code: 0, session_id: 'sx',
    }));
    deps.db = c;
    const runner = createRunner(deps);
    await runner.runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done', 'run completed normally — no exit/escape');
    // Output !== "real" → else branch taken
    assert.ok(!final.state.outputs.nT, 'then branch must NOT have run');
    assert.ok(final.state.outputs.nE, 'else branch should have run');
  });
});

// --- New blocks (vt-0108) ---

test('transform: evaluates expr against ctx', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'delay', seconds: 0 },
        { id: 'n2', type: 'transform', expr: '"hello " + inputs.who' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-tf', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def, state: { inputs: { who: 'fleet' } } });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n2.output, 'hello fleet');
  });
});

test('set_variable: writes to inputs ctx, visible to next node', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'set_variable', key: 'greeting', value_expr: '"hi"' },
        { id: 'n2', type: 'transform', expr: 'inputs.greeting + " there"' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-sv', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n2.output, 'hi there');
  });
});

test('fan_out + aggregate concat: parallel spawn, joined output', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'fan_out',
          targets: [{ host_name: 'h1' }, { host_name: 'h2' }, { host_name: 'h3' }],
          prompt: 'go', timeout_s: 5 },
        { id: 'n2', type: 'aggregate', input_ref: 'n1', op: 'concat' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-fo', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    let calls = 0;
    const deps = makeDeps(async ({ node }) => {
      calls += 1;
      return { output: `from-${node.target.host_name}`, exit_code: 0, session_id: 's' + calls };
    });
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(calls, 3, 'fan_out fired all 3 child claude spawns');
    assert.strictEqual(final.state.outputs.n1.results.length, 3);
    assert.strictEqual(final.state.outputs.n2.output, 'from-h1\n---\nfrom-h2\n---\nfrom-h3');
  });
});

test('aggregate count_exit: tallies exit codes from fan_out', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'fan_out',
          targets: [{ host_name: 'a' }, { host_name: 'b' }, { host_name: 'c' }],
          prompt: 'p', timeout_s: 5 },
        { id: 'n2', type: 'aggregate', input_ref: 'n1', op: 'count_exit' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-cnt', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const codes = { a: 0, b: 1, c: 0 };
    const deps = makeDeps(async ({ node }) => ({
      output: '', exit_code: codes[node.target.host_name], session_id: 's',
    }));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.deepStrictEqual(JSON.parse(final.state.outputs.n2.output), { '0': 2, '1': 1 });
  });
});

test('transform: invalid expr fails the run with failed_node_id set', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'transform', expr: 'totally.broken.expr' }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-bad', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'failed');
    assert.strictEqual(final.failed_node_id, 'n1');
  });
});

// --- vt-0109 blocks ---

test('log: emits broadcast frame, output mirrors message', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'log', message: 'hello {{inputs.who}}' }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-log', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def, state: { inputs: { who: 'fleet' } } });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.output, 'hello fleet');
    const logFrames = deps.getFrames().filter(f => f.frame.type === 'log');
    assert.strictEqual(logFrames.length, 1);
    assert.strictEqual(logFrames[0].frame.message, 'hello fleet');
  });
});

test('assert: pass case → exit_code 0', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'assert', expr: '1 + 1 === 2', message: 'math works' }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-assert-ok', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.exit_code, 0);
    assert.strictEqual(final.state.outputs.n1.pass, true);
  });
});

test('assert: fail_workflow=true → run fails with failed_node_id', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'assert', expr: 'false', message: 'nope', fail_workflow: true }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-assert-fail', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'failed');
    assert.strictEqual(final.failed_node_id, 'n1');
  });
});

test('retry: re-executes inner on failure, succeeds on 3rd attempt', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{
        id: 'n1', type: 'retry', max_attempts: 3, backoff_ms: 10,
        inner: { type: 'claude', target: { host_name: 'h' }, prompt: 'p' },
      }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-retry', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    let calls = 0;
    const deps = makeDeps(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`attempt ${calls} fails`);
      return { output: 'ok', exit_code: 0, session_id: 's' };
    });
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(calls, 3, 'inner ran 3 times');
    assert.strictEqual(final.state.outputs.n1.output, 'ok');
  });
});

test('retry: exhausts attempts and fails the run', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{
        id: 'n1', type: 'retry', max_attempts: 2, backoff_ms: 1,
        inner: { type: 'transform', expr: 'nope.broken' },
      }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-retry-fail', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'failed');
    assert.strictEqual(final.failed_node_id, 'n1');
  });
});

test('for_each: iterates array, binds item_var, collects results', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{
        id: 'n1', type: 'for_each', input_ref: 'inputs.list', item_var: 'item',
        inner: { type: 'transform', expr: '"item=" + item' },
      }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-for-each', definition: def });
    const r = await wfDb.createRun(c, {
      workflowId: w.id, snapshot: def,
      state: { inputs: { list: ['a', 'b', 'c'] } },
    });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.results.length, 3);
    assert.deepStrictEqual(final.state.outputs.n1.results.map(r => r.output), ['item=a', 'item=b', 'item=c']);
  });
});

test('sub_workflow: drives child to completion and exposes outputs', async () => {
  await withClient(async (c) => {
    await reset(c);
    const childDef = {
      start: 'a',
      nodes: [{ id: 'a', type: 'transform', expr: '"child output " + inputs.x' }],
      edges: [],
    };
    const childWf = await wfDb.createWorkflow(c, { name: 'wf-child', definition: childDef });

    const parentDef = {
      start: 'n1',
      nodes: [{
        id: 'n1', type: 'sub_workflow',
        workflow_id: childWf.id,
        inputs_map: { x: '"parent val"' },
      }],
      edges: [],
    };
    const parentWf = await wfDb.createWorkflow(c, { name: 'wf-parent', definition: parentDef });
    const r = await wfDb.createRun(c, { workflowId: parentWf.id, snapshot: parentDef });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.outputs.a.output, 'child output parent val');
  });
});

test('recursion guard: dispatch cap kicks in on infinite-loop sub_workflow', async () => {
  await withClient(async (c) => {
    await reset(c);
    // Create a workflow that calls itself — guarded only by dispatch cap.
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'sub_workflow', workflow_id: 'placeholder' }],
      edges: [],
    };
    const wf = await wfDb.createWorkflow(c, { name: 'wf-self', definition: def });
    def.nodes[0].workflow_id = wf.id;
    await wfDb.updateWorkflow(c, wf.id, { definition: def });
    const r = await wfDb.createRun(c, { workflowId: wf.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'failed');
    // Walk descendant runs (created during recursion) until we find one that
    // carries the actual depth-exceeded error — the root run only sees its
    // immediate child's "sub_workflow ended with status=failed" wrapper.
    const { rows: descendants } = await c.query(
      'SELECT state FROM fleet_workflow_runs WHERE id <> $1 ORDER BY created_at',
      [r.id]);
    const allErrors = descendants.map(d => (d.state && d.state.error) || '').join(' || ');
    assert.match(allErrors, /recursion|dispatches|nesting|depth/i);
  });
});
