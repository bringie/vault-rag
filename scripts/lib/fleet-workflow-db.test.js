'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const wfDb = require('./fleet-workflow-db');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || '127.0.0.1',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     parseInt(process.env.VAULT_RAG_PG_PORT || '55433', 10),
};

async function withClient(fn) {
  const c = new Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function reset(c) {
  await c.query('TRUNCATE fleet_workflow_runs, fleet_workflows RESTART IDENTITY CASCADE');
}

const SAMPLE_DEF = {
  start: 'n1',
  nodes: [{ id: 'n1', type: 'delay', seconds: 1, position: { x: 0, y: 0 } }],
  edges: [],
};

test('createWorkflow inserts and returns row', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    assert.ok(w.id);
    assert.strictEqual(w.name, 'wf1');
    assert.deepStrictEqual(w.definition, SAMPLE_DEF);
  });
});

test('listWorkflows returns all', async () => {
  await withClient(async (c) => {
    await reset(c);
    await wfDb.createWorkflow(c, { name: 'a', definition: SAMPLE_DEF });
    await wfDb.createWorkflow(c, { name: 'b', definition: SAMPLE_DEF });
    const list = await wfDb.listWorkflows(c);
    assert.strictEqual(list.length, 2);
  });
});

test('updateWorkflow patches name and bumps updated_at', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    await new Promise(r => setTimeout(r, 10));
    const u = await wfDb.updateWorkflow(c, w.id, { name: 'wf2' });
    assert.strictEqual(u.name, 'wf2');
    assert.ok(new Date(u.updated_at).getTime() > new Date(w.updated_at).getTime());
  });
});

test('deleteWorkflow removes row; runs survive with workflow_id NULL', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.deleteWorkflow(c, w.id);
    const runs = await wfDb.listRuns(c, {});
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].workflow_id, null);
  });
});

test('createRun + updateRunStatus lifecycle', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    assert.strictEqual(r.status, 'pending');

    await wfDb.updateRunStatus(c, r.id, 'running');
    const r2 = await wfDb.getRun(c, r.id);
    assert.strictEqual(r2.status, 'running');
    assert.ok(r2.started_at);

    await wfDb.updateRunStatus(c, r.id, 'done');
    const r3 = await wfDb.getRun(c, r.id);
    assert.strictEqual(r3.status, 'done');
    assert.ok(r3.finished_at);
  });
});

test('updateRunState merges JSONB', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.updateRunState(c, r.id, { current_node: 'n1', outputs: { n1: { output: 'hi', exit_code: 0 } } });
    const r2 = await wfDb.getRun(c, r.id);
    assert.deepStrictEqual(r2.state.outputs.n1, { output: 'hi', exit_code: 0 });
    assert.strictEqual(r2.state.current_node, 'n1');
  });
});

test('orphanRunningRuns flips running→failed at boot', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf1', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.updateRunStatus(c, r.id, 'running');
    const n = await wfDb.orphanRunningRuns(c);
    assert.strictEqual(n, 1);
    const r2 = await wfDb.getRun(c, r.id);
    assert.strictEqual(r2.status, 'failed');
    assert.match(JSON.stringify(r2.state), /hub restart/);
  });
});

// vt-0128: re-entering a wait_for_approval node used to keep the previous
// `decision` row in place — next poll would auto-resolve without operator
// action. createPendingApproval now resets decision fields on conflict.
test('vt-0128: createPendingApproval clears stale decision on re-entry', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf-approval', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    // First wait_for_approval invocation
    await wfDb.createPendingApproval(c, { runId: r.id, nodeId: 'approve_step', reason: 'first' });
    // Operator approves
    const decided = await wfDb.recordApprovalDecision(c, r.id, 'approve_step', { decision: 'approve', decided_by: 'op' });
    assert.strictEqual(decided.decision, 'approve');
    // wait_for_approval re-enters (retry / sub_workflow / replay) — must NOT
    // see the stale decision.
    await wfDb.createPendingApproval(c, { runId: r.id, nodeId: 'approve_step', reason: 'second' });
    const refreshed = await wfDb.getPendingApproval(c, r.id, 'approve_step');
    assert.strictEqual(refreshed.decision, null, 'decision should be cleared on re-entry');
    assert.strictEqual(refreshed.decided_at, null);
    assert.strictEqual(refreshed.decided_by, null);
    assert.strictEqual(refreshed.reason, 'second');
  });
});

test('vt-0128: createPendingEvent clears stale fired_at on re-entry', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf-event', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    await wfDb.createPendingEvent(c, { runId: r.id, nodeId: 'wait_event', eventName: 'ev1' });
    await wfDb.fireEvent(c, 'ev1', { foo: 'bar' });
    const fired = await wfDb.getPendingEvent(c, r.id, 'wait_event');
    assert.ok(fired.fired_at);
    // Re-enter wait_for_event for the same node
    await wfDb.createPendingEvent(c, { runId: r.id, nodeId: 'wait_event', eventName: 'ev2' });
    const refreshed = await wfDb.getPendingEvent(c, r.id, 'wait_event');
    assert.strictEqual(refreshed.fired_at, null);
    assert.strictEqual(refreshed.payload, null);
    assert.strictEqual(refreshed.event_name, 'ev2');
  });
});

test('vt-0128: recordApprovalDecision returns null when no pending row exists', async () => {
  await withClient(async (c) => {
    await reset(c);
    const w = await wfDb.createWorkflow(c, { name: 'wf-ad', definition: SAMPLE_DEF });
    const r = await wfDb.createRun(c, { workflowId: w.id, snapshot: SAMPLE_DEF });
    // No createPendingApproval — caller can't fabricate decisions for nodes
    // the workflow never waited on. handleApprovalDecision turns this into 409.
    const decided = await wfDb.recordApprovalDecision(c, r.id, 'arbitrary_node_id', { decision: 'approve' });
    assert.strictEqual(decided, null);
  });
});
