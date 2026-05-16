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
  // vt-0082: unreachable-from-start nodes are likely author errors (orphan islands).
  for (const n of nodes) {
    if (!visited.has(n.id)) throw new Error(`node ${n.id} is unreachable from start`);
  }
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

  // transform: evaluate JS expression against ctx, no Claude session.
  // Same vm.runInContext policy as branch — NOT a security sandbox.
  // Use case: extract a field from prior output without burning tokens
  // on "split this string by newline" prompts.
  function execTransform(node, ctx) {
    if (!node.expr) throw new Error('transform: expr required');
    const sandbox = vm.createContext({ ...ctx });
    try {
      const result = vm.runInContext(node.expr, sandbox, { timeout: 200 });
      const output = typeof result === 'string' ? result : JSON.stringify(result);
      return { output, exit_code: 0 };
    } catch (e) {
      throw new Error(`transform error: ${e.message}`);
    }
  }

  // http_request: call external URL with template-substituted url/headers/body.
  // 30s default timeout; status surfaced; non-2xx → exit_code=1 (workflow author
  // can branch on it). Replaces "ask claude to call this API" prompts.
  async function execHttpRequest(node, ctx, runId) {
    const url = substituteTemplates(node.url, ctx);
    if (!url) throw new Error('http_request: url required');
    const method = (node.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(node.headers || {})) {
      headers[k] = substituteTemplates(v, ctx);
    }
    let body = null;
    if (!['GET', 'HEAD'].includes(method) && node.body != null) {
      body = typeof node.body === 'string'
        ? substituteTemplates(node.body, ctx)
        : substituteTemplates(JSON.stringify(node.body), ctx);
      if (!headers['content-type'] && typeof node.body !== 'string') {
        headers['content-type'] = 'application/json';
      }
    }
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    const timeoutMs = Math.min(Math.max(node.timeout_ms || 30000, 1000), 120000);
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      return { output: text.slice(0, 65536), exit_code: res.ok ? 0 : 1, status: res.status };
    } catch (e) {
      throw new Error(`http_request error: ${e.message}`);
    } finally {
      clearTimeout(t);
      activeControllers.delete(runId);
    }
  }

  // notify: fire-and-forget POST a webhook. Output records sent status; the
  // workflow does not stop on a non-2xx. Use case: mid-workflow Slack ping.
  async function execNotify(node, ctx, runId) {
    const url = substituteTemplates(node.webhook_url, ctx);
    if (!url) throw new Error('notify: webhook_url required');
    const message = substituteTemplates(node.message_template || '', ctx);
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    const t = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message, message }),
        signal: controller.signal,
      });
      return { output: `notify status=${res.status}`, exit_code: 0, status: res.status };
    } catch (e) {
      // Best-effort — don't fail the run if the webhook is down.
      return { output: `notify failed: ${e.message}`, exit_code: 0, error: e.message };
    } finally {
      clearTimeout(t);
      activeControllers.delete(runId);
    }
  }

  // set_variable: evaluate value_expr in sandbox, write result to ctx.inputs[key].
  // Lets the author give meaningful names instead of {{n3.output}} chains.
  function execSetVariable(node, ctx) {
    const key = String(node.key || '').trim();
    if (!key) throw new Error('set_variable: key required');
    if (!node.value_expr) throw new Error('set_variable: value_expr required');
    const sandbox = vm.createContext({ ...ctx });
    let value;
    try {
      value = vm.runInContext(node.value_expr, sandbox, { timeout: 200 });
    } catch (e) {
      throw new Error(`set_variable error: ${e.message}`);
    }
    ctx.inputs[key] = value;
    return { output: `inputs.${key} set`, exit_code: 0, value };
  }

  // fan_out: dispatch the same Claude prompt to N targets in parallel.
  // Each target is the same shape as a claude-node target ({group}, {host_name},
  // {capability}). Results collected as an array; child errors do NOT abort the
  // fan_out (they are recorded with exit_code=-1 in their slot).
  async function execFanOut(node, ctx, runId) {
    const targets = Array.isArray(node.targets) ? node.targets : [];
    if (!targets.length) throw new Error('fan_out: targets[] required');
    const promptTpl = node.prompt || '';
    const calls = targets.map((target, idx) => {
      const childNode = {
        id: `${node.id}.${idx}`,
        type: 'claude',
        target,
        prompt: promptTpl,
        model: node.model,
        timeout_s: node.timeout_s || 300,
        headless: node.headless !== false,
      };
      const childPrompt = substituteTemplates(promptTpl, ctx);
      const ctrl = new AbortController();
      return deps.spawnClaude({ node: childNode, prompt: childPrompt, ctx, runId, signal: ctrl.signal })
        .then(r => ({ target, output: r.output, exit_code: r.exit_code, session_id: r.session_id }))
        .catch(e => ({ target, error: e.message, exit_code: -1 }));
    });
    const results = await Promise.all(calls);
    return { output: `fan_out ${results.length} results`, exit_code: 0, results };
  }

  // aggregate: reduce a prior fan_out result array via a fixed op set.
  // Ops:
  //   concat         — join all outputs with a separator
  //   count_exit     — { "0": n, "1": n, ... } counts by exit_code
  //   first_success  — first result whose exit_code === 0 (or empty)
  //   all_outputs    — JSON array of outputs
  function execAggregate(node, ctx) {
    const ref = String(node.input_ref || '').trim();
    if (!ref) throw new Error('aggregate: input_ref required');
    const src = ctx[ref];
    if (!src || !Array.isArray(src.results)) {
      throw new Error(`aggregate: ${ref} has no .results array`);
    }
    const arr = src.results;
    const op = String(node.op || 'concat');
    let output;
    if (op === 'concat') {
      output = arr.map(r => r.output || '').join('\n---\n');
    } else if (op === 'count_exit') {
      const map = {};
      for (const r of arr) {
        const k = String(r.exit_code ?? '?');
        map[k] = (map[k] || 0) + 1;
      }
      output = JSON.stringify(map);
    } else if (op === 'first_success') {
      const ok = arr.find(r => r.exit_code === 0);
      output = ok ? (ok.output || '') : '';
    } else if (op === 'all_outputs') {
      output = JSON.stringify(arr.map(r => r.output || ''));
    } else {
      throw new Error(`aggregate: unknown op ${op}`);
    }
    return { output: String(output), exit_code: 0 };
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
    try {
      return await _runToCompletion(runId);
    } finally {
      // vt-0082: clean Set entry so it doesn't leak over hub lifetime.
      cancelled.delete(runId);
    }
  }

  async function _runToCompletion(runId) {
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
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `unknown node ${current}`, current);
        deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'failed' });
        return;
      }
      deps.broadcast(runId, { type: 'node_progress', run_id: runId, node_id: current, status: 'running' });
      await wfDb.updateRunState(deps.db, runId, { current_node: current });

      const ctxData = { ...outputs, inputs };
      let result;
      try {
        if      (node.type === 'claude')        result = await execClaude(node, ctxData, runId);
        else if (node.type === 'branch')        result = execBranch(node, ctxData);
        else if (node.type === 'delay')         result = await execDelay(node, runId);
        else if (node.type === 'transform')     result = execTransform(node, ctxData);
        else if (node.type === 'http_request')  result = await execHttpRequest(node, ctxData, runId);
        else if (node.type === 'notify')        result = await execNotify(node, ctxData, runId);
        else if (node.type === 'set_variable')  result = execSetVariable(node, ctxData);
        else if (node.type === 'fan_out')       result = await execFanOut(node, ctxData, runId);
        else if (node.type === 'aggregate')     result = execAggregate(node, ctxData);
        else throw new Error(`unknown node type: ${node.type}`);
      } catch (e) {
        if (e.message === 'cancelled') {
          await wfDb.updateRunStatus(deps.db, runId, 'cancelled');
          deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'cancelled' });
          return;
        }
        deps.broadcast(runId, { type: 'node_progress', run_id: runId, node_id: current, status: 'failed', error: e.message });
        await wfDb.updateRunStatus(deps.db, runId, 'failed', `${current}: ${e.message}`, current);
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
