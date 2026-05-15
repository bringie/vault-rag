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
