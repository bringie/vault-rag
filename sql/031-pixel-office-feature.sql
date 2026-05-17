-- vt-0369 / vt-0371: feature flag for Pixel-Office.
-- Off by default — operators opt in via the /fleet/features admin UI.
-- The SPA's NAV_FEATURE map (agent-fleet/web/app.js) hides the
-- 'pixel-office' nav button + route until `enabled=true`.

INSERT INTO fleet_features (name, enabled, description) VALUES
  ('pixel_office', false, 'Gamified pixel-office visualization of agent-fleet hosts (avatars walking/working)')
ON CONFLICT (name) DO NOTHING;
