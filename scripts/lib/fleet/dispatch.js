'use strict';
// vt-0287 slice 9: dispatch + exec — the last big inline handlers in
// fleet-routes.js. Despite the earlier "stateful" label, both reach
// shared services (db/bus/tokmonDb) through req-ctx; the only module
// deps are fleetDb, fleetCost, stripAnsi, STRUCTURED_SPAWN_FIELDS, log.
//
// Routes:
//   POST /fleet/dispatch  — fan-out spawn with structured fields +
//                           group brain_prompt + role composition + ARG_MAX cap
//   POST /fleet/exec      — synchronous claude --print, returns transcript

// vt-0353: STRUCTURED_SPAWN_FIELDS + stripAnsi moved into _shared.js so
// dispatch.js no longer has to require sibling sub-modules.
const { send, readBody, STRUCTURED_SPAWN_FIELDS, stripAnsi } = require('./_shared');
const log = require('../log').for('fleet/dispatch');

// vt-0133: cap concurrent exec sessions per host. Without this, 100 parallel
// /fleet/exec POSTs pin every host to its slowest task, each holding a
// session row + viewer hook + 600s default timeout = OOM + fd exhaustion.
const MAX_EXEC_PER_HOST = Math.max(1, parseInt(
  process.env.VAULT_RAG_FLEET_EXEC_MAX_PER_HOST || '5', 10));

// ARG_MAX on Linux is ~128 KiB; daemon spawn argv carries system_prompt
// as a single argument (--append-system-prompt). Cap at 96 KiB so other
// argv (--model, --allowed-tools …) still fits.
const MAX_DISPATCH_SYSTEM_PROMPT_BYTES = 96 * 1024;

function register({ fleetDb, fleetCost }) {
  return [
    {
      // Synchronous "ask claude on host X" — spawns claude --print, waits for
      // exit, returns transcript text + cost.
      method: 'POST',
      pattern: /^\/fleet\/exec$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          if (!body) return send(res, 422, { error: 'body required' });
          const { tag, host_name, host_id, prompt, model, timeout_ms, cwd } = body;
          if (!prompt || typeof prompt !== 'string') return send(res, 422, { error: 'prompt (string) required' });
          if (!tag && !host_name && !host_id) {
            return send(res, 422, { error: 'one of tag|host_name|host_id required' });
          }
          try {
            const all = await fleetDb.listHosts(ctx.db);
            let candidates = all.filter(h => h.status === 'online');
            if (host_id)   candidates = candidates.filter(h => h.id === host_id);
            if (host_name) candidates = candidates.filter(h => h.name === host_name || h.display_name === host_name);
            if (tag) {
              const tagged = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
              const ids = new Set(tagged.map(h => h.id));
              candidates = candidates.filter(h => ids.has(h.id));
            }
            if (!candidates.length) return send(res, 404, { error: 'no online host matches' });
            const sessions = await fleetDb.listSessions(ctx.db, { status: 'running' });
            const busyByHost = {};
            for (const s of sessions) busyByHost[s.host_id] = (busyByHost[s.host_id] || 0) + 1;
            candidates.sort((a, b) => (busyByHost[a.id] || 0) - (busyByHost[b.id] || 0));
            const host = candidates[0];
            if ((busyByHost[host.id] || 0) >= MAX_EXEC_PER_HOST) {
              res.setHeader('retry-after', '5');
              return send(res, 429, {
                error: `host ${host.name} at capacity (${busyByHost[host.id]} running, cap ${MAX_EXEC_PER_HOST})`,
                retry_after_seconds: 5,
              });
            }

            const args = ['--print'];
            if (model) args.push('--model', String(model));
            args.push(prompt);
            const s = await fleetDb.createSession(ctx.db, {
              hostId: host.id, cwd: cwd || '~',
              args, env: {},
              createdBy: 'exec',
              label: prompt.slice(0, 80),
              metadata: { exec: true },
            });
            if (!ctx.bus.requestSpawn(host.id, { session_id: s.id, cwd: s.cwd, args: s.args, env: {} })) {
              return send(res, 502, { error: 'daemon vanished mid-dispatch' });
            }
            // Subscribe to session_exit. Plain Promise executor (no async) and a
            // single unsubscribe() closure so the hook is freed on every
            // resolution path — including orphan reconciliation and spawn_err
            // (which both emit session_exit to viewers, see handleDaemonWs).
            // N7 (audit): coerce timeout_ms safely — parseInt("abc") → NaN
            // propagates through Math.min/max → setTimeout(NaN) ≈ 0ms = instant.
            const rawTimeout = Number.parseInt(timeout_ms, 10);
            const TIMEOUT = Math.min(Math.max(Number.isFinite(rawTimeout) ? rawTimeout : 120000, 5000), 600000);
            let unsubscribed = false;
            let timeoutHandle = null;
            let handler = null;
            const result = await new Promise((resolve) => {
              const cleanup = () => {
                if (unsubscribed) return;
                unsubscribed = true;
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (handler) ctx.bus.unsubscribeViewerHook(s.id, handler);
              };
              handler = (frame) => {
                if (frame.type === 'session_exit') {
                  cleanup();
                  resolve({ exitCode: frame.exit_code });
                }
              };
              ctx.bus.subscribeViewerHook(s.id, handler);
              timeoutHandle = setTimeout(() => {
                cleanup();
                ctx.bus.sendKill(s.id, host.id, 'SIGTERM');
                resolve({ exitCode: -1, timeout: true });
              }, TIMEOUT);
              timeoutHandle.unref?.();
            });
            // Read transcript (batcher flush already triggered by session_exit)
            const rows = await fleetDb.readTranscript(ctx.db, s.id, { sinceSeq: 0, kind: 'pty_out' });
            const raw = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8');
            const text = stripAnsi(raw);
            let cost = null;
            if (ctx.tokmonDb) {
              try { cost = await fleetCost.sessionCost(ctx.tokmonDb, ctx.db, host.name, s.started_at, new Date(), s.id); }
              catch {}
            }
            send(res, 200, {
              session_id: s.id,
              host_id: host.id, host_name: host.name, display_name: host.display_name,
              exit_code: result.exitCode,
              timeout: !!result.timeout,
              output: text,
              cost,
            });
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/dispatch$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (body) => {
          if (!body) return send(res, 422, { error: 'body required' });
          const { tag, group, host_name, host_id, cwd, args, env, label, metadata } = body;
          if (!tag && !group && !host_name && !host_id) {
            return send(res, 422, { error: 'one of tag|group|host_name|host_id required' });
          }
          try {
            const all = await fleetDb.listHosts(ctx.db);
            let candidates = all.filter(h => h.status === 'online');
            if (host_id)   candidates = candidates.filter(h => h.id === host_id);
            if (host_name) candidates = candidates.filter(h => h.name === host_name || h.display_name === host_name);
            if (tag) {
              // Effective tag: direct h.capabilities ∪ any group's labels.
              const tagged = await fleetDb.listHostsByEffectiveTag(ctx.db, tag);
              const ids = new Set(tagged.map(h => h.id));
              candidates = candidates.filter(h => ids.has(h.id));
            }
            // vt-0151: hold the group record so we can inject its brain_prompt below.
            let resolvedGroup = null;
            if (group) {
              resolvedGroup = await fleetDb.getGroupByName(ctx.db, group);
              if (!resolvedGroup) return send(res, 404, { error: `group not found: ${group}` });
              const members = await fleetDb.listHostsInGroup(ctx.db, resolvedGroup.id);
              const ids = new Set(members.map(h => h.id));
              candidates = candidates.filter(h => ids.has(h.id));
            }
            if (!candidates.length) return send(res, 404, { error: 'no online host matches the criteria' });
            // Pick least-busy (running sessions ascending) — small UX win.
            const sessions = await fleetDb.listSessions(ctx.db, { status: 'running' });
            const busyByHost = {};
            for (const s of sessions) busyByHost[s.host_id] = (busyByHost[s.host_id] || 0) + 1;
            candidates.sort((a, b) => (busyByHost[a.id] || 0) - (busyByHost[b.id] || 0));
            const host = candidates[0];

            // vt-0151/vt-0169: structured spawn fields coerced to safe types
            // before forwarding. `dangerous` → boolean; allowed_tools → string[]
            // capped per-element; prompt/model/system_prompt → strings only.
            const structured = {};
            for (const k of STRUCTURED_SPAWN_FIELDS) {
              if (body[k] == null) continue;
              if (k === 'dangerous') structured[k] = Boolean(body[k]);
              else if (k === 'allowed_tools') {
                // vt-0266/vt-0271: array of short strings, sanitize per element.
                // An explicit empty array IS valid intent (= "deny all tools").
                if (Array.isArray(body[k])) {
                  structured[k] = body[k].filter(t => typeof t === 'string' && t.length <= 64);
                }
              }
              else if (typeof body[k] === 'string' || typeof body[k] === 'number') structured[k] = body[k];
              // silently drop objects/arrays for string-typed fields
            }
            if (resolvedGroup && resolvedGroup.brain_prompt) {
              structured.system_prompt = structured.system_prompt
                ? `${resolvedGroup.brain_prompt}\n\n${structured.system_prompt}`
                : resolvedGroup.brain_prompt;
            }
            // vt-0259/vt-0264: prepend assigned role prompts (ordered by
            // position) to the system_prompt. Roles compose with brain_prompt:
            // <brain>\n\n<role1>\n\n<role2>\n\n<per-call>. The assignment-time
            // cap (≤8 roles, ≤64 KiB) prevents most bloat; the ARG_MAX trim
            // below is the belt-and-suspenders.
            let appliedRoleNames = [];
            if (resolvedGroup) {
              try {
                const roles = await fleetDb.listGroupRoles(ctx.db, resolvedGroup.id);
                if (roles.length) {
                  const roleBlob = roles.map(r => r.prompt).filter(Boolean).join('\n\n');
                  if (roleBlob) {
                    structured.system_prompt = structured.system_prompt
                      ? `${roleBlob}\n\n${structured.system_prompt}`
                      : roleBlob;
                  }
                  appliedRoleNames = roles.map(r => r.name);
                  // First role with a default_model wins if caller didn't specify.
                  if (!structured.model) {
                    const firstWithModel = roles.find(r => r.default_model);
                    if (firstWithModel) structured.model = firstWithModel.default_model;
                  }
                  // vt-0266: forward role-defined allowed_tools. Roles compose by
                  // UNION — if any role grants Bash, Bash is allowed. If caller
                  // already specified allowed_tools, INTERSECT with the union so
                  // caller is at-most-as-permissive (defence-in-depth).
                  const roleTools = new Set();
                  for (const r of roles) {
                    const t = Array.isArray(r.allowed_tools) ? r.allowed_tools : [];
                    for (const x of t) if (typeof x === 'string') roleTools.add(x);
                  }
                  if (roleTools.size > 0) {
                    if (Array.isArray(structured.allowed_tools)) {
                      structured.allowed_tools = structured.allowed_tools.filter(t => roleTools.has(t));
                    } else {
                      structured.allowed_tools = Array.from(roleTools);
                    }
                  }
                }
              } catch (e) {
                log.error('group_roles_lookup_failed', { group: resolvedGroup.name, msg: e.message });
              }
            }
            if (structured.system_prompt
                && Buffer.byteLength(structured.system_prompt, 'utf8') > MAX_DISPATCH_SYSTEM_PROMPT_BYTES) {
              log.warn('dispatch_system_prompt_truncated', {
                group: resolvedGroup ? resolvedGroup.name : null,
                original_bytes: Buffer.byteLength(structured.system_prompt, 'utf8'),
                cap: MAX_DISPATCH_SYSTEM_PROMPT_BYTES,
              });
              // UTF-8-safe truncation: Buffer.slice may cut mid-codepoint;
              // toString('utf8') replaces dangling bytes with U+FFFD rather
              // than dropping silently. Trailing marker line is the
              // operator-visible signal.
              const buf = Buffer.from(structured.system_prompt, 'utf8').slice(0, MAX_DISPATCH_SYSTEM_PROMPT_BYTES - 64);
              structured.system_prompt = buf.toString('utf8') + '\n\n[truncated by dispatcher: combined prompt exceeded cap]';
            }

            const sessionMetadata = { ...(metadata || {}), ...structured };
            if (resolvedGroup) sessionMetadata.dispatched_group = resolvedGroup.name;
            if (appliedRoleNames.length) sessionMetadata.applied_roles = appliedRoleNames;

            const s = await fleetDb.createSession(ctx.db, {
              hostId: host.id, cwd: cwd || '~',
              args: args || [], env: env || {},
              createdBy: 'dispatch',
              label: label || null, metadata: sessionMetadata,
            });
            if (ctx.bus) {
              const payload = { session_id: s.id, cwd: s.cwd, args: s.args, env: s.env, ...structured };
              ctx.bus.requestSpawn(host.id, payload);
            }
            send(res, 201, {
              session_id: s.id,
              host_id: host.id,
              host_name: host.name,
              display_name: host.display_name,
              group_brain_prompt_applied: !!(resolvedGroup && resolvedGroup.brain_prompt),
              applied_roles: appliedRoleNames,
            });
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
