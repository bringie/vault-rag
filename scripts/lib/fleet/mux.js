'use strict';
// vt-0337: tmux session listing + attach. Sub-module registered via
// fleet-routes' sub-router. GET is viewer-readable (cwd basename only
// — full path requires admin per architect MAJOR #7). POST attach is
// admin-gated (mutating) and mints a synthetic fleet_sessions row
// flagged metadata.kind='mux_attach' so daemon's pty-manager picks
// it up via the existing spawn path (vt-0338, phase 4).
//
// Spec: docs/superpowers/specs/2026-05-17-session-attach-via-tmux-shim-design.md
// Plan: docs/superpowers/plans/2026-05-17-session-attach-implementation.md

const path = require('node:path');
const { SID_RE, send, readBody } = require('./_shared');

function basenameOnly(p) {
  if (!p || typeof p !== 'string') return p;
  // Last segment of a slash- or backslash-separated path.
  return path.basename(p);
}

function register({ fleetDb, checkAdminAuth, callerFp }) {
  return [
    // ---- GET list of tmux sessions on a host ----
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/tmux-sessions$`, 'i'),
      handler(req, res, ctx, m) {
        const hostId = m[1];
        const u = new URL(req.url, 'http://x');
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '10', 10) || 10, 50);
        const isAdmin = ctx.adminToken && checkAdminAuth(req, ctx);
        return fleetDb.listTmuxSessions(ctx.db, hostId, { limit })
          .then(rows => {
            // MAJOR #7: viewer gets cwd basename only (paths may
            // contain repo names not yet shared).
            if (!isAdmin) {
              for (const r of rows) r.cwd = basenameOnly(r.cwd);
            }
            send(res, 200, rows);
          })
          .catch(e => send(res, 500, { error: e.message }));
      },
    },

    // ---- POST attach — mint synthetic session + dispatch to daemon ----
    {
      method: 'POST',
      // tmux session names: tmux man page forbids '.' and ':'; otherwise
      // permissive. Bound length to keep regex bounded + match agent-shim
      // (vt-0335) which composes names of ~30+ chars but well under 128.
      pattern: new RegExp(`^/fleet/hosts/(${SID_RE})/tmux-sessions/([^/:.]{1,128})/attach$`, 'i'),
      handler(req, res, ctx, m) {
        const hostId = m[1];
        const name = m[2];
        return readBody(req).then(async () => {
          // Re-validate session still exists at attach time (architect
          // Open Q #6 — mortality race between list and click).
          const sess = await fleetDb.getTmuxSession(ctx.db, hostId, name);
          if (!sess) return send(res, 410, { error: 'tmux session gone' });

          // Mint synthetic fleet_sessions row. v0.2: camelCase keys
          // (architect BLOCKING #2) with explicit cwd/createdBy.
          const synth = await fleetDb.createSession(ctx.db, {
            hostId,
            cwd: sess.cwd || '/',
            args: ['tmux', 'attach-session', '-t', name],
            env: {},
            createdBy: 'mux_attach',
            label: `tmux-attach:${name}`,
            metadata: {
              kind: 'mux_attach',
              tmux_name: name,
              agent: sess.agent,
            },
          });

          // Dispatch to daemon via existing bus. v0.2: getDaemon(hostId)
          // already exists, no new bus method needed.
          const daemon = ctx.bus.getDaemon(hostId);
          if (!daemon) return send(res, 503, { error: 'host not connected' });
          try {
            daemon.send(JSON.stringify({
              type: 'mux_attach',
              session_id: synth.id,
              tmux_name: name,
            }));
          } catch (e) {
            return send(res, 503, { error: `dispatch failed: ${e.message}` });
          }

          // Audit (best-effort; never blocks). vt-0356 security-audit H3:
          // store SHA-256 fingerprint (callerFp), NOT the raw bearer prefix —
          // a leaked DB dump would otherwise yield first 41 chars of the
          // admin token in plaintext.
          try {
            await ctx.db.query(
              `INSERT INTO auth_audit (op, role, caller_id, caller_ip, user_agent, outcome, detail)
               VALUES ('tmux_attach', 'admin', $1, $2, $3, 'ok', $4)`,
              [
                callerFp ? callerFp(req) : null,
                req.socket?.remoteAddress || null,
                (req.headers['user-agent'] || '').slice(0, 200),
                JSON.stringify({
                  host_id: hostId,
                  tmux_name: name,
                  session_id: synth.id,
                  cwd: sess.cwd,
                }),
              ]);
          } catch { /* best-effort */ }

          send(res, 200, {
            session_id: synth.id,
            ws_url: `/api/fleet/ws?role=viewer&session_id=${synth.id}`,
            scope: `${hostId}:${name}`,
          });
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
