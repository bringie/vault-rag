-- vt-0223: outbound webhooks. Operator wires Slack/Discord/Telegram/
-- generic-HTTPS endpoints to receive events from the hub. Subscriptions
-- live in DB; delivery is best-effort with retry-and-give-up after N
-- attempts (recorded in webhook_deliveries for forensics).

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,                       -- where to POST
  events      text[] NOT NULL DEFAULT '{}',        -- e.g. {workflow.failed, host.offline}
  secret      text,                                -- HMAC-SHA256 signing key (header X-Vault-Signature)
  format      text NOT NULL DEFAULT 'generic'     -- 'generic' | 'slack' | 'discord' | 'telegram'
                 CHECK (format IN ('generic','slack','discord','telegram')),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  description text
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            bigserial PRIMARY KEY,
  subscription  uuid REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event         text NOT NULL,
  attempt       int NOT NULL DEFAULT 1,
  status        int,                               -- HTTP status; null = network error
  error         text,
  ts            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ts ON webhook_deliveries (ts DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries (subscription, ts DESC);
