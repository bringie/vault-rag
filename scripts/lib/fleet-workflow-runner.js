'use strict';
// fleet-workflow-runner: in-process DAG executor for fleet_workflow_runs.
// deps: { db, spawnClaude({node,prompt,ctx,runId}), broadcast(runId, frame) }
const vm = require('vm');
const wfDb = require('./fleet-workflow-db');

const TEMPLATE_RE = /\{\{([\w.]+)\}\}/g;

function substituteTemplates(str, ctx) {
  if (str == null) return str;
  return String(str).replace(TEMPLATE_RE, (_, path) => {
    const parts = path.split('.');
    let v = ctx;
    for (const p of parts) {
      if (v == null) return '';
      v = v[p];
    }
    return v == null ? '' : String(v);
  });
}

function validateDefinition(def) {
  if (!def || typeof def !== 'object') throw new Error('definition required');
  const { start, nodes, edges } = def;
  if (!start) throw new Error('start node required');
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('nodes required');
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (!byId.has(start)) throw new Error(`unknown start node: ${start}`);
  for (const e of edges || []) {
    if (!byId.has(e.from)) throw new Error(`edge from unknown node: ${e.from}`);
    if (!byId.has(e.to))   throw new Error(`edge to unknown node: ${e.to}`);
  }
  for (const n of nodes) {
    if (n.type !== 'branch') continue;
    const out = (edges || []).filter(e => e.from === n.id);
    const labels = new Set(out.map(e => e.label));
    if (out.length !== 2 || !labels.has('then') || !labels.has('else')) {
      throw new Error(`branch node ${n.id} must have exactly one then and one else outgoing edge`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function dfs(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
    visiting.add(id);
    for (const e of (edges || []).filter(e => e.from === id)) dfs(e.to);
    visiting.delete(id);
    visited.add(id);
  }
  dfs(start);
}

// Branch condition is evaluated as a JS expression with ctx variables (n1, n2,
// inputs, etc.) exposed as sandbox properties. Output values from prior nodes
// are NEVER interpolated into the source string — that would let LLM-generated
// output influence control flow via injection (vt-0074).
//
// SECURITY POLICY: vm.runInContext is NOT a security sandbox. Workflow conditions
// can still escape via `this.constructor.constructor("...")()` etc. This is
// acceptable because workflow authoring is a privileged admin operation —
// equivalent to running scripts on the hub. Do not allow untrusted users to
// create or edit workflow definitions.
function evalCondition(expr, sandboxData) {
  const sandbox = vm.createContext({ ...sandboxData });
  try {
    return !!vm.runInContext(expr, sandbox, { timeout: 100 });
  } catch (e) {
    throw new Error(`branch condition error: ${e.message}`);
  }
}

function nextNode(currentId, def, branchResult) {
  const out = (def.edges || []).filter(e => e.from === currentId);
  if (!out.length) return null;
  if (branchResult !== undefined) {
    const want = branchResult ? 'then' : 'else';
    const e = out.find(x => x.label === want);
    return e ? e.to : null;
  }
  return out[0].to;
}

function createRunner(deps) {
  const cancelled = new Set();
  // Per-run AbortControllers — abort() on cancel() so long-running execClaude
  // poll loops can short-circuit instead of waiting full timeout_s (vt-0075).
  const activeControllers = new Map(); // runId → AbortController

  async function execClaude(node, ctx, runId) {
    const prompt = substituteTemplates(node.prompt, ctx);
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    try {
      return await deps.spawnClaude({ node, prompt, ctx, runId, signal: controller.signal });
    } finally {
      activeControllers.delete(runId);
    }
  }

  function execBranch(node, ctx) {
    // Do NOT substituteTemplates() the condition source — that would interpolate
    // LLM-generated output (n1.output etc) into the JS source, enabling injection
    // (vt-0074). Author writes condition as JS expression referencing ctx vars:
    //   n1.exit_code === 0     ✓
    //   n1.output === "ok"     ✓ (output stays in sandbox prop, not source)
    //   {{n1.output}} === "ok" ✗ (was a footgun; not supported anymore)
    const result = evalCondition(node.condition, ctx);
    return { result };
  }

  async function execDelay(node, runId) {
    const ms = Math.max(0, (node.seconds || 0) * 1000);
    if (ms === 0) return {};
    return await new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => { done = true; clearInterval(poll); resolve({}); }, ms);
      const poll = setInterval(() => {
        if (done) return;
        if (cancelled.has(runId)) {
          done = true;
          clearTimeout(t);
          clearInterval(poll);
          reject(new Error('cancelled'));
        }
      }, 50);
    });
  }

  async function runToCompletion(runId) {
    const run = await wfDb.getRun(deps.db, runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const def = run.snapshot;
    await wfDb.updateRunStatus(deps.db, runId, 'running');
    deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'running' });

    const outputs = {};
    const inputs = (run.state && run.state.inputs) || {};
    let current = def.start;
    const byId = new Map(def.nodes.map(n => [n.id, n]));

    while (current) {
      if (cancelled.has(runId)) {
        await wfDb.updateRunStatus(deps.db, runId, 'cancelled');
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'cancelled' });
        return;
      }
      const node = byId.get(current);
      if (!node) {
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `unknown node ${current}`);
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'failed' });
        return;
      }
      deps.broadcast(runId, { type: 'node_progress', run_id: runId, node_id: current, status: 'running' });
      await wfDb.updateRunState(deps.db, runId, { current_node: current });

      const ctxData = { ...outputs, inputs };
      let result;
      try {
        if (node.type === 'claude')      result = await execClaude(node, ctxData, runId);
        else if (node.type === 'branch') result = execBranch(node, ctxData);
        else if (node.type === 'delay')  result = await execDelay(node, runId);
        else throw new Error(`unknown node type: ${node.type}`);
      } catch (e) {
        if (e.message === 'cancelled') {
          await wfDb.updateRunStatus(deps.db, runId, 'cancelled');
          deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'cancelled' });
          return;
        }
        deps.broadcast(runId, { type: 'node_progress', run_id: runId, node_id: current, status: 'failed', error: e.message });
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `${current}: ${e.message}`);
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'failed' });
        return;
      }
      outputs[current] = result;
      await wfDb.updateRunState(deps.db, runId, { outputs });
      deps.broadcast(runId, {
        type: 'node_progress', run_id: runId, node_id: current, status: 'done',
        output: result.output, exit_code: result.exit_code, session_id: result.session_id,
      });

      current = nextNode(current, def, node.type === 'branch' ? result.result : undefined);
    }

    await wfDb.updateRunStatus(deps.db, runId, 'done');
    deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'done' });
  }

  function cancel(runId) {
    cancelled.add(runId);
    const ctrl = activeControllers.get(runId);
    if (ctrl) try { ctrl.abort(); } catch {}
  }

  function start(runId) {
    runToCompletion(runId).catch(async (e) => {
      console.error(`[fleet-workflow-runner] run ${runId} crashed:`, e);
      // Best-effort: flip DB row to 'failed' so UI doesn't show stuck 'running'.
      // Inner try guards against cascading failure (e.g. db pool down).
      try {
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `runner crash: ${e.message}`);
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'failed', error: e.message });
      } catch (e2) {
        console.error(`[fleet-workflow-runner] run ${runId} cleanup also failed:`, e2);
      }
    });
  }

  return { start, runToCompletion, cancel };
}

module.exports = { createRunner, substituteTemplates, validateDefinition, evalCondition, nextNode };
