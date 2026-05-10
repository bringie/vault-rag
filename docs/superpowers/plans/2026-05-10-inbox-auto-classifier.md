---
type: plan
status: approved
epic: vt-0032
spec: docs/superpowers/specs/2026-05-10-inbox-auto-classifier-design.md
date: 2026-05-10
---

# Inbox Auto-Classifier Implementation Plan

> **For agentic workers:** Implement this plan task-by-task using `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking. (`superpowers:subagent-driven-development` is disabled in this account per `~/.claude/CLAUDE.md`.)

**Goal:** Auto-classify markdown notes from `00-inbox/` into Johnny.Decimal vault folders using Anthropic Haiku (called via the `claude` CLI with subscription auth) on a 15-minute ofelia schedule.

**Architecture:** A new ofelia-scheduled Node.js script (`inbox-classifier.js`) runs inside `vault-rag-tools`. It reads `/vault/00-inbox/`, persists per-file state in a new postgres table (`inbox_classifier_state`), invokes Haiku via the `claude` CLI for classification, and either moves the file into the suggested target folder (`01-knowledge`, `02-projects`, `05-logs`, `06-resources`) with enriched frontmatter (when `confidence >= 0.7`) or routes it to `00-inbox/_deadletter/` (low confidence or after 3 failed attempts). All operations are recorded in the existing `vault_audit` table and exported via Prometheus textfile metrics.

**Tech Stack:** Node.js 22 (built-in `node:test`), `pg` (already a dep), `js-yaml` (already a dep), `child_process.execFile`, `@anthropic-ai/claude-code` (new global npm install in Docker image), Docker Compose, ofelia.

---

## File Structure

**New files:**

- `sql/004-inbox-classifier-state.sql` — schema migration for state table.
- `scripts/lib/classifier-lib.js` — pure helper functions (parse Haiku reply, validate target, skip rules, enrich frontmatter, build prompt). One responsibility: deterministic transformations.
- `scripts/lib/claude-cli.js` — `child_process.execFile` wrapper around `claude -p ... --output-format json`. Encapsulates timeout handling and error normalisation so the rest of the code is unaware of the CLI.
- `scripts/inbox-classifier.js` — main entrypoint: glob inbox, drive the state machine, call helpers, write metrics.
- `scripts/test/classifier-lib.test.js` — unit tests for the pure helpers.
- `scripts/test/state-machine.test.js` — unit tests for state transitions, with an in-memory pg client mock.
- `scripts/test/integration/inbox-classifier.test.sh` — integration smoke that drives the full flow against postgres + a `fake-claude` stub.
- `scripts/test/integration/fake-claude.sh` — deterministic CLI stub used by the integration test.

**Modified files:**

- `Dockerfile.tools` — `RUN npm install -g @anthropic-ai/claude-code`.
- `docker-compose.yml` — add `vault-rag-tools` volume mounts for `~/.claude/.credentials.json` (ro) and `~/.claude/settings.json` (ro), plus ofelia labels for `inbox-classifier`.
- `scripts/package.json` — add `test` script, add `prom-client` dependency.
- `docs/operations.md` — append "Inbox classifier" runbook section (deploy + smoke + dead-letter triage).

**Reused (no changes):**

- `scripts/lib/vault-lib.js` — `parseFrontmatter`, `serializeFrontmatter`, `mergeFrontmatter` are reused as-is.
- `scripts/run-job.js` — wraps the new job into a `job_runs` row, no changes needed.
- `vault_audit` table — already exists (`sql/001-init.sql`), classifier inserts rows with `op='classify'`.

---

## Task 1: Add SQL migration for `inbox_classifier_state`

**Files:**

- Create: `sql/004-inbox-classifier-state.sql`

- [ ] **Step 1: Write the migration**

```sql
-- sql/004-inbox-classifier-state.sql
-- Per-file state for the inbox auto-classifier.

CREATE TABLE IF NOT EXISTS inbox_classifier_state (
  path           text PRIMARY KEY,
  sha            text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','processing','done','deadletter')),
  attempts       int  NOT NULL DEFAULT 0,
  last_error     text,
  classified_at  timestamptz,
  started_at     timestamptz,
  target_folder  text,
  confidence     real,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_classifier_state_status_idx
  ON inbox_classifier_state (status);
```

- [ ] **Step 2: Apply migration on the vault-rag postgres**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "docker exec -i vault-rag-postgres psql -U postgres -d vault_rag" \
  < sql/004-inbox-classifier-state.sql
```

Expected: `CREATE TABLE` and `CREATE INDEX` lines (no errors).

- [ ] **Step 3: Verify the table is empty and indexed**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "docker exec vault-rag-postgres psql -U postgres -d vault_rag -c '\\d+ inbox_classifier_state'"
```

Expected: column list matches the `CREATE TABLE`, index `inbox_classifier_state_status_idx` listed.

- [ ] **Step 4: Commit**

```bash
git add sql/004-inbox-classifier-state.sql
git commit -m "feat(sql): inbox_classifier_state table (vt-0032)"
```

---

## Task 2: Wire `node:test` into `scripts/`

**Files:**

- Modify: `scripts/package.json`

- [ ] **Step 1: Add `test` and `test:unit` npm scripts**

Edit `scripts/package.json` so that the `scripts` block reads:

```json
"scripts": {
  "test": "node --test test/*.test.js",
  "test:unit": "node --test test/*.test.js",
  "test:integration": "bash test/integration/inbox-classifier.test.sh"
}
```

- [ ] **Step 2: Sanity-run an empty suite**

```bash
mkdir -p scripts/test
cd scripts && npm test
```

Expected: exit 0 and `tests 0` (no test files yet — that is fine).

- [ ] **Step 3: Commit**

```bash
git add scripts/package.json
git commit -m "chore(scripts): add npm test scripts (node --test)"
```

---

## Task 3: `classifier-lib.parseClaudeResponse` (RED → GREEN)

**Files:**

- Create: `scripts/lib/classifier-lib.js`
- Create: `scripts/test/classifier-lib.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/test/classifier-lib.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeResponse } = require('../lib/classifier-lib');

test('parseClaudeResponse: valid JSON', () => {
  const stdout = JSON.stringify({
    target_folder: '01-knowledge',
    tags: ['rag', 'pgvector', 'design'],
    summary: 'Vault RAG pgvector schema notes.',
    type: 'note',
    confidence: 0.92,
  });
  const r = parseClaudeResponse(stdout);
  assert.equal(r.target_folder, '01-knowledge');
  assert.deepEqual(r.tags, ['rag', 'pgvector', 'design']);
  assert.equal(r.confidence, 0.92);
});

test('parseClaudeResponse: extracts JSON from CLI envelope', () => {
  // claude --output-format json wraps the assistant reply in {"result": "..."}
  const stdout = JSON.stringify({
    result: '{"target_folder":"05-logs","tags":["smoke"],"summary":"x","type":"log","confidence":0.8}',
  });
  const r = parseClaudeResponse(stdout);
  assert.equal(r.target_folder, '05-logs');
  assert.equal(r.type, 'log');
});

test('parseClaudeResponse: malformed JSON throws', () => {
  assert.throws(() => parseClaudeResponse('not json at all'), /parse_error/);
});

test('parseClaudeResponse: missing required field throws', () => {
  const stdout = JSON.stringify({ target_folder: '01-knowledge', tags: [] });
  assert.throws(() => parseClaudeResponse(stdout), /missing_field/);
});

test('parseClaudeResponse: clamps confidence to [0,1]', () => {
  const stdout = JSON.stringify({
    target_folder: '06-resources', tags: ['x'], summary: 's', type: 'note', confidence: 1.4,
  });
  assert.equal(parseClaudeResponse(stdout).confidence, 1);
});
```

- [ ] **Step 2: Run tests, expect RED**

```bash
cd scripts && npm test
```

Expected: `Cannot find module '../lib/classifier-lib'` — fail.

- [ ] **Step 3: Implement `parseClaudeResponse`**

```javascript
// scripts/lib/classifier-lib.js

const REQUIRED_FIELDS = ['target_folder', 'tags', 'summary', 'type', 'confidence'];

function parseClaudeResponse(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (e) {
    const err = new Error(`parse_error: ${e.message}`);
    err.code = 'parse_error';
    throw err;
  }

  // claude --output-format json returns {result: "<assistant text>"}; the assistant
  // text is itself JSON. If `result` is not present, treat `outer` as the payload.
  let payload = outer;
  if (typeof outer.result === 'string') {
    try { payload = JSON.parse(outer.result); }
    catch (e) {
      const err = new Error(`parse_error: inner result not JSON: ${e.message}`);
      err.code = 'parse_error';
      throw err;
    }
  }

  for (const k of REQUIRED_FIELDS) {
    if (payload[k] === undefined || payload[k] === null) {
      const err = new Error(`missing_field: ${k}`);
      err.code = 'missing_field';
      throw err;
    }
  }

  let conf = Number(payload.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  if (conf < 0) conf = 0;
  if (conf > 1) conf = 1;

  return {
    target_folder: String(payload.target_folder),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
    summary: String(payload.summary).slice(0, 200),
    type: String(payload.type),
    confidence: conf,
  };
}

module.exports = { parseClaudeResponse };
```

- [ ] **Step 4: Run tests, expect GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 5`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/classifier-lib.js scripts/test/classifier-lib.test.js
git commit -m "feat(classifier-lib): parseClaudeResponse + tests"
```

---

## Task 4: `classifier-lib.validateTargetFolder`

**Files:**

- Modify: `scripts/lib/classifier-lib.js`
- Modify: `scripts/test/classifier-lib.test.js`

- [ ] **Step 1: Append failing tests**

Append to `scripts/test/classifier-lib.test.js`:

```javascript
const { validateTargetFolder } = require('../lib/classifier-lib');

test('validateTargetFolder: allows whitelisted folders', () => {
  assert.doesNotThrow(() => validateTargetFolder('01-knowledge'));
  assert.doesNotThrow(() => validateTargetFolder('02-projects'));
  assert.doesNotThrow(() => validateTargetFolder('05-logs'));
  assert.doesNotThrow(() => validateTargetFolder('06-resources'));
});

test('validateTargetFolder: rejects unknown folder', () => {
  assert.throws(() => validateTargetFolder('07-trash'), /invalid_target/);
});

test('validateTargetFolder: rejects path traversal', () => {
  assert.throws(() => validateTargetFolder('../etc'), /invalid_target/);
  assert.throws(() => validateTargetFolder('01-knowledge/../etc'), /invalid_target/);
});

test('validateTargetFolder: rejects empty/null', () => {
  assert.throws(() => validateTargetFolder(''), /invalid_target/);
  assert.throws(() => validateTargetFolder(null), /invalid_target/);
});
```

Also extend the `require` line at the top of the test file to import `validateTargetFolder`:

```javascript
const { parseClaudeResponse, validateTargetFolder } = require('../lib/classifier-lib');
```

(Remove the duplicate `require` you just added at the bottom.)

- [ ] **Step 2: Run tests, expect RED**

```bash
cd scripts && npm test
```

Expected: `validateTargetFolder is not a function`.

- [ ] **Step 3: Implement**

Append to `scripts/lib/classifier-lib.js`, before the `module.exports` line:

```javascript
const ALLOWED_TARGETS = new Set(['01-knowledge', '02-projects', '05-logs', '06-resources']);

function validateTargetFolder(folder) {
  if (!folder || typeof folder !== 'string') {
    const e = new Error('invalid_target: empty');
    e.code = 'invalid_target';
    throw e;
  }
  if (!ALLOWED_TARGETS.has(folder)) {
    const e = new Error(`invalid_target: ${folder}`);
    e.code = 'invalid_target';
    throw e;
  }
}
```

Update `module.exports`:

```javascript
module.exports = { parseClaudeResponse, validateTargetFolder, ALLOWED_TARGETS };
```

- [ ] **Step 4: Run tests, expect GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 9`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/classifier-lib.js scripts/test/classifier-lib.test.js
git commit -m "feat(classifier-lib): validateTargetFolder allowlist + tests"
```

---

## Task 5: `classifier-lib.shouldSkip`

**Files:**

- Modify: `scripts/lib/classifier-lib.js`
- Modify: `scripts/test/classifier-lib.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
const { shouldSkip } = require('../lib/classifier-lib');

test('shouldSkip: current-context.md', () => {
  assert.equal(shouldSkip('current-context.md', {}), true);
});

test('shouldSkip: type=index frontmatter', () => {
  assert.equal(shouldSkip('foo.md', { type: 'index' }), true);
});

test('shouldSkip: underscore prefix', () => {
  assert.equal(shouldSkip('_internal.md', {}), true);
});

test('shouldSkip: regular file is processed', () => {
  assert.equal(shouldSkip('regular-note.md', { tags: ['x'] }), false);
});

test('shouldSkip: missing frontmatter is processed', () => {
  assert.equal(shouldSkip('regular-note.md', null), false);
});
```

Update top-level require:

```javascript
const { parseClaudeResponse, validateTargetFolder, shouldSkip } = require('../lib/classifier-lib');
```

- [ ] **Step 2: RED**

```bash
cd scripts && npm test
```

Expected: `shouldSkip is not a function`.

- [ ] **Step 3: Implement**

Append to `scripts/lib/classifier-lib.js`:

```javascript
function shouldSkip(basename, frontmatter) {
  if (basename === 'current-context.md') return true;
  if (basename.startsWith('_')) return true;
  if (frontmatter && frontmatter.type === 'index') return true;
  return false;
}
```

Update exports:

```javascript
module.exports = { parseClaudeResponse, validateTargetFolder, shouldSkip, ALLOWED_TARGETS };
```

- [ ] **Step 4: GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 14`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/classifier-lib.js scripts/test/classifier-lib.test.js
git commit -m "feat(classifier-lib): shouldSkip rules + tests"
```

---

## Task 6: `classifier-lib.enrichFrontmatter`

**Files:**

- Modify: `scripts/lib/classifier-lib.js`
- Modify: `scripts/test/classifier-lib.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
const { enrichFrontmatter } = require('../lib/classifier-lib');

test('enrichFrontmatter: merges tags with existing, deduped', () => {
  const out = enrichFrontmatter(
    { tags: ['rag', 'design'] },
    { tags: ['rag', 'pgvector'], summary: 's', type: 'note', confidence: 0.9 },
    '2026-05-10T10:00:00Z'
  );
  assert.deepEqual(out.tags, ['rag', 'design', 'pgvector']);
});

test('enrichFrontmatter: preserves existing type', () => {
  const out = enrichFrontmatter(
    { type: 'log' },
    { tags: [], summary: 's', type: 'note', confidence: 0.9 },
    '2026-05-10T10:00:00Z'
  );
  assert.equal(out.type, 'log');
});

test('enrichFrontmatter: sets type from result if frontmatter has none', () => {
  const out = enrichFrontmatter(
    {},
    { tags: [], summary: 's', type: 'reference', confidence: 0.9 },
    '2026-05-10T10:00:00Z'
  );
  assert.equal(out.type, 'reference');
});

test('enrichFrontmatter: sets classified_* fields', () => {
  const out = enrichFrontmatter(
    {},
    { tags: ['x'], summary: 's', type: 'note', confidence: 0.85 },
    '2026-05-10T10:00:00Z'
  );
  assert.equal(out.classified_at, '2026-05-10T10:00:00Z');
  assert.equal(out.classified_by, 'haiku/inbox-classifier-v1');
  assert.equal(out.classifier_confidence, 0.85);
  assert.equal(out.summary, 's');
});

test('enrichFrontmatter: handles null base', () => {
  const out = enrichFrontmatter(
    null,
    { tags: ['x'], summary: 's', type: 'note', confidence: 0.85 },
    '2026-05-10T10:00:00Z'
  );
  assert.deepEqual(out.tags, ['x']);
});
```

Update require:

```javascript
const { parseClaudeResponse, validateTargetFolder, shouldSkip, enrichFrontmatter } = require('../lib/classifier-lib');
```

- [ ] **Step 2: RED**

```bash
cd scripts && npm test
```

Expected: `enrichFrontmatter is not a function`.

- [ ] **Step 3: Implement**

Append to `scripts/lib/classifier-lib.js`:

```javascript
const { mergeFrontmatter } = require('./vault-lib');

function enrichFrontmatter(existing, result, nowIso) {
  const base = existing || {};
  const patch = {
    tags: result.tags,
    summary: result.summary,
    classified_at: nowIso,
    classified_by: 'haiku/inbox-classifier-v1',
    classifier_confidence: result.confidence,
  };
  if (!base.type) patch.type = result.type;
  return mergeFrontmatter(base, patch);
}
```

Note: `mergeFrontmatter` already dedupes arrays when both sides have the key, so passing the patch above merges tags correctly with the existing list.

Update exports:

```javascript
module.exports = {
  parseClaudeResponse, validateTargetFolder, shouldSkip,
  enrichFrontmatter, ALLOWED_TARGETS,
};
```

- [ ] **Step 4: GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 19`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/classifier-lib.js scripts/test/classifier-lib.test.js
git commit -m "feat(classifier-lib): enrichFrontmatter via mergeFrontmatter"
```

---

## Task 7: `classifier-lib.buildPrompt`

**Files:**

- Modify: `scripts/lib/classifier-lib.js`
- Modify: `scripts/test/classifier-lib.test.js`

- [ ] **Step 1: Append failing tests**

```javascript
const { buildPrompt } = require('../lib/classifier-lib');

test('buildPrompt: includes basename, frontmatter, body', () => {
  const p = buildPrompt({
    basename: 'foo.md',
    frontmatter: { tags: ['x'] },
    body: 'hello world',
  });
  assert.match(p, /PATH: 00-inbox\/foo\.md/);
  assert.match(p, /tags:/);
  assert.match(p, /hello world/);
});

test('buildPrompt: caps body at 6000 chars', () => {
  const big = 'a'.repeat(8000);
  const p = buildPrompt({ basename: 'big.md', frontmatter: {}, body: big });
  // body section must contain at most 6000 a's
  const m = p.match(/BODY:\n(a+)/);
  assert.ok(m);
  assert.ok(m[1].length <= 6000);
});

test('buildPrompt: empty frontmatter is rendered as "(none)"', () => {
  const p = buildPrompt({ basename: 'foo.md', frontmatter: {}, body: 'x' });
  assert.match(p, /EXISTING_FRONTMATTER:\n\(none\)/);
});

test('buildPrompt: includes allowed-folder list and required output schema', () => {
  const p = buildPrompt({ basename: 'foo.md', frontmatter: {}, body: 'x' });
  assert.match(p, /01-knowledge/);
  assert.match(p, /02-projects/);
  assert.match(p, /05-logs/);
  assert.match(p, /06-resources/);
  assert.match(p, /target_folder/);
  assert.match(p, /confidence/);
});
```

Update require:

```javascript
const {
  parseClaudeResponse, validateTargetFolder, shouldSkip,
  enrichFrontmatter, buildPrompt,
} = require('../lib/classifier-lib');
```

- [ ] **Step 2: RED**

```bash
cd scripts && npm test
```

Expected: `buildPrompt is not a function`.

- [ ] **Step 3: Implement**

Append to `scripts/lib/classifier-lib.js`:

```javascript
const yaml = require('js-yaml');

const SYSTEM = [
  'You classify markdown notes into a Johnny.Decimal vault.',
  'Folders:',
  '  01-knowledge  : durable concepts, references, cheat-sheets',
  '  02-projects   : ongoing project artefacts (active work)',
  '  05-logs       : session logs, incident notes, debug transcripts',
  '  06-resources  : external links, prompts, raw resources',
  '',
  'Output JSON only, no prose:',
  '{',
  '  "target_folder": "01-knowledge"|"02-projects"|"05-logs"|"06-resources",',
  '  "tags": [3-5 short kebab-case strings],',
  '  "summary": "<= 200 chars",',
  '  "type": "note|log|reference|project|prompt|other",',
  '  "confidence": 0.0-1.0',
  '}',
].join('\n');

function buildPrompt({ basename, frontmatter, body }) {
  const fmText =
    frontmatter && Object.keys(frontmatter).length
      ? yaml.dump(frontmatter, { lineWidth: -1, sortKeys: false }).trimEnd()
      : '(none)';
  const cappedBody = (body || '').slice(0, 6000);
  return [
    SYSTEM,
    '',
    `PATH: 00-inbox/${basename}`,
    'EXISTING_FRONTMATTER:',
    fmText,
    '',
    'BODY:',
    cappedBody,
  ].join('\n');
}
```

Update exports:

```javascript
module.exports = {
  parseClaudeResponse, validateTargetFolder, shouldSkip,
  enrichFrontmatter, buildPrompt, ALLOWED_TARGETS,
};
```

- [ ] **Step 4: GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 23`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/classifier-lib.js scripts/test/classifier-lib.test.js
git commit -m "feat(classifier-lib): buildPrompt + tests"
```

---

## Task 8: `claude-cli.js` wrapper

**Files:**

- Create: `scripts/lib/claude-cli.js`
- Create: `scripts/test/claude-cli.test.js`

- [ ] **Step 1: Write failing tests using a fake CLI**

```javascript
// scripts/test/claude-cli.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callClaude } = require('../lib/claude-cli');

function writeFakeBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeclaude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('callClaude: returns stdout on exit 0', async () => {
  const bin = writeFakeBin(`echo '{"result":"{\\"target_folder\\":\\"01-knowledge\\",\\"tags\\":[],\\"summary\\":\\"s\\",\\"type\\":\\"note\\",\\"confidence\\":0.9}"}'`);
  const out = await callClaude({ prompt: 'x', binary: bin, timeoutMs: 5000 });
  assert.match(out, /target_folder/);
});

test('callClaude: ENOENT when binary missing', async () => {
  await assert.rejects(
    callClaude({ prompt: 'x', binary: '/nonexistent/claude', timeoutMs: 5000 }),
    (err) => err.code === 'ENOENT' || /ENOENT|not found/.test(err.message),
  );
});

test('callClaude: auth error mapped to claude_auth', async () => {
  const bin = writeFakeBin('echo "Please run claude login" >&2 ; exit 2');
  await assert.rejects(
    callClaude({ prompt: 'x', binary: bin, timeoutMs: 5000 }),
    (err) => err.code === 'claude_auth',
  );
});

test('callClaude: timeout mapped to claude_timeout', async () => {
  const bin = writeFakeBin('sleep 5');
  await assert.rejects(
    callClaude({ prompt: 'x', binary: bin, timeoutMs: 200 }),
    (err) => err.code === 'claude_timeout',
  );
});
```

- [ ] **Step 2: RED**

```bash
cd scripts && npm test
```

Expected: `Cannot find module '../lib/claude-cli'`.

- [ ] **Step 3: Implement**

```javascript
// scripts/lib/claude-cli.js
const { execFile } = require('node:child_process');

const DEFAULT_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

function callClaude({ prompt, binary = DEFAULT_BIN, model = DEFAULT_MODEL, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'json'];
    const child = execFile(
      binary, args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed && err.signal === 'SIGTERM') {
            const e = new Error(`claude_timeout: ${timeoutMs}ms`);
            e.code = 'claude_timeout';
            return reject(e);
          }
          if (err.code === 'ENOENT') {
            const e = new Error(`ENOENT: claude binary not found at "${binary}"`);
            e.code = 'ENOENT';
            return reject(e);
          }
          if (/login|auth|credential/i.test(stderr || err.message)) {
            const e = new Error(`claude_auth: ${(stderr || err.message).trim().slice(0, 200)}`);
            e.code = 'claude_auth';
            return reject(e);
          }
          const e = new Error(`claude_exec: ${(stderr || err.message).trim().slice(0, 200)}`);
          e.code = 'claude_exec';
          return reject(e);
        }
        resolve(stdout);
      }
    );
    child.on('error', () => { /* handled by execFile callback */ });
  });
}

module.exports = { callClaude };
```

- [ ] **Step 4: GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 27` (4 new ones).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/claude-cli.js scripts/test/claude-cli.test.js
git commit -m "feat(claude-cli): execFile wrapper with timeout/auth/ENOENT mapping"
```

---

## Task 9: State machine (`claim`, `markDone`, `markDeadletter`, `release`)

**Files:**

- Create: `scripts/lib/classifier-state.js`
- Create: `scripts/test/state-machine.test.js`

- [ ] **Step 1: Write failing tests with an in-memory pg mock**

```javascript
// scripts/test/state-machine.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claim, markDone, markDeadletter, release, lookup, recoverStaleProcessing } =
  require('../lib/classifier-state');

function fakePg() {
  const rows = new Map();   // path -> row
  const queries = [];
  return {
    rows,
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const op = sql.replace(/\s+/g, ' ').trim();

      if (op.startsWith('SELECT * FROM inbox_classifier_state WHERE path=')) {
        const r = rows.get(params[0]);
        return { rows: r ? [r] : [] };
      }
      if (op.startsWith('INSERT INTO inbox_classifier_state')) {
        const [path, sha] = params;
        const row = { path, sha, status: 'pending', attempts: 0, last_error: null,
                      classified_at: null, started_at: null, target_folder: null,
                      confidence: null };
        rows.set(path, row);
        return { rows: [row] };
      }
      if (op.startsWith('UPDATE inbox_classifier_state SET status=')) {
        // generic update; tests inspect the row directly
        const path = params[params.length - 1]; // WHERE path=$N is last
        const row = rows.get(path) || {};
        // very naive: tests assert by reading rows after the call; we just record the call.
        rows.set(path, row);
        return { rowCount: row ? 1 : 0 };
      }
      throw new Error(`unhandled query: ${op}`);
    },
  };
}

test('claim: inserts row when path is new', async () => {
  const pg = fakePg();
  await claim(pg, '00-inbox/foo.md', 'sha1');
  assert.equal(pg.rows.get('00-inbox/foo.md').status, 'pending');
  assert.ok(pg.queries.some(q => q.sql.startsWith('INSERT INTO inbox_classifier_state')));
});

test('lookup: returns null when no row', async () => {
  const pg = fakePg();
  const r = await lookup(pg, '00-inbox/missing.md');
  assert.equal(r, null);
});

test('lookup: returns existing row', async () => {
  const pg = fakePg();
  pg.rows.set('00-inbox/foo.md', { path: '00-inbox/foo.md', sha: 's', status: 'done' });
  const r = await lookup(pg, '00-inbox/foo.md');
  assert.equal(r.status, 'done');
});

test('markDone: emits UPDATE with status=done', async () => {
  const pg = fakePg();
  pg.rows.set('p', { path: 'p', sha: 's', status: 'processing' });
  await markDone(pg, 'p', { target_folder: '01-knowledge', confidence: 0.9 });
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /SET status='done'/);
  assert.deepEqual(last.params.slice(0, 3), ['01-knowledge', 0.9, 'p']);
});

test('markDeadletter: sets status=deadletter and last_error', async () => {
  const pg = fakePg();
  pg.rows.set('p', { path: 'p', sha: 's', status: 'processing', attempts: 2 });
  await markDeadletter(pg, 'p', { last_error: 'low_conf:0.4', attempts: 3 });
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /SET status='deadletter'/);
  assert.deepEqual(last.params.slice(0, 3), ['low_conf:0.4', 3, 'p']);
});

test('release: returns row to pending and bumps attempts', async () => {
  const pg = fakePg();
  await release(pg, 'p', { last_error: 'parse_error', attempts: 1 });
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /SET status='pending'/);
  assert.deepEqual(last.params.slice(0, 3), ['parse_error', 1, 'p']);
});

test('recoverStaleProcessing: emits UPDATE with status filter', async () => {
  const pg = fakePg();
  await recoverStaleProcessing(pg);
  const last = pg.queries[pg.queries.length - 1];
  assert.match(last.sql, /UPDATE inbox_classifier_state SET status='pending'/);
  assert.match(last.sql, /status='processing'/);
  assert.match(last.sql, /interval '5 min'/);
});
```

- [ ] **Step 2: RED**

```bash
cd scripts && npm test
```

Expected: `Cannot find module '../lib/classifier-state'`.

- [ ] **Step 3: Implement**

```javascript
// scripts/lib/classifier-state.js

async function lookup(pg, path) {
  const { rows } = await pg.query(
    `SELECT * FROM inbox_classifier_state WHERE path=$1`,
    [path]
  );
  return rows[0] || null;
}

async function claim(pg, path, sha) {
  const existing = await lookup(pg, path);
  if (!existing) {
    await pg.query(
      `INSERT INTO inbox_classifier_state (path, sha, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (path) DO NOTHING`,
      [path, sha]
    );
  }
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='processing', started_at=now(), sha=$1, updated_at=now()
      WHERE path=$2`,
    [sha, path]
  );
}

async function markDone(pg, path, { target_folder, confidence }) {
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='done',
            target_folder=$1,
            confidence=$2,
            classified_at=now(),
            last_error=NULL,
            updated_at=now()
      WHERE path=$3`,
    [target_folder, confidence, path]
  );
}

async function markDeadletter(pg, path, { last_error, attempts }) {
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='deadletter',
            last_error=$1,
            attempts=$2,
            updated_at=now()
      WHERE path=$3`,
    [last_error, attempts, path]
  );
}

async function release(pg, path, { last_error, attempts }) {
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='pending',
            last_error=$1,
            attempts=$2,
            updated_at=now()
      WHERE path=$3`,
    [last_error, attempts, path]
  );
}

async function recoverStaleProcessing(pg) {
  const r = await pg.query(
    `UPDATE inbox_classifier_state
        SET status='pending', attempts=attempts+1, updated_at=now()
      WHERE status='processing'
        AND started_at < now() - interval '5 min'
      RETURNING path`
  );
  return (r.rows || []).map(x => x.path);
}

module.exports = { lookup, claim, markDone, markDeadletter, release, recoverStaleProcessing };
```

- [ ] **Step 4: GREEN**

```bash
cd scripts && npm test
```

Expected: `pass 34` (7 new). The `recoverStaleProcessing` test will receive an "unhandled query" from the simple mock — extend the mock to recognise the `UPDATE ... WHERE status='processing'` form by returning `{ rows: [], rowCount: 0 }`. Update `fakePg`:

```javascript
if (op.startsWith("UPDATE inbox_classifier_state SET status='pending'") &&
    op.includes("status='processing'")) {
  return { rows: [], rowCount: 0 };
}
```

Re-run tests; all should pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/classifier-state.js scripts/test/state-machine.test.js
git commit -m "feat(classifier-state): claim/release/markDone/markDeadletter + recoverStale"
```

---

## Task 10: Main loop `inbox-classifier.js`

**Files:**

- Create: `scripts/inbox-classifier.js`

- [ ] **Step 1: Implement the entrypoint**

```javascript
#!/usr/bin/env node
// scripts/inbox-classifier.js
// ofelia-driven: classify /vault/00-inbox/*.md via Haiku (claude CLI), move to target folder.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const lib = require('./lib/vault-lib');
const cls = require('./lib/classifier-lib');
const state = require('./lib/classifier-state');
const { callClaude } = require('./lib/claude-cli');
const metrics = require('./lib/classifier-metrics');

const VAULT = process.env.VAULT_PATH || '/vault';
const INBOX = path.join(VAULT, '00-inbox');
const DEADLETTER = path.join(INBOX, '_deadletter');

const PG = {
  host:     process.env.VAULT_RAG_PG_HOST || 'vault-rag-postgres',
  database: process.env.VAULT_RAG_PG_DB   || 'vault_rag',
  user:     process.env.VAULT_RAG_PG_USER || 'postgres',
  password: process.env.VAULT_RAG_PG_PASS,
  port:     5432,
};

const MAX_ATTEMPTS = parseInt(process.env.INBOX_CLASSIFIER_MAX_ATTEMPTS || '3', 10);
const CONF_THRESHOLD = parseFloat(process.env.INBOX_CLASSIFIER_CONF || '0.7');
const TIMEOUT_MS = parseInt(process.env.INBOX_CLASSIFIER_TIMEOUT_MS || '60000', 10);

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

async function ensureDeadletter() {
  await fs.mkdir(DEADLETTER, { recursive: true });
}

async function moveTo(srcAbs, destAbs) {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  try {
    await fs.rename(srcAbs, destAbs);
    return destAbs;
  } catch (e) {
    if (e.code === 'EEXIST') {
      const ts = Date.now();
      const ext = path.extname(destAbs);
      const stem = destAbs.slice(0, destAbs.length - ext.length);
      const alt = `${stem}-${ts}${ext}`;
      await fs.rename(srcAbs, alt);
      return alt;
    }
    throw e;
  }
}

async function auditClassify(pg, finalRel, shaAfter, bytes) {
  try {
    await pg.query(
      `INSERT INTO vault_audit (agent_id, path, op, sha_before, sha_after, bytes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['inbox-classifier', finalRel, 'classify', null, shaAfter, bytes]
    );
  } catch (e) {
    console.error(`[classifier] audit insert failed: ${e.message}`);
  }
}

async function processOne(pg, file) {
  const abs = path.join(INBOX, file);
  const text = await fs.readFile(abs, 'utf8');
  const { fm, body } = lib.parseFrontmatter(text);

  if (cls.shouldSkip(file, fm)) {
    metrics.skipped.inc();
    return 'skipped';
  }

  const sha = sha1(text);
  const existing = await state.lookup(pg, `00-inbox/${file}`);

  if (existing) {
    if ((existing.status === 'done' || existing.status === 'deadletter') && existing.sha === sha) {
      return 'skipped:already';
    }
    if (existing.status === 'processing' &&
        existing.started_at && (Date.now() - new Date(existing.started_at).getTime()) < 5 * 60 * 1000) {
      return 'skipped:processing';
    }
  }

  await state.claim(pg, `00-inbox/${file}`, sha);
  const t0 = Date.now();

  try {
    const prompt = cls.buildPrompt({ basename: file, frontmatter: fm, body });
    const stdout = await callClaude({ prompt, timeoutMs: TIMEOUT_MS });
    const result = cls.parseClaudeResponse(stdout);

    if (result.confidence < CONF_THRESHOLD) {
      const dest = path.join(DEADLETTER, file);
      await moveTo(abs, dest);
      await state.markDeadletter(pg, `00-inbox/${file}`, {
        last_error: `low_conf:${result.confidence}`,
        attempts: (existing?.attempts || 0) + 1,
      });
      metrics.processed.inc({ status: 'deadletter' });
      metrics.confidence.observe(result.confidence);
      return 'deadletter:low_conf';
    }

    cls.validateTargetFolder(result.target_folder);
    const fmNew = cls.enrichFrontmatter(fm, result, new Date().toISOString());
    const newText = lib.serializeFrontmatter(fmNew, body);
    await fs.writeFile(abs, newText, 'utf8');

    const destRel = `${result.target_folder}/${file}`;
    const destAbs = path.join(VAULT, destRel);
    const finalAbs = await moveTo(abs, destAbs);
    const finalRel = path.relative(VAULT, finalAbs);
    const finalText = await fs.readFile(finalAbs, 'utf8');

    await state.markDone(pg, `00-inbox/${file}`, {
      target_folder: result.target_folder,
      confidence: result.confidence,
    });
    await auditClassify(pg, finalRel, sha1(finalText), Buffer.byteLength(finalText, 'utf8'));
    metrics.processed.inc({ status: 'done' });
    metrics.confidence.observe(result.confidence);
    metrics.duration.observe((Date.now() - t0) / 1000);
    return `done:${result.target_folder}`;
  } catch (e) {
    const attempts = (existing?.attempts || 0) + 1;
    const last_error = `${e.code || 'error'}:${(e.message || '').slice(0, 200)}`;
    if (attempts >= MAX_ATTEMPTS) {
      try {
        const dest = path.join(DEADLETTER, file);
        await moveTo(abs, dest);
      } catch (_) {} // file may have been moved partway
      await state.markDeadletter(pg, `00-inbox/${file}`, { last_error, attempts });
      metrics.processed.inc({ status: 'deadletter' });
      return `deadletter:${e.code || 'error'}`;
    }
    await state.release(pg, `00-inbox/${file}`, { last_error, attempts });
    metrics.processed.inc({ status: 'error' });
    return `retry:${e.code || 'error'}`;
  }
}

async function main() {
  await ensureDeadletter();
  const pg = new Client(PG);
  await pg.connect();

  const recovered = await state.recoverStaleProcessing(pg);
  if (recovered.length) console.log(`[classifier] recovered stale: ${recovered.length}`);

  let entries;
  try {
    entries = await fs.readdir(INBOX);
  } catch (e) {
    if (e.code === 'ENOENT') entries = [];
    else throw e;
  }

  const files = entries.filter(f => f.endsWith('.md'));
  let done = 0, deadletter = 0, skipped = 0, errors = 0;

  for (const f of files) {
    try {
      const r = await processOne(pg, f);
      if (r.startsWith('done')) done++;
      else if (r.startsWith('deadletter')) deadletter++;
      else if (r.startsWith('skipped')) skipped++;
      else errors++;
    } catch (e) {
      console.error(`[classifier] uncaught for ${f}: ${e.stack || e.message}`);
      errors++;
    }
  }

  await metrics.flush();
  await pg.end();
  console.log(`done=${done} deadletter=${deadletter} skipped=${skipped} errors=${errors}`);
}

main().catch((e) => {
  console.error(`[classifier] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Quick smoke parse**

```bash
cd scripts && node -c inbox-classifier.js
```

Expected: no output (parse-clean).

- [ ] **Step 3: Commit**

```bash
git add scripts/inbox-classifier.js
git commit -m "feat(inbox-classifier): main loop wiring (state-machine + claude + audit)"
```

---

## Task 11: Prometheus textfile metrics

**Files:**

- Create: `scripts/lib/classifier-metrics.js`
- Modify: `scripts/package.json` (add `prom-client`)

- [ ] **Step 1: Add `prom-client` dep**

```bash
cd scripts && npm install --save prom-client@^15
```

Expected: lockfile updated, `package.json` shows `"prom-client": "^15.x.x"`.

- [ ] **Step 2: Implement metrics module**

```javascript
// scripts/lib/classifier-metrics.js
const fs = require('node:fs/promises');
const path = require('node:path');
const client = require('prom-client');

const TEXTFILE_DIR = process.env.PROM_TEXTFILE_DIR || '/var/lib/node_exporter/textfile_collector';
const FILE = path.join(TEXTFILE_DIR, 'inbox_classifier.prom');

const reg = new client.Registry();

const processed = new client.Counter({
  name: 'inbox_classifier_processed_total',
  help: 'Files processed by the inbox classifier',
  labelNames: ['status'],
  registers: [reg],
});

const skipped = new client.Counter({
  name: 'inbox_classifier_skipped_total',
  help: 'Files skipped by rule (current-context, type=index, _-prefix, _deadletter)',
  registers: [reg],
});

const confidence = new client.Histogram({
  name: 'inbox_classifier_confidence',
  help: 'Confidence reported by Haiku',
  buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [reg],
});

const duration = new client.Histogram({
  name: 'inbox_classifier_duration_seconds',
  help: 'End-to-end classify duration per file',
  buckets: [1, 5, 10, 30, 60],
  registers: [reg],
});

async function flush() {
  try {
    await fs.mkdir(TEXTFILE_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.writeFile(tmp, await reg.metrics(), 'utf8');
    await fs.rename(tmp, FILE);
  } catch (e) {
    console.error(`[metrics] flush failed: ${e.message}`);
  }
}

module.exports = { processed, skipped, confidence, duration, flush };
```

- [ ] **Step 3: Smoke**

```bash
cd scripts && node -e "require('./lib/classifier-metrics').processed.inc({status:'done'}); require('./lib/classifier-metrics').flush().then(()=>console.log('ok'))"
```

Expected: prints `ok`. (May warn about textfile dir; that is fine - flush silently logs.)

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/classifier-metrics.js scripts/package.json scripts/package-lock.json
git commit -m "feat(classifier-metrics): prom textfile exporter"
```

---

## Task 12: Integration test — fake-claude stub + driver

**Files:**

- Create: `scripts/test/integration/fake-claude.sh`
- Create: `scripts/test/integration/inbox-classifier.test.sh`

- [ ] **Step 1: Write the fake-claude stub**

```bash
#!/usr/bin/env bash
# scripts/test/integration/fake-claude.sh
# Reads -p <prompt> from argv. Decides reply by keywords in the prompt.
# Modes via env:
#   FAKE_CLAUDE_MODE=normal|low_conf|timeout|garbage|auth_fail
set -euo pipefail
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    *)  shift ;;
  esac
done

mode="${FAKE_CLAUDE_MODE:-normal}"
case "$mode" in
  timeout)    sleep 90 ;;
  auth_fail)  echo "Please run claude login" >&2 ; exit 2 ;;
  garbage)    echo "not json at all" ;;
  low_conf)
    cat <<EOF
{"result":"{\"target_folder\":\"06-resources\",\"tags\":[\"x\"],\"summary\":\"low\",\"type\":\"note\",\"confidence\":0.5}"}
EOF
    ;;
  normal|*)
    folder="01-knowledge"
    [[ "$prompt" == *"smoke"* || "$prompt" == *"log"* ]] && folder="05-logs"
    cat <<EOF
{"result":"{\"target_folder\":\"$folder\",\"tags\":[\"auto\",\"test\"],\"summary\":\"fake\",\"type\":\"note\",\"confidence\":0.9}"}
EOF
    ;;
esac
```

```bash
chmod +x scripts/test/integration/fake-claude.sh
```

- [ ] **Step 2: Write the integration driver**

```bash
#!/usr/bin/env bash
# scripts/test/integration/inbox-classifier.test.sh
# Full-stack smoke: tmp vault + tmp pg schema + fake claude.
# Requires: a reachable postgres in env (PG* vars) OR docker compose stack already up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
export VAULT_PATH="$TMP"
mkdir -p "$VAULT_PATH/00-inbox" \
         "$VAULT_PATH/01-knowledge" \
         "$VAULT_PATH/02-projects" \
         "$VAULT_PATH/05-logs" \
         "$VAULT_PATH/06-resources"

export CLAUDE_BIN="$ROOT/scripts/test/integration/fake-claude.sh"
export PROM_TEXTFILE_DIR="$TMP/prom"

# Postgres: assume vault-rag-postgres or PG* env present.
: "${VAULT_RAG_PG_HOST:=127.0.0.1}"
: "${VAULT_RAG_PG_PORT:=5432}"
: "${VAULT_RAG_PG_DB:=vault_rag}"
: "${VAULT_RAG_PG_USER:=postgres}"
: "${VAULT_RAG_PG_PASS:=postgres}"
export VAULT_RAG_PG_HOST VAULT_RAG_PG_PORT VAULT_RAG_PG_DB VAULT_RAG_PG_USER VAULT_RAG_PG_PASS

# Apply schema if not already present.
PGPASSWORD="$VAULT_RAG_PG_PASS" psql -h "$VAULT_RAG_PG_HOST" -p "$VAULT_RAG_PG_PORT" \
  -U "$VAULT_RAG_PG_USER" -d "$VAULT_RAG_PG_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/sql/004-inbox-classifier-state.sql" >/dev/null

# Reset state for these test paths.
PGPASSWORD="$VAULT_RAG_PG_PASS" psql -h "$VAULT_RAG_PG_HOST" -p "$VAULT_RAG_PG_PORT" \
  -U "$VAULT_RAG_PG_USER" -d "$VAULT_RAG_PG_DB" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM inbox_classifier_state WHERE path LIKE '00-inbox/it-%'" >/dev/null

# Fixtures.
cat > "$VAULT_PATH/00-inbox/it-valid.md" <<'MD'
# Valid note
Body of a perfectly classifiable note.
MD

cat > "$VAULT_PATH/00-inbox/it-skip.md" <<'MD'
---
type: index
---
# Index file
MD
mv "$VAULT_PATH/00-inbox/it-skip.md" "$VAULT_PATH/00-inbox/current-context.md"

cat > "$VAULT_PATH/00-inbox/it-low.md" <<'MD'
# Ambiguous
short
MD

# Run classifier in normal mode for the valid file.
node "$ROOT/scripts/inbox-classifier.js"

# Re-run for the low-conf file in low_conf mode.
FAKE_CLAUDE_MODE=low_conf node "$ROOT/scripts/inbox-classifier.js"

# Assertions.
test -f "$VAULT_PATH/01-knowledge/it-valid.md" || { echo FAIL: it-valid not moved; exit 1; }
test -f "$VAULT_PATH/00-inbox/current-context.md" || { echo FAIL: current-context.md was moved; exit 1; }
test -f "$VAULT_PATH/00-inbox/_deadletter/it-low.md" || { echo FAIL: it-low not in deadletter; exit 1; }

# Frontmatter enriched?
grep -q 'classified_by: haiku/inbox-classifier-v1' "$VAULT_PATH/01-knowledge/it-valid.md" \
  || { echo FAIL: frontmatter not enriched; exit 1; }

# Audit row present?
PGPASSWORD="$VAULT_RAG_PG_PASS" psql -h "$VAULT_RAG_PG_HOST" -p "$VAULT_RAG_PG_PORT" \
  -U "$VAULT_RAG_PG_USER" -d "$VAULT_RAG_PG_DB" -tAc \
  "SELECT count(*) FROM vault_audit WHERE op='classify' AND path='01-knowledge/it-valid.md'" \
  | grep -q '^[1-9]' || { echo FAIL: audit row missing; exit 1; }

echo OK
```

```bash
chmod +x scripts/test/integration/inbox-classifier.test.sh
```

- [ ] **Step 3: Run integration test against the prod docker stack**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "cd /opt/vault-rag && docker compose exec -T -e VAULT_RAG_PG_PASS=\$POSTGRES_PASSWORD vault-rag-tools \
     bash /scripts/test/integration/inbox-classifier.test.sh"
```

Expected last line: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/test/integration/
git commit -m "test(inbox-classifier): integration with fake-claude stub"
```

---

## Task 13: `Dockerfile.tools` — install claude CLI

**Files:**

- Modify: `Dockerfile.tools`

- [ ] **Step 1: Add the install line**

Open `Dockerfile.tools` and append to the `RUN apk add ...` block (or as a new `RUN`):

```dockerfile
# Anthropic Claude Code CLI for inbox-classifier (subscription auth via mounted credentials)
RUN npm install -g @anthropic-ai/claude-code
```

- [ ] **Step 2: Build**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "cd /opt/vault-rag && docker compose build vault-rag-tools"
```

Expected: image rebuilt, `claude` available.

- [ ] **Step 3: Verify the binary in the image**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "docker run --rm --entrypoint=claude vault-rag-tools --version"
```

Expected: prints a claude-code version string (no errors).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.tools
git commit -m "feat(docker): install @anthropic-ai/claude-code in tools image"
```

---

## Task 14: `docker-compose.yml` — credentials mount + ofelia label

**Files:**

- Modify: `docker-compose.yml`

- [ ] **Step 1: On the host, ensure `claude` is logged in**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es 'ls -l /root/.claude/.credentials.json'
```

Expected: file exists. If not, run `claude login` on the host first.

- [ ] **Step 2: Edit compose**

Locate the `vault-rag-tools` service and add to its `volumes:`:

```yaml
- /root/.claude/.credentials.json:/root/.claude/.credentials.json:ro
- /root/.claude/settings.json:/root/.claude/settings.json:ro
```

(If `settings.json` does not exist on the host, omit that line.)

In the same service, add to its `labels:` (alongside the existing `vault-indexer` ofelia labels):

```yaml
ofelia.job-exec.inbox-classifier.schedule: "${INBOX_CLASSIFIER_SCHEDULE:-@every 15m}"
ofelia.job-exec.inbox-classifier.command: "node /scripts/run-job.js inbox-classifier node /scripts/inbox-classifier.js"
ofelia.job-exec.inbox-classifier.no-overlap: "true"
```

- [ ] **Step 3: Apply and verify ofelia picked it up**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "cd /opt/vault-rag && docker compose up -d vault-rag-tools && docker logs --tail 50 vault-rag-ofelia"
```

Expected: ofelia logs show the new `inbox-classifier` job registered.

- [ ] **Step 4: Manual one-off run on the inbox**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "docker exec vault-rag-tools node /scripts/run-job.js inbox-classifier node /scripts/inbox-classifier.js"
```

Expected output last line: `done=N deadletter=M skipped=K errors=0`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(compose): mount claude creds + ofelia inbox-classifier job"
```

---

## Task 15: Operations runbook

**Files:**

- Modify: `docs/operations.md`

- [ ] **Step 1: Append a runbook section**

Append the following to `docs/operations.md`:

```markdown
## Inbox auto-classifier

Runs every 15 minutes inside `vault-rag-tools` via ofelia. Reads `00-inbox/*.md`, classifies via
Haiku (claude CLI), and either moves the file to `01-knowledge/`, `02-projects/`, `05-logs/`, or
`06-resources/` (with enriched frontmatter), or routes it to `00-inbox/_deadletter/`.

**State table:** `inbox_classifier_state` (status: pending/processing/done/deadletter, attempts, last_error).
**Audit:** rows in `vault_audit` with `op='classify'`.
**Metrics:** Prometheus textfile at `/var/lib/node_exporter/textfile_collector/inbox_classifier.prom`.

### Manual trigger

```bash
docker exec vault-rag-tools node /scripts/run-job.js inbox-classifier node /scripts/inbox-classifier.js
```

### Inspecting state

```sql
SELECT path, status, attempts, last_error, classified_at
  FROM inbox_classifier_state
  ORDER BY updated_at DESC
  LIMIT 20;
```

### Dead-letter triage

Files routed to `00-inbox/_deadletter/` failed either with `low_conf:<n>` (Haiku not confident) or after 3
attempts. Inspect `last_error` in the state table, then either fix the file (rewrite, add hint) and move it
back to `00-inbox/` (state row is reset on sha change), or move it manually to the right folder and `DELETE`
its row from `inbox_classifier_state`.

### Rotating Haiku credentials

`~/.claude/.credentials.json` on the host is bind-mounted (ro). Run `claude login` on the host to refresh; the
container picks it up on the next ofelia tick (no rebuild needed).
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations.md
git commit -m "docs(ops): inbox-classifier runbook"
```

---

## Task 16: Prod smoke

**Files:** none.

- [ ] **Step 1: Drop a smoke file**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "echo '# smoke $(date -Iseconds)' > /root/obsidian-vault/00-inbox/classifier-smoke-$(date +%s).md"
```

- [ ] **Step 2: Trigger immediately**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "docker exec vault-rag-tools node /scripts/run-job.js inbox-classifier node /scripts/inbox-classifier.js"
```

Expected: `done=1 deadletter=0 skipped=N errors=0`.

- [ ] **Step 3: Verify the file moved with enriched frontmatter**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "ls /root/obsidian-vault/05-logs/ | grep classifier-smoke && \
   head -20 /root/obsidian-vault/05-logs/classifier-smoke-*.md"
```

Expected: file present in `05-logs/`, frontmatter contains `classified_by: haiku/inbox-classifier-v1`.

- [ ] **Step 4: Verify metric file**

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es \
  "cat /var/lib/node_exporter/textfile_collector/inbox_classifier.prom | grep -E 'processed_total|confidence'"
```

Expected: counter lines for `inbox_classifier_processed_total{status="done"}` with non-zero values.

- [ ] **Step 5: Close vt-0032 epic**

```bash
/root/work/vault-rag-oss/scripts/bin/vt close vt-0032 --reason "Inbox auto-classifier deployed and smoke-passed"
```

---

## Self-review notes

- Spec coverage:
  - Schema (state table) → Task 1.
  - Script + helpers → Tasks 3-10.
  - Skip rules / confidence threshold / retry / dead-letter / idempotency → Task 5, 9, 10.
  - Claude CLI install + creds mount + ofelia → Tasks 13-14.
  - Metrics → Task 11.
  - Audit log → Task 10 (`auditClassify`).
  - Tests (unit + integration + smoke) → Tasks 3-9, 12, 16.
  - Operations doc → Task 15.
- Type/name consistency:
  - `markDone` / `markDeadletter` / `release` / `claim` / `lookup` / `recoverStaleProcessing` are referenced consistently between `classifier-state.js` and `inbox-classifier.js`.
  - `parseClaudeResponse` / `validateTargetFolder` / `shouldSkip` / `enrichFrontmatter` / `buildPrompt` exports stay aligned across tasks.
  - Audit table is `vault_audit` (not `audit_log`) — matches existing schema in `sql/001-init.sql`.
- No placeholders: every code step contains complete code; every command step has expected output.
