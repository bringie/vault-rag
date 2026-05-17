'use strict';
// vt-0347: aggregated read-only export of all declarative fleet state.
// Single round-trip for IaaC tooling that wants to diff current vs
// desired before issuing per-resource PATCH/POST/DELETE calls.
//
// Admin-only (since output includes webhook secrets + agent-role
// prompts in clear). Outer isAdminPath gate is GET → false (viewer
// default), so we explicitly check checkAdminAuth here.

const { send } = require('./_shared');

function register({ fleetDb, fleetWorkflowDb, checkAdminAuth }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/config\/export$/,
      async handler(req, res, ctx) {
        if (!checkAdminAuth(req, ctx)) {
          return send(res, 403, { error: 'admin bearer required (config bundle contains secrets)' });
        }
        try {
          const [hosts, groups, roles, prices, features, webhooks, workflows] = await Promise.all([
            fleetDb.listHosts(ctx.db).then(rs => rs.map(h => ({
              id: h.id,
              name: h.name,
              display_name: h.display_name,
              capabilities: h.capabilities || [],
              installed_backends: h.installed_backends || null,
            }))),
            fleetDb.listGroups(ctx.db),
            fleetDb.listAgentRoles(ctx.db),
            fleetDb.listPrices ? fleetDb.listPrices(ctx.db) : (async () => {
              const { rows } = await ctx.db.query(
                `SELECT id, match_pattern, priority, valid_from,
                        input_per_mtok, output_per_mtok,
                        cache_create_per_mtok, cache_read_per_mtok,
                        flagged, note, created_at
                 FROM fleet_model_prices
                 WHERE deleted_at IS NULL
                 ORDER BY priority DESC, valid_from DESC`);
              return rows;
            })(),
            fleetDb.listFeatures(ctx.db),
            fleetDb.listWebhooks(ctx.db),
            fleetWorkflowDb.listWorkflows(ctx.db),
          ]);

          // Enrich groups with their roster (host_ids + role_ids) so a
          // re-apply can reconstruct membership without N extra requests.
          const groupsEnriched = await Promise.all(groups.map(async (g) => {
            const [hostMembers, roleMembers] = await Promise.all([
              fleetDb.listHostsInGroup(ctx.db, g.id).catch(() => []),
              fleetDb.listGroupRoles(ctx.db, g.id).catch(() => []),
            ]);
            return {
              ...g,
              host_ids: hostMembers.map(h => h.id),
              role_ids: roleMembers.map(r => r.id),
            };
          }));

          send(res, 200, {
            version: 1,
            exported_at: new Date().toISOString(),
            hosts,
            groups: groupsEnriched,
            agent_roles: roles,
            prices,
            features,
            webhooks,
            workflows: workflows.map(w => ({
              id: w.id, name: w.name, description: w.description,
              definition: w.definition, version: w.version,
              trigger: w.trigger || null,
            })),
          });
        } catch (e) {
          send(res, 500, { error: e.message });
        }
      },
    },
  ];
}

module.exports = { register };
