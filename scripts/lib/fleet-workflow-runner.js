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
    if (n.type === 'branch') {
      const out = (edges || []).filter(e => e.from === n.id);
      const labels = new Set(out.map(e => e.label));
      if (out.length !== 2 || !labels.has('then') || !labels.has('else')) {
        throw new Error(`branch node ${n.id} must have exactly one then and one else outgoing edge`);
      }
    }
    if (n.type === 'wait_for_approval') {
      const out = (edges || []).filter(e => e.from === n.id);
      const labels = new Set(out.map(e => e.label));
      // Allow 0 out (terminal) or exactly { approve, reject }.
      if (out.length > 0 && (out.length !== 2 || !labels.has('approve') || !labels.has('reject'))) {
        throw new Error(`wait_for_approval node ${n.id} must have either no outgoing edges or exactly one approve + one reject`);
      }
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

function nextNode(currentId, def, labelHint) {
  const out = (def.edges || []).filter(e => e.from === currentId);
  if (!out.length) return null;
  if (labelHint !== undefined && labelHint !== null) {
    const e = out.find(x => x.label === labelHint);
    return e ? e.to : null;
  }
  return out[0].to;
}

// Cap on total node dispatches per run — guards against runaway recursion
// when sub_workflow / retry / for_each are nested aggressively. 500 covers
// any realistic workflow (each top-level node usually counts as 1; the cap
// is the sum across recursion levels).
const MAX_DISPATCHES_PER_RUN = 500;
// Max chain of nested sub_workflow runs (depth=0 is root run). Prevents
// runaway recursion when workflow A calls B calls A.
const MAX_SUB_WORKFLOW_DEPTH = 10;

function createRunner(deps) {
  const cancelled = new Set();
  // Per-run AbortControllers — abort() on cancel() so long-running execClaude
  // poll loops can short-circuit instead of waiting full timeout_s (vt-0075).
  const activeControllers = new Map(); // runId → AbortController
  // fan_out children get their own AbortControllers stored here so parent
  // cancel() can abort all of them (vt-0118 P2).
  const fanOutControllers = new Map(); // runId → AbortController[]
  // Per-run dispatch counter (resets on cancel cleanup).
  const dispatchCount = new Map(); // runId → int
  // Map child→parent run id (sub_workflow chain). Lets cancel(parent) walk
  // and mark every descendant cancelled (vt-0118 P1).
  const runParents = new Map(); // childRunId → parentRunId

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
    // Cap to avoid a malformed workflow spawning hundreds of parallel sessions.
    if (targets.length > 50) {
      throw new Error(`fan_out: targets[] limit is 50, got ${targets.length}`);
    }
    const promptTpl = node.prompt || '';
    // Register all child controllers so cancel(runId) can abort them.
    const myControllers = [];
    const prev = fanOutControllers.get(runId) || [];
    fanOutControllers.set(runId, prev.concat(myControllers));
    try {
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
        myControllers.push(ctrl);
        fanOutControllers.get(runId).push(ctrl);
        return deps.spawnClaude({ node: childNode, prompt: childPrompt, ctx, runId, signal: ctrl.signal })
          .then(r => ({ target, output: r.output, exit_code: r.exit_code, session_id: r.session_id }))
          .catch(e => ({ target, error: e.message, exit_code: -1 }));
      });
      const results = await Promise.all(calls);
      // If the run was cancelled mid-fan-out, every child rejected with
      // 'cancelled' but we swallowed those into result objects. Surface the
      // cancellation to the main loop so the run flips to 'cancelled', not
      // 'done' (vt-0118).
      if (cancelled.has(runId)) throw new Error('cancelled');
      return { output: `fan_out ${results.length} results`, exit_code: 0, results };
    } finally {
      // Remove only OUR controllers from the run-level list; other concurrent
      // fan_out nodes on the same run (if any) keep theirs.
      const remaining = (fanOutControllers.get(runId) || []).filter(c => !myControllers.includes(c));
      if (remaining.length) fanOutControllers.set(runId, remaining);
      else fanOutControllers.delete(runId);
    }
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

  // assert: predicate check with optional named failure event. Like branch but
  // doesn't fork; if fail_workflow=true a falsy result throws to kill the run.
  // Use case: "exit_code === 0 before continuing" style guards.
  function execAssert(node, ctx, runId) {
    if (!node.expr) throw new Error('assert: expr required');
    const sandbox = vm.createContext({ ...ctx });
    let pass;
    try {
      pass = !!vm.runInContext(node.expr, sandbox, { timeout: 200 });
    } catch (e) {
      throw new Error(`assert error: ${e.message}`);
    }
    const message = node.message || (pass ? 'ok' : 'assertion failed');
    deps.broadcast(runId, { type: 'assert_result', run_id: runId, node_id: node.id, pass, message });
    if (!pass && node.fail_workflow) throw new Error(`assert failed: ${message}`);
    return { output: message, exit_code: pass ? 0 : 1, pass };
  }

  // log: emit a debug/audit marker into the broadcast stream. Output mirrors
  // the message so downstream nodes can reference it via {{nX.output}}.
  function execLog(node, ctx, runId) {
    const message = substituteTemplates(node.message || '', ctx);
    const level = node.level || 'info';
    deps.broadcast(runId, { type: 'log', run_id: runId, node_id: node.id, level, message });
    return { output: message, exit_code: 0 };
  }

  // retry: wrap an inner node, re-execute up to max_attempts with exponential
  // backoff on non-cancellation errors. Returns inner's first successful
  // result, or throws the last error after exhausting attempts.
  async function execRetry(node, ctx, runId) {
    if (!node.inner || !node.inner.type) throw new Error('retry: inner.{type} required');
    const maxAttempts = Math.max(1, Math.min(node.max_attempts || 3, 10));
    const baseBackoff = Math.max(0, node.backoff_ms || 1000);
    let lastErr;
    for (let i = 1; i <= maxAttempts; i++) {
      if (cancelled.has(runId)) throw new Error('cancelled');
      try {
        return await dispatchNode({ ...node.inner, id: `${node.id}.attempt${i}` }, ctx, runId);
      } catch (e) {
        if (e.message === 'cancelled') throw e;
        lastErr = e;
        if (i < maxAttempts) {
          await new Promise(r => setTimeout(r, baseBackoff * Math.pow(2, i - 1)));
        }
      }
    }
    throw lastErr || new Error(`retry: exhausted ${maxAttempts} attempts`);
  }

  // for_each: iterate over a referenced array (ctx path like "n2.results"),
  // execute inner per item with ctx[item_var] bound to current value. Sibling
  // to fan_out — same shape of result, but serial (good for rate-limited APIs).
  async function execForEach(node, ctx, runId) {
    if (!node.inner || !node.inner.type) throw new Error('for_each: inner.{type} required');
    if (!node.input_ref) throw new Error('for_each: input_ref required');
    const parts = String(node.input_ref).split('.');
    let arr = ctx;
    for (const p of parts) { if (arr == null) { arr = []; break; } arr = arr[p]; }
    if (!Array.isArray(arr)) throw new Error(`for_each: ${node.input_ref} is not an array`);
    const itemVar = node.item_var || 'item';
    const results = [];
    for (let i = 0; i < arr.length; i++) {
      if (cancelled.has(runId)) throw new Error('cancelled');
      const itemCtx = { ...ctx, [itemVar]: arr[i], index: i };
      try {
        const r = await dispatchNode({ ...node.inner, id: `${node.id}.${i}` }, itemCtx, runId);
        results.push(r);
      } catch (e) {
        if (e.message === 'cancelled') throw e;
        results.push({ error: e.message, exit_code: -1 });
      }
    }
    return { output: `for_each ${arr.length} iterations`, exit_code: 0, results };
  }

  // sub_workflow: load another workflow, create a child run, drive to completion,
  // expose its outputs. Inputs to the child are computed from inputs_map (string
  // JS exprs evaluated against parent ctx). Recursion guarded by dispatch counter.
  async function execSubWorkflow(node, ctx, runId) {
    if (!node.workflow_id) throw new Error('sub_workflow: workflow_id required');
    // Recursion guard: walk parent chain via state.depth. dispatchCount is
    // per-runId so it doesn't catch cross-run recursion — depth does.
    const parentRun = await wfDb.getRun(deps.db, runId);
    const depth = (parentRun && parentRun.state && parentRun.state.depth) || 0;
    if (depth >= MAX_SUB_WORKFLOW_DEPTH) {
      throw new Error(`sub_workflow: max nesting depth (${MAX_SUB_WORKFLOW_DEPTH}) exceeded`);
    }
    const child = await wfDb.getWorkflow(deps.db, node.workflow_id);
    if (!child) throw new Error(`sub_workflow: workflow ${node.workflow_id} not found`);
    const childInputs = {};
    for (const [k, expr] of Object.entries(node.inputs_map || {})) {
      const sb = vm.createContext({ ...ctx });
      try { childInputs[k] = vm.runInContext(expr, sb, { timeout: 200 }); }
      catch (e) { throw new Error(`sub_workflow: inputs_map.${k}: ${e.message}`); }
    }
    const childRun = await wfDb.createRun(deps.db, {
      workflowId: child.id, snapshot: child.definition,
      state: { inputs: childInputs, parent_run_id: runId, parent_node_id: node.id, depth: depth + 1 },
    });
    // Register parent link BEFORE running so a cancel(parentRunId) that
    // arrives mid-child-run still propagates (vt-0118 P1).
    runParents.set(childRun.id, runId);
    // If the parent is already cancelled by the time we enter the child run,
    // mark the child cancelled up-front so the runner exits at the first
    // cancellation check.
    if (cancelled.has(runId)) cancelled.add(childRun.id);
    deps.broadcast(runId, { type: 'sub_workflow_started', run_id: runId, node_id: node.id, child_run_id: childRun.id });
    // Use the PUBLIC runToCompletion so finally{} cleans cancelled +
    // dispatchCount entries for the child run (vt-0118 P2 leak fix).
    try {
      await runToCompletion(childRun.id);
    } finally {
      runParents.delete(childRun.id);
    }
    const finalRun = await wfDb.getRun(deps.db, childRun.id);
    if (!finalRun) {
      throw new Error('sub_workflow ended with status=missing');
    }
    // Propagate cancellation as a 'cancelled' error so the main while-loop
    // routes the parent to 'cancelled' status (not 'failed'). vt-0118.
    if (finalRun.status === 'cancelled') {
      throw new Error('cancelled');
    }
    if (finalRun.status !== 'done') {
      throw new Error(`sub_workflow ended with status=${finalRun.status}`);
    }
    return {
      output: `sub_workflow ${child.name} done`,
      exit_code: 0,
      child_run_id: childRun.id,
      outputs: (finalRun.state && finalRun.state.outputs) || {},
    };
  }

  // wait_for_approval: suspends the run until POST /workflow-runs/:id/
  // approvals/:node_id decides. Persisted in fleet_workflow_pending_approvals
  // so a hub restart can resume on next poll. Edges out of this node MUST be
  // labelled 'approve' and 'reject'.
  async function execWaitForApproval(node, ctx, runId) {
    const reason = substituteTemplates(node.reason || '', ctx);
    await wfDb.createPendingApproval(deps.db, { runId, nodeId: node.id, reason });
    deps.broadcast(runId, { type: 'approval_requested', run_id: runId, node_id: node.id, reason });
    const timeoutMs = Math.max(0, (node.timeout_s || 86400) * 1000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cancelled.has(runId)) throw new Error('cancelled');
      const row = await wfDb.getPendingApproval(deps.db, runId, node.id);
      if (row && row.decision) {
        return {
          output: row.decision,
          exit_code: row.decision === 'approve' ? 0 : 1,
          decision: row.decision,
          decided_by: row.decided_by,
          note: row.note,
        };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`wait_for_approval: timeout after ${node.timeout_s || 86400}s`);
  }

  // wait_for_event: suspends until POST /workflow-events fires the named event.
  async function execWaitForEvent(node, ctx, runId) {
    if (!node.event_name) throw new Error('wait_for_event: event_name required');
    await wfDb.createPendingEvent(deps.db, { runId, nodeId: node.id, eventName: node.event_name });
    deps.broadcast(runId, { type: 'event_waiting', run_id: runId, node_id: node.id, event_name: node.event_name });
    const timeoutMs = Math.max(0, (node.timeout_s || 86400) * 1000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cancelled.has(runId)) throw new Error('cancelled');
      const row = await wfDb.getPendingEvent(deps.db, runId, node.id);
      if (row && row.fired_at) {
        return {
          output: `event ${node.event_name} fired`,
          exit_code: 0,
          payload: row.payload,
        };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`wait_for_event: timeout waiting for ${node.event_name}`);
  }

  // Unified dispatcher — used by both the main while-loop and by retry/for_each
  // when they execute their inner node. Recursion is depth-limited via
  // dispatchCount; cancellation is checked at every dispatch.
  async function dispatchNode(node, ctx, runId) {
    const n = (dispatchCount.get(runId) || 0) + 1;
    if (n > MAX_DISPATCHES_PER_RUN) {
      throw new Error(`run ${runId} exceeded ${MAX_DISPATCHES_PER_RUN} dispatches — recursion guard`);
    }
    dispatchCount.set(runId, n);
    if (cancelled.has(runId)) throw new Error('cancelled');
    switch (node.type) {
      case 'claude':       return await execClaude(node, ctx, runId);
      case 'branch':       return execBranch(node, ctx);
      case 'delay':        return await execDelay(node, runId);
      case 'transform':    return execTransform(node, ctx);
      case 'http_request': return await execHttpRequest(node, ctx, runId);
      case 'notify':       return await execNotify(node, ctx, runId);
      case 'set_variable': return execSetVariable(node, ctx);
      case 'fan_out':      return await execFanOut(node, ctx, runId);
      case 'aggregate':    return execAggregate(node, ctx);
      case 'assert':       return execAssert(node, ctx, runId);
      case 'log':          return execLog(node, ctx, runId);
      case 'retry':        return await execRetry(node, ctx, runId);
      case 'for_each':     return await execForEach(node, ctx, runId);
      case 'sub_workflow': return await execSubWorkflow(node, ctx, runId);
      case 'wait_for_approval': return await execWaitForApproval(node, ctx, runId);
      case 'wait_for_event':    return await execWaitForEvent(node, ctx, runId);
      default: throw new Error(`unknown node type: ${node.type}`);
    }
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
      dispatchCount.delete(runId);
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
        result = await dispatchNode(node, ctxData, runId);
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

      let labelHint;
      if (node.type === 'branch')             labelHint = result.result ? 'then' : 'else';
      else if (node.type === 'wait_for_approval') labelHint = result.decision; // 'approve' | 'reject'
      current = nextNode(current, def, labelHint);
    }

    await wfDb.updateRunStatus(deps.db, runId, 'done');
    deps.broadcast(runId, { type: 'run_state', run_id: runId, status: 'done' });
  }

  function cancel(runId) {
    cancelled.add(runId);
    // Walk runParents to mark every descendant run cancelled too — otherwise
    // sub_workflow children keep burning tokens after a parent abort (P1).
    for (const [child, parent] of runParents) {
      let p = parent;
      // Bounded by MAX_SUB_WORKFLOW_DEPTH to avoid pathological chain loops.
      for (let i = 0; i < MAX_SUB_WORKFLOW_DEPTH + 1 && p; i++) {
        if (p === runId) { cancelled.add(child); break; }
        p = runParents.get(p);
      }
    }
    const ctrl = activeControllers.get(runId);
    if (ctrl) try { ctrl.abort(); } catch {}
    // Abort every in-flight fan_out child too.
    const fo = fanOutControllers.get(runId);
    if (fo) for (const c of fo) { try { c.abort(); } catch {} }
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
