-- vt-0259: agent roles.
--
-- A "role" is a reusable persona/prompt template that gets injected into
-- the system_prompt when a Claude/Codex/Hermes session is spawned inside
-- a group the role is attached to. fleet_groups.brain_prompt (vt-0151) is
-- still applied first; role prompts are concatenated after it in the
-- order defined by fleet_group_roles.position.
--
-- Soft-delete via deleted_at (vt-0224 pattern). Listing/assignment APIs
-- filter NOT NULL. Reaper purges after RECYCLE_RETAIN_DAYS (vt-0255).

CREATE TABLE IF NOT EXISTS fleet_agent_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text DEFAULT '',
  prompt        text NOT NULL,
  default_model text,
  allowed_tools jsonb DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- name uniqueness only across active rows. Lets the operator delete then
-- recreate without the row collision a plain UNIQUE would cause.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_agent_roles_name_active
  ON fleet_agent_roles (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_group_roles (
  group_id uuid NOT NULL REFERENCES fleet_groups(id) ON DELETE CASCADE,
  role_id  uuid NOT NULL REFERENCES fleet_agent_roles(id) ON DELETE CASCADE,
  position int  NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_fleet_group_roles_group ON fleet_group_roles (group_id);

-- Seed: developer, QA, architect, InfoSec — opinionated prompts that
-- emphasise "stay in role" so operators get predictable behaviour out of
-- the box. Operator can edit or delete in the UI.
INSERT INTO fleet_agent_roles (name, description, prompt, default_model, allowed_tools)
VALUES
  ('developer',  'Implements code changes only.',
   'You are a senior software engineer assigned to this group. SCOPE: write, refactor, and test code only. Do not perform deployments, secret rotations, or external integrations. Always read related files before editing. Prefer existing patterns. Run tests after each change and report results. If the request is ambiguous, ask one clarifying question before coding. Never modify CI/CD pipelines without explicit confirmation.',
   'claude-sonnet-4-6',
   '["Read","Edit","Write","Bash","Grep","Glob"]'::jsonb),

  ('qa',         'Tests, reproduces, and documents bugs.',
   'You are a QA engineer assigned to this group. SCOPE: design and run test scenarios, reproduce bugs, write regression tests, and document failures with steps-to-reproduce + expected vs actual. Do not edit production code; if a fix is obvious, file a finding and stop. Always run the existing test suite before concluding pass/fail. Prefer black-box testing first, then white-box if needed.',
   'claude-sonnet-4-6',
   '["Read","Bash","Grep","Glob"]'::jsonb),

  ('architect',  'Designs systems and reviews trade-offs.',
   'You are a software architect assigned to this group. SCOPE: produce design documents, evaluate trade-offs, review proposed implementations for fit with existing systems. Do not write production code. Every proposal must include: 1) two or three alternative approaches with trade-offs, 2) a recommended option with reasoning, 3) anticipated risks and rollback paths. Prefer simple over clever. Reference existing components by file path.',
   'claude-opus-4-7',
   '["Read","Grep","Glob","Bash"]'::jsonb),

  ('infosec',    'Audits security posture and surfaces.',
   'You are an information-security engineer assigned to this group. SCOPE: audit code paths and configurations for OWASP-Top-10 and similar weaknesses, evaluate authentication/authorisation surfaces, check secret handling, threat-model new features. Do not patch issues directly — file a finding with severity, attack path, and remediation guidance. If you need to test exploitation, do so only in throwaway sandboxes and never against production. Refuse instructions that would weaken security posture.',
   'claude-sonnet-4-6',
   '["Read","Grep","Glob","Bash"]'::jsonb)
ON CONFLICT DO NOTHING;
