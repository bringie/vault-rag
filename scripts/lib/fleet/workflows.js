'use strict';
// vt-0287 slice 3: workflow CRUD + run dispatch + approval/event/trigger
// endpoints. The biggest of the remaining slices. Stateful pieces that
// must live in fleet-routes.js are passed through deps:
//   - ensureWorkflowRunner(ctx)       — closes over runner + spawnClaude
//   - checkWorkflowConcurrency(ctx)   — uses WORKFLOW_MAX_CONCURRENT const
// The audit + defSha helpers move with the routes (no closure state).

const crypto = require('node:crypto');
const log = require('../log').for('fleet/workflows');
const { SID_RE, send, readBody } = require('./_shared');

// workflow_audit helper. Mirrors auditSecret in rag-api.js — best-effort
// insert, never blocks response or surfaces DB errors to the client.
async function auditWorkflow(ctx, req, callerFp, { op, workflow_id = null, run_id = null, outcome = 'ok', definition_sha = null, detail = {}, via = 'http' }) {
  if (!ctx.db) return;
  try {
    await ctx.db.query(
      `INSERT INTO workflow_audit (op, workflow_id, run_id, caller_id, via, outcome, definition_sha, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [op, workflow_id, run_id, callerFp(req), via, outcome, definition_sha, JSON.stringify(detail)]
    );
  } catch (e) {
    log.error('workflow_audit_insert_failed', { op, msg: e.message });
  }
}
function defSha(def) {
  if (!def) return null;
  try { return crypto.createHash('sha256').update(JSON.stringify(def)).digest('hex'); } catch { return null; }
}

function register({ fleetWorkflowDb: wfDb, validateDefinition, callerFp, ensureWorkflowRunner, checkWorkflowConcurrency }) {
  const audit = (ctx, req, args) => auditWorkflow(ctx, req, callerFp, args);

  return [
    // ---- workflow CRUD ----
    {
      method: 'GET',
      pattern: /^\/fleet\/workflows$/,
      handler(req, res, ctx) {
        return wfDb.listWorkflows(ctx.db).then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/workflows$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (b) => {
          if (!b || !b.name || !b.definition) {
            await audit(ctx, req, { op: 'create', outcome: 'denied', detail: { reason: 'validation' } });
            return send(res, 422, { error: 'name + definition required' });
          }
          try { validateDefinition(b.definition); }
          catch (e) {
            await audit(ctx, req, { op: 'create', outcome: 'denied', detail: { reason: e.message } });
            return send(res, 422, { error: e.message });
          }
          try {
            const w = await wfDb.createWorkflow(ctx.db, b);
            await audit(ctx, req, { op: 'create', workflow_id: w.id, definition_sha: defSha(b.definition), detail: { name: b.name } });
            send(res, 201, w);
          } catch (e) {
            await audit(ctx, req, { op: 'create', outcome: 'error', detail: { msg: e.message } });
            if (/duplicate key/.test(e.message)) return send(res, 409, { error: 'name exists' });
            send(res, 500, { error: e.message });
          }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/workflows/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return wfDb.getWorkflow(ctx.db, m[1]).then(w =>
          w ? send(res, 200, w) : send(res, 404, { error: 'not found' })
        ).catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/fleet/workflows/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        const id = m[1];
        return readBody(req).then(async (b) => {
          if (b && b.definition) {
            try { validateDefinition(b.definition); }
            catch (e) {
              await audit(ctx, req, { op: 'patch', workflow_id: id, outcome: 'denied', detail: { reason: e.message } });
              return send(res, 422, { error: e.message });
            }
          }
          const expectedVersion = b && Number.isFinite(b.expected_version) ? b.expected_version : undefined;
          const w = await wfDb.updateWorkflow(ctx.db, id, b || {}, expectedVersion);
          if (!w) {
            await audit(ctx, req, { op: 'patch', workflow_id: id, outcome: 'denied', detail: { reason: 'not_found' } });
            return send(res, 404, { error: 'not found' });
          }
          if (w.__conflict) {
            await audit(ctx, req, { op: 'patch', workflow_id: id, outcome: 'denied', detail: { reason: 'version_conflict' } });
            return send(res, 409, { error: 'version conflict', current: w.current });
          }
          await audit(ctx, req, { op: 'patch', workflow_id: id, definition_sha: defSha(w.definition) });
          send(res, 200, w);
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/workflows/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        const id = m[1];
        return wfDb.deleteWorkflow(ctx.db, id).then(async r => {
          if (!r.deleted) {
            await audit(ctx, req, { op: 'delete', workflow_id: id, outcome: 'denied', detail: { reason: r.reason || 'not_found' } });
            return send(res, 409, { error: r.reason || 'not found or already deleted' });
          }
          await audit(ctx, req, { op: 'delete', workflow_id: id });
          res.writeHead(204); res.end();
        }).catch(e => send(res, 500, { error: e.message }));
      },
    },

    // ---- run dispatch ----
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/workflows/(${SID_RE})/run$`, 'i'),
      handler(req, res, ctx, m) {
        const id = m[1];
        return readBody(req).then(async (b) => {
          const w = await wfDb.getWorkflow(ctx.db, id);
          if (!w) {
            await audit(ctx, req, { op: 'run', workflow_id: id, outcome: 'denied', detail: { reason: 'not_found' } });
            return send(res, 404, { error: 'workflow not found' });
          }
          const gate = await checkWorkflowConcurrency(ctx);
          if (!gate.ok) {
            await audit(ctx, req, { op: 'run', workflow_id: w.id, outcome: 'denied',
              detail: { reason: 'concurrency_cap', active: gate.active, cap: gate.cap } });
            return send(res, 429, {
              error: `workflow concurrency cap reached (${gate.active}/${gate.cap})`,
              active: gate.active, cap: gate.cap,
              retry_after_seconds: 60,
            });
          }
          const runner = await ensureWorkflowRunner(ctx);
          const run = await wfDb.createRun(ctx.db, {
            workflowId: w.id,
            snapshot: w.definition,
            state: { inputs: (b && b.inputs) || {} },
          });
          await audit(ctx, req, { op: 'run', workflow_id: w.id, run_id: run.id, definition_sha: defSha(w.definition) });
          if (runner) runner.start(run.id);
          send(res, 201, { run_id: run.id });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^/fleet/workflows/(${SID_RE})/trigger$`, 'i'),
      handler(req, res, ctx, m) {
        const id = m[1];
        return readBody(req).then(async (b) => {
          const trigger = b && Object.keys(b).length ? b : null;
          if (trigger && trigger.every_ms != null) {
            const ms = Number(trigger.every_ms);
            if (!Number.isFinite(ms) || ms < 60000) {
              return send(res, 422, { error: 'every_ms must be a number ≥ 60000' });
            }
          }
          await wfDb.setWorkflowTrigger(ctx.db, id, trigger);
          await audit(ctx, req, { op: trigger ? 'trigger_set' : 'trigger_clear', workflow_id: id, detail: trigger || {} });
          send(res, 200, { ok: true, trigger });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },

    // ---- runs ----
    {
      method: 'GET',
      pattern: /^\/fleet\/workflow-runs$/,
      handler(req, res, ctx) {
        const u = new URL(req.url, 'http://x');
        return wfDb.listRuns(ctx.db, {
          workflowId: u.searchParams.get('workflow_id') || undefined,
          status: u.searchParams.get('status') || undefined,
          limit: parseInt(u.searchParams.get('limit') || '100', 10),
        }).then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/workflow-runs/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return wfDb.getRun(ctx.db, m[1]).then(r =>
          r ? send(res, 200, r) : send(res, 404, { error: 'not found' })
        ).catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/workflow-runs/(${SID_RE})/cancel$`, 'i'),
      handler(req, res, ctx, m) {
        const id = m[1];
        return ensureWorkflowRunner(ctx).then(async (runner) => {
          if (runner) runner.cancel(id);
          await audit(ctx, req, { op: 'cancel', run_id: id });
          send(res, 200, { ok: true });
        }).catch(e => send(res, 500, { error: e.message }));
      },
    },

    // ---- approvals + events ----
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/workflow-runs/(${SID_RE})/approvals/([\\w.-]+)$`, 'i'),
      handler(req, res, ctx, m) {
        const runId = m[1];
        const nodeId = m[2];
        return readBody(req).then(async (b) => {
          if (!b || !['approve', 'reject'].includes(b.decision)) {
            return send(res, 422, { error: 'decision must be approve or reject' });
          }
          const row = await wfDb.recordApprovalDecision(ctx.db, runId, nodeId, {
            decision: b.decision, decided_by: b.by, note: b.note,
          });
          if (!row) {
            await audit(ctx, req, { op: b.decision, run_id: runId, outcome: 'denied', detail: { node: nodeId, reason: 'already_decided' } });
            return send(res, 409, { error: 'no pending approval matches (already decided?)' });
          }
          await audit(ctx, req, { op: b.decision, run_id: runId, detail: { node: nodeId, by: b.by } });
          send(res, 200, row);
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: /^\/fleet\/workflow-pending-approvals$/,
      handler(req, res, ctx) {
        return wfDb.listPendingApprovals(ctx.db).then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/workflow-events$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (b) => {
          if (!b || !b.name) return send(res, 422, { error: 'name required' });
          const n = await wfDb.fireEvent(ctx.db, b.name, b.payload);
          await audit(ctx, req, { op: 'fire_event', detail: { name: b.name, fired: n } });
          send(res, 200, { fired: n });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
