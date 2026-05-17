'use strict';
// vt-0345: webhook subscription CRUD. Backed by webhook_subscriptions
// table (sql/023-webhooks.sql). Admin-gated by outer isAdminPath on
// every mutation; GET also admin because subscription `secret` is
// the HMAC signing key — leaking it lets anyone forge signed events.
//
// All endpoints:
//   GET    /fleet/webhooks                — list (admin only by isAdminPath? GET is viewer-default)
//   POST   /fleet/webhooks                — create
//   GET    /fleet/webhooks/:id            — get one
//   PATCH  /fleet/webhooks/:id            — update fields
//   DELETE /fleet/webhooks/:id            — drop subscription (+ deliveries cascade)
//   GET    /fleet/webhooks/:id/deliveries — recent attempt log
//   POST   /fleet/webhooks/:id/test       — fire a one-shot test event

const { SID_RE, send, readBody } = require('./_shared');

const VALID_FORMATS = new Set(['generic', 'slack', 'discord', 'telegram']);
const URL_MAX = 1024;
const EVENT_MAX = 128;
const EVENTS_MAX = 32;

function validatePayload(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.url !== undefined) {
    if (typeof body.url !== 'string' || !body.url || body.url.length > URL_MAX) {
      errs.push('url required (string ≤1024 chars)');
    } else if (!/^https?:\/\//i.test(body.url)) {
      errs.push('url must start with http:// or https://');
    }
  }
  if (body.events !== undefined) {
    if (!Array.isArray(body.events)) errs.push('events must be array');
    else if (body.events.length > EVENTS_MAX) errs.push(`events array max ${EVENTS_MAX}`);
    else for (const e of body.events) {
      if (typeof e !== 'string' || !e || e.length > EVENT_MAX) {
        errs.push(`each event must be non-empty string ≤${EVENT_MAX} chars`);
        break;
      }
    }
  }
  if (body.format !== undefined && !VALID_FORMATS.has(body.format)) {
    errs.push(`format must be one of: ${[...VALID_FORMATS].join('/')}`);
  }
  if (body.secret !== undefined && body.secret !== null) {
    if (typeof body.secret !== 'string' || body.secret.length > 256) {
      errs.push('secret must be string ≤256 chars or null');
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    errs.push('enabled must be boolean');
  }
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string' || body.description.length > 512) {
      errs.push('description must be string ≤512 chars or null');
    }
  }
  return errs;
}

function register({ fleetDb }) {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/webhooks$/,
      handler(req, res, ctx) {
        return fleetDb.listWebhooks(ctx.db)
          .then(rows => send(res, 200, rows))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/fleet\/webhooks$/,
      handler(req, res, ctx) {
        return readBody(req).then(async (b) => {
          const errs = validatePayload(b);
          if (errs.length) return send(res, 422, { error: errs.join('; ') });
          try {
            const row = await fleetDb.createWebhook(ctx.db, b);
            send(res, 201, row);
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/webhooks/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return fleetDb.getWebhook(ctx.db, m[1])
          .then(r => r ? send(res, 200, r) : send(res, 404, { error: 'not found' }))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/fleet/webhooks/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return readBody(req).then(async (b) => {
          const errs = validatePayload(b, { partial: true });
          if (errs.length) return send(res, 422, { error: errs.join('; ') });
          try {
            const row = await fleetDb.updateWebhook(ctx.db, m[1], b);
            row ? send(res, 200, row) : send(res, 404, { error: 'not found' });
          } catch (e) { send(res, 500, { error: e.message }); }
        }).catch(e => send(res, e.statusCode || 400, { error: e.message }));
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/fleet/webhooks/(${SID_RE})$`, 'i'),
      handler(req, res, ctx, m) {
        return fleetDb.deleteWebhook(ctx.db, m[1])
          .then(ok => ok ? (res.writeHead(204), res.end()) : send(res, 404, { error: 'not found' }))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/webhooks/(${SID_RE})/deliveries$`, 'i'),
      handler(req, res, ctx, m) {
        const u = new URL(req.url, 'http://x');
        const limit = parseInt(u.searchParams.get('limit') || '50', 10) || 50;
        return fleetDb.listWebhookDeliveries(ctx.db, m[1], { limit })
          .then(rows => send(res, 200, rows))
          .catch(e => send(res, 500, { error: e.message }));
      },
    },
    {
      // Smoke test — fires a synthetic `test.ping` event through the
      // existing webhooks.emit(). Operator can verify their endpoint
      // is reachable + signature verifies before relying on real
      // workflow.failed/host.offline events.
      method: 'POST',
      pattern: new RegExp(`^/fleet/webhooks/(${SID_RE})/test$`, 'i'),
      handler(req, res, ctx, m) {
        return fleetDb.getWebhook(ctx.db, m[1]).then(async (row) => {
          if (!row) return send(res, 404, { error: 'not found' });
          if (!row.enabled) return send(res, 422, { error: 'subscription disabled — enable first' });
          // testSubscription bypasses the event-filter in emit() so
          // operators don't need to add 'test.ping' to their events
          // list just to verify connectivity.
          const webhooks = require('../webhooks');
          const result = await webhooks.testSubscription(ctx.db, m[1]);
          if (result.status && result.status < 500) {
            send(res, 202, { dispatched: true, event: 'test.ping', status: result.status, error: result.error });
          } else {
            send(res, 502, { dispatched: false, event: 'test.ping', status: result.status, error: result.error });
          }
        }).catch(e => send(res, 500, { error: e.message }));
      },
    },
  ];
}

module.exports = { register };
