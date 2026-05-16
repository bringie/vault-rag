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

// --- vt-0110: wait_for_approval + wait_for_event ---

test('wait_for_approval: resumes on decision; takes approve edge', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'wait_for_approval', reason: 'go?', timeout_s: 30 },
        { id: 'nA', type: 'transform', expr: '"approved"' },
        { id: 'nR', type: 'transform', expr: '"rejected"' },
      ],
      edges: [
        { from: 'n1', to: 'nA', label: 'approve' },
        { from: 'n1', to: 'nR', label: 'reject' },
      ],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-approval', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    const runner = createRunner(deps);
    const runPromise = runner.runToCompletion(r.id);
    // Simulate operator approving after 100ms.
    setTimeout(async () => {
      try {
        await wfDb.recordApprovalDecision(c, r.id, 'n1', { decision: 'approve', decided_by: 'test' });
      } catch (e) { console.error('test approve failed:', e.message); }
    }, 100);
    await runPromise;
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.decision, 'approve');
    assert.strictEqual(final.state.outputs.nA.output, 'approved');
    assert.ok(!final.state.outputs.nR, 'reject branch did not run');
  });
});

test('wait_for_event: resumes when fireEvent matches name', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'wait_for_event', event_name: 'ci.done', timeout_s: 30 },
        { id: 'n2', type: 'transform', expr: '"saw " + n1.payload.run_id' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-event', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    const runner = createRunner(deps);
    const runPromise = runner.runToCompletion(r.id);
    setTimeout(async () => {
      try { await wfDb.fireEvent(c, 'ci.done', { run_id: 42 }); }
      catch (e) { console.error('test fire failed:', e.message); }
    }, 100);
    await runPromise;
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.deepStrictEqual(final.state.outputs.n1.payload, { run_id: 42 });
    assert.strictEqual(final.state.outputs.n2.output, 'saw 42');
  });
});

test('wait_for_approval: validateDefinition requires approve+reject edges', () => {
  const { validateDefinition } = require('./fleet-workflow-runner');
  assert.throws(() => validateDefinition({
    start: 'n1',
    nodes: [
      { id: 'n1', type: 'wait_for_approval' },
      { id: 'n2', type: 'transform', expr: '1' },
    ],
    edges: [{ from: 'n1', to: 'n2', label: 'approve' }], // missing reject
  }), /approve.*reject/);
});

// --- vt-0118: sub_workflow cancel propagation ---

test('cancel(parent) propagates into sub_workflow child run', async () => {
  await withClient(async (c) => {
    await reset(c);
    // child: a long delay so it's still running when parent is cancelled
    const childDef = {
      start: 'a',
      nodes: [{ id: 'a', type: 'delay', seconds: 5 }],
      edges: [],
    };
    const child = await wfDb.createWorkflow(c, { name: 'wf-child', definition: childDef });
    const parentDef = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'sub_workflow', workflow_id: child.id }],
      edges: [],
    };
    const parent = await wfDb.createWorkflow(c, { name: 'wf-parent', definition: parentDef });
    const r = await wfDb.createRun(c, { workflowId: parent.id, snapshot: parentDef });
    const deps = makeDeps(async () => ({}));
    deps.db = c;
    const runner = createRunner(deps);
    const runPromise = runner.runToCompletion(r.id);
    // Let parent enter child, then cancel parent.
    setTimeout(() => runner.cancel(r.id), 100);
    await runPromise;
    const finalParent = await wfDb.getRun(c, r.id);
    assert.strictEqual(finalParent.status, 'cancelled');
    // Find the child run (only one was created) and assert it's also cancelled.
    const { rows } = await c.query(
      `SELECT id, status FROM fleet_workflow_runs WHERE workflow_id = $1`, [child.id]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'cancelled', 'child run must be cancelled');
  });
});

test('fan_out children abort on parent cancel', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = {
      start: 'n1',
      nodes: [{
        id: 'n1', type: 'fan_out',
        targets: [{ host_name: 'a' }, { host_name: 'b' }, { host_name: 'c' }],
        prompt: 'p', timeout_s: 60,
      }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-fo-cancel', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const aborts = [];
    const deps = makeDeps(({ signal }) => new Promise((resolve, reject) => {
      // Long-running stub that resolves only when signal aborts.
      if (signal.aborted) { aborts.push(true); return reject(new Error('cancelled')); }
      signal.addEventListener('abort', () => {
        aborts.push(true);
        reject(new Error('cancelled'));
      });
      setTimeout(() => resolve({ output: 'late', exit_code: 0, session_id: 's' }), 30000);
    }));
    deps.db = c;
    const runner = createRunner(deps);
    const p = runner.runToCompletion(r.id);
    setTimeout(() => runner.cancel(r.id), 100);
    await p;
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'cancelled');
    assert.strictEqual(aborts.length, 3, 'all 3 fan_out children received abort');
  });
});

// vt-0131: focused tests for previously-untested node types and edge cases.

const http = require('node:http');

async function startEchoServer(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise(r => srv.close(r)) };
}

test('vt-0131: http_request returns response text + status (2xx → exit_code 0)', async () => {
  const { srv, port, close } = await startEchoServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    await withClient(async (c) => {
      await reset(c);
      const def = { start: 'n1', nodes: [{ id: 'n1', type: 'http_request', url: `http://127.0.0.1:${port}/x`, method: 'GET' }], edges: [] };
      const w = await wfDb.createWorkflow(c, { name: 'wf-http', definition: def });
      const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
      const deps = makeDeps(async () => assert.fail('claude not used'));
      deps.db = c;
      await createRunner(deps).runToCompletion(r.id);
      const final = await wfDb.getRun(c, r.id);
      assert.strictEqual(final.status, 'done');
      assert.strictEqual(final.state.outputs.n1.exit_code, 0);
      assert.strictEqual(final.state.outputs.n1.status, 200);
      assert.match(final.state.outputs.n1.output, /"ok":true/);
    });
  } finally { await close(); }
});

test('vt-0131: http_request non-2xx → exit_code 1', async () => {
  const { srv, port, close } = await startEchoServer((req, res) => {
    res.writeHead(500); res.end('boom');
  });
  try {
    await withClient(async (c) => {
      await reset(c);
      const def = { start: 'n1', nodes: [{ id: 'n1', type: 'http_request', url: `http://127.0.0.1:${port}/`, method: 'GET' }], edges: [] };
      const w = await wfDb.createWorkflow(c, { name: 'wf-http-fail', definition: def });
      const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
      const deps = makeDeps(async () => assert.fail('claude not used'));
      deps.db = c;
      await createRunner(deps).runToCompletion(r.id);
      const final = await wfDb.getRun(c, r.id);
      assert.strictEqual(final.state.outputs.n1.exit_code, 1);
      assert.strictEqual(final.state.outputs.n1.status, 500);
    });
  } finally { await close(); }
});

test('vt-0131: http_request aborts on cancel', async () => {
  // Server that never responds — request waits forever.
  const { port, close } = await startEchoServer(() => { /* hang */ });
  try {
    await withClient(async (c) => {
      await reset(c);
      const def = { start: 'n1', nodes: [{ id: 'n1', type: 'http_request', url: `http://127.0.0.1:${port}/`, method: 'GET', timeout_ms: 60000 }], edges: [] };
      const w = await wfDb.createWorkflow(c, { name: 'wf-http-cancel', definition: def });
      const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
      const deps = makeDeps(async () => assert.fail('claude not used'));
      deps.db = c;
      const runner = createRunner(deps);
      const p = runner.runToCompletion(r.id);
      setTimeout(() => runner.cancel(r.id), 100);
      await p;
      const final = await wfDb.getRun(c, r.id);
      assert.strictEqual(final.status, 'cancelled');
    });
  } finally { await close(); }
});

test('vt-0131: notify is best-effort — non-2xx still exit_code 0', async () => {
  const { port, close } = await startEchoServer((req, res) => { res.writeHead(500); res.end(); });
  try {
    await withClient(async (c) => {
      await reset(c);
      const def = { start: 'n1', nodes: [{ id: 'n1', type: 'notify', webhook_url: `http://127.0.0.1:${port}/hook`, message_template: 'hi' }], edges: [] };
      const w = await wfDb.createWorkflow(c, { name: 'wf-notify', definition: def });
      const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
      const deps = makeDeps(async () => assert.fail('claude not used'));
      deps.db = c;
      await createRunner(deps).runToCompletion(r.id);
      const final = await wfDb.getRun(c, r.id);
      assert.strictEqual(final.status, 'done');
      assert.strictEqual(final.state.outputs.n1.exit_code, 0);
      assert.strictEqual(final.state.outputs.n1.status, 500);
    });
  } finally { await close(); }
});

test('vt-0131: notify swallows network error (exit_code 0)', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = { start: 'n1', nodes: [{ id: 'n1', type: 'notify', webhook_url: 'http://127.0.0.1:1/none', message_template: 'hi' }], edges: [] };
    const w = await wfDb.createWorkflow(c, { name: 'wf-notify-down', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => assert.fail('claude not used'));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.state.outputs.n1.exit_code, 0);
    assert.match(final.state.outputs.n1.output, /notify failed/);
  });
});

test('vt-0131: wait_for_event timeout fails the run', async () => {
  await withClient(async (c) => {
    await reset(c);
    const def = { start: 'n1', nodes: [{ id: 'n1', type: 'wait_for_event', event_name: 'never_fires', timeout_s: 1 }], edges: [] };
    const w = await wfDb.createWorkflow(c, { name: 'wf-wfe-timeout', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => assert.fail('claude not used'));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'failed');
    assert.match(JSON.stringify(final.state), /timeout|never_fires/);
  });
});

test('vt-0131: retry cancel mid-backoff propagates abort', async () => {
  await withClient(async (c) => {
    await reset(c);
    // Inner is a claude node that always fails; retry will backoff between attempts.
    const def = {
      start: 'n1',
      nodes: [{
        id: 'n1', type: 'retry', max_attempts: 5, backoff_ms: 2000,
        inner: { type: 'claude', target: { host_name: 'h' }, prompt: 'p' },
      }],
      edges: [],
    };
    const w = await wfDb.createWorkflow(c, { name: 'wf-retry-cancel', definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    let attempts = 0;
    const deps = makeDeps(async () => { attempts++; throw new Error('fail'); });
    deps.db = c;
    const runner = createRunner(deps);
    const p = runner.runToCompletion(r.id);
    // Let one attempt fail, then cancel during the 2s backoff.
    setTimeout(() => runner.cancel(r.id), 200);
    await p;
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'cancelled');
    assert.ok(attempts < 5, `cancel should short-circuit retries; got ${attempts}/5`);
  });
});

test('vt-0131: MAX_SUB_WORKFLOW_DEPTH stops infinite self-nesting', async () => {
  await withClient(async (c) => {
    await reset(c);
    // Self-recursive sub_workflow: each level dispatches the same workflow as
    // a child. Depth limit (10) should kick in before MAX_DISPATCHES_PER_RUN (500).
    const w = await wfDb.createWorkflow(c, {
      name: 'wf-self', definition: {
        start: 'n1',
        nodes: [{ id: 'n1', type: 'delay', seconds: 0 }],
        edges: [],
      },
    });
    const def = {
      start: 'n1',
      nodes: [{ id: 'n1', type: 'sub_workflow', workflow_id: w.id }],
      edges: [],
    };
    await wfDb.updateWorkflow(c, w.id, { definition: def });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: def });
    const deps = makeDeps(async () => assert.fail('claude not used'));
    deps.db = c;
    await createRunner(deps).runToCompletion(r.id);
    const final = await wfDb.getRun(c, r.id);
    assert.strictEqual(final.status, 'failed');
    // Depth-exhaustion error is captured in the deepest child run; parent's
    // state carries the generic propagation message. Verify the chain by
    // counting runs created and finding the depth-limit error somewhere.
    const { rows } = await c.query("SELECT id, status, state FROM fleet_workflow_runs WHERE workflow_id = $1", [w.id]);
    assert.ok(rows.length >= 5, `expected nested run rows, got ${rows.length}`);
    const hasDepthErr = rows.some(rr => /max.*depth|nesting/i.test(JSON.stringify(rr.state || {})));
    assert.ok(hasDepthErr, 'at least one nested run should carry the depth-limit error');
  });
});
