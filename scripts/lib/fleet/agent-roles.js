'use strict';
// vt-0287: extracted from fleet-routes.js — agent-roles endpoints
// (vt-0259/0264/0267/0271/0284). Includes:
//  * CRUD on /fleet/agent-roles (admin gated by outer isAdminPath)
//  * GET returns redacted shape for viewer bearer (vt-0267)
//  * Group→role assignment + reorder + delete
//  * Combined-prompt size cap (vt-0264)
//  * Tool-name whitelist (vt-0284)

const crypto = require('node:crypto');
const { SID_RE, send, readBody } = require('./_shared');

function register({ fleetDb, checkAdminAuth, validateAllowedToolsField }) {
  return [
    // GET /fleet/agent-roles — viewer-summary or admin-full
    {
      method: 'GET',
      pattern: /^\/fleet\/agent-roles$/,
      handler(req, res, ctx) {
        const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
        const fn = isAdmin ? fleetDb.listAgentRoles : fleetDb.listAgentRolesSummary;
        return fn(ctx.db).then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },

    // POST /fleet/agent-roles — create
    {
      method: 'POST',
      pattern: /^\/fleet\/agent-roles$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (b) => {
          if (!b) return send(res, 422, { error: 'body required' });
          if (!b.name || typeof b.name !== 'string' || b.name.length > 64) {
            return send(res, 422, { error: 'name required (string, <=64 chars)' });
          }
          if (!b.prompt || typeof b.prompt !== 'string') {
            return send(res, 422, { error: 'prompt required (string)' });
          }
          if (b.prompt.length > 32768) return send(res, 422, { error: 'prompt too long (max 32768 chars)' });
          try { validateAllowedToolsField(b.allowed_tools); }
          catch (e) { return send(res, e.statusCode || 422, { error: e.message }); }
          try {
            const r = await fleetDb.createAgentRole(ctx.db, {
              name: b.name, description: b.description, prompt: b.prompt,
              default_model: b.default_model, allowed_tools: b.allowed_tools,
            });
            send(res, 201, r);
          } catch (e) {
            if (/duplicate key|unique/i.test(e.message)) return send(res, 409, { error: 'name already exists' });
            send(res, 500, { error: e.message });
          }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },

    // GET /fleet/agent-roles/:id — admin → full, viewer → redacted
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/agent-roles/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, match) {
        const id = match[1];
        const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
        return fleetDb.getAgentRole(ctx.db, id).then(r => {
          if (!r) return send(res, 404, { error: 'role not found' });
          if (isAdmin) return send(res, 200, r);
          const summary = {
            ...r,
            prompt_bytes: Buffer.byteLength(r.prompt || '', 'utf8'),
            prompt_sha: crypto.createHash('sha256').update(r.prompt || '').digest('hex'),
          };
          delete summary.prompt;
          send(res, 200, summary);
        }).catch(e => send(res, 500, { error: e.message }));
      },
    },

    // PATCH /fleet/agent-roles/:id
    {
      method: 'PATCH',
      pattern: new RegExp(`^/fleet/agent-roles/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, match) {
        const id = match[1];
        return readBody(req).then(async (b) => {
          if (!b) return send(res, 422, { error: 'body required' });
          if (b.prompt !== undefined && (typeof b.prompt !== 'string' || b.prompt.length > 32768)) {
            return send(res, 422, { error: 'prompt invalid (string, <=32768)' });
          }
          if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 64)) {
            return send(res, 422, { error: 'name invalid' });
          }
          try { validateAllowedToolsField(b.allowed_tools); }
          catch (e) { return send(res, e.statusCode || 422, { error: e.message }); }
          const r = await fleetDb.updateAgentRole(ctx.db, id, b);
          r ? send(res, 200, r) : send(res, 404, { error: 'role not found' });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },

    // DELETE /fleet/agent-roles/:id
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/agent-roles/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, match) {
        const id = match[1];
        return fleetDb.deleteAgentRole(ctx.db, id).then(() => send(res, 204, {}))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },

    // GET /fleet/groups/:id/roles — list assigned roles (redacted for viewer)
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/roles$`, 'i'),
      handler(req, res, ctx, match) {
        const id = match[1];
        const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
        return fleetDb.listGroupRoles(ctx.db, id).then(rs => {
          if (!isAdmin) {
            for (const r of rs) {
              r.prompt_bytes = Buffer.byteLength(r.prompt || '', 'utf8');
              r.prompt_sha = crypto.createHash('sha256').update(r.prompt || '').digest('hex');
              delete r.prompt;
            }
          }
          send(res, 200, rs);
        }).catch(e => send(res, 500, { error: e.message }));
      },
    },

    // PUT /fleet/groups/:id/roles — atomic batch reorder
    {
      method: 'PUT',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/roles$`, 'i'),
      handler(req, res, ctx, match) {
        const groupId = match[1];
        return readBody(req).then(async (b) => {
          if (!b) return send(res, 422, { error: 'body required' });
          if (!Array.isArray(b.role_ids)) return send(res, 422, { error: 'role_ids array required' });
          if (b.role_ids.length > 8) return send(res, 422, { error: 'max 8 roles per group' });
          for (const rid of b.role_ids) {
            const r = await fleetDb.getAgentRole(ctx.db, rid);
            if (!r) return send(res, 404, { error: `role not found: ${rid}` });
          }
          await fleetDb.reorderGroupRoles(ctx.db, groupId, b.role_ids);
          send(res, 200, { group_id: groupId, role_ids: b.role_ids });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },

    // POST /fleet/groups/:id/roles — assign with cap check
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/roles$`, 'i'),
      handler(req, res, ctx, match) {
        const groupId = match[1];
        return readBody(req).then(async (b) => {
          if (!b) return send(res, 422, { error: 'body required' });
          if (!b.role_id) return send(res, 422, { error: 'role_id required' });
          const role = await fleetDb.getAgentRole(ctx.db, b.role_id);
          if (!role) return send(res, 404, { error: 'role not found' });
          const grp = await fleetDb.getGroup(ctx.db, groupId);
          if (!grp) return send(res, 404, { error: 'group not found' });
          const MAX_ROLES_PER_GROUP = 8;
          const MAX_COMBINED_BYTES  = 65536;
          const existing = await fleetDb.listGroupRoles(ctx.db, groupId);
          if (existing.some(r => r.id === b.role_id)) {
            // re-assign: skip cap (position update only)
          } else if (existing.length >= MAX_ROLES_PER_GROUP) {
            return send(res, 422, { error: `group already has ${MAX_ROLES_PER_GROUP} roles (max)` });
          } else {
            const brainBytes = Buffer.byteLength(grp.brain_prompt || '', 'utf8');
            const existingBytes = existing.reduce((sum, r) => sum + Buffer.byteLength(r.prompt || '', 'utf8'), 0);
            const newBytes = Buffer.byteLength(role.prompt || '', 'utf8');
            const headroom = 4096;
            const total = brainBytes + existingBytes + newBytes + headroom;
            if (total > MAX_COMBINED_BYTES) {
              return send(res, 422, {
                error: `combined prompt would exceed ${MAX_COMBINED_BYTES} bytes (current ${brainBytes + existingBytes}, role adds ${newBytes}, +${headroom} headroom)`,
              });
            }
          }
          await fleetDb.assignRoleToGroup(ctx.db, groupId, b.role_id,
            Number.isFinite(b.position) ? b.position : 0);
          send(res, 201, { group_id: groupId, role_id: b.role_id });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },

    // DELETE /fleet/groups/:id/roles/:roleId — unassign
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/groups/(${SID_RE})/roles/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, match) {
        const groupId = match[1];
        const roleId  = match[2];
        return fleetDb.unassignRoleFromGroup(ctx.db, groupId, roleId)
          .then(() => send(res, 204, {}))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },

    // vt-0370 (epic vt-0369): per-host role assignment. Mirrors the
    // group routes above. Group roles REPLACE host roles at spawn time
    // (see fleetDb.resolveEffectiveRoles + sql/030-fleet-host-roles.sql).
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/roles$`, 'i'),
      // GET is viewer-readable per the admin:false override; prompts
      // are redacted for viewer by listAgentRoles itself in vt-0267.
      admin: false,
      handler(req, res, ctx, match) {
        const hostId = match[1];
        return fleetDb.listHostRoles(ctx.db, hostId)
          .then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/roles$`, 'i'),
      handler(req, res, ctx, match) {
        const hostId = match[1];
        return readBody(req).then(async (b) => {
          if (!b) return send(res, 422, { error: 'body required' });
          if (!b.role_id) return send(res, 422, { error: 'role_id required' });
          const role = await fleetDb.getAgentRole(ctx.db, b.role_id);
          if (!role) return send(res, 404, { error: 'role not found' });
          const host = await fleetDb.getHost(ctx.db, hostId);
          if (!host) return send(res, 404, { error: 'host not found' });
          // Same caps as group roles. Host has no brain_prompt of its own
          // (that lives on the group), so the budget is roles-only.
          const MAX_ROLES_PER_HOST = 8;
          const MAX_COMBINED_BYTES = 65536;
          const existing = await fleetDb.listHostRoles(ctx.db, hostId);
          if (existing.some(r => r.id === b.role_id)) {
            // re-assign: skip cap (position update only)
          } else if (existing.length >= MAX_ROLES_PER_HOST) {
            return send(res, 422, { error: `host already has ${MAX_ROLES_PER_HOST} roles (max)` });
          } else {
            const existingBytes = existing.reduce((s, r) => s + Buffer.byteLength(r.prompt || '', 'utf8'), 0);
            const newBytes = Buffer.byteLength(role.prompt || '', 'utf8');
            const headroom = 4096;
            if (existingBytes + newBytes + headroom > MAX_COMBINED_BYTES) {
              return send(res, 422, {
                error: `combined prompt would exceed ${MAX_COMBINED_BYTES} bytes (current ${existingBytes}, role adds ${newBytes}, +${headroom} headroom)`,
              });
            }
          }
          await fleetDb.assignRoleToHost(ctx.db, hostId, b.role_id,
            Number.isFinite(b.position) ? b.position : 0);
          send(res, 201, { host_id: hostId, role_id: b.role_id });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/roles/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, match) {
        const hostId = match[1];
        const roleId = match[2];
        return fleetDb.unassignRoleFromHost(ctx.db, hostId, roleId)
          .then(() => send(res, 204, {}))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      // GET resolved effective roles — for the UI to render what WILL
      // actually be applied at spawn (group-replaces-host). Useful for
      // the pixel-office role-badge that needs to show the effective
      // role, not just the locally-assigned one.
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/roles/effective$`, 'i'),
      admin: false,
      handler(req, res, ctx, match) {
        const hostId = match[1];
        return fleetDb.resolveEffectiveRoles(ctx.db, hostId)
          .then(rs => send(res, 200, rs))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
