# Secrets Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build server-side age-encrypted secret storage extending vault-rag, exposed via existing MCP shim tools + REST API + `vt secrets` CLI subcommands.

**Architecture:** New `SecretsHandler` module loaded by `rag-api.js` reads server-side age private key, maintains in-RAM decrypted blob, exposes `/api/secrets/*` REST endpoints. `mcp-shim.js` adds wrapper tools. `vt.js` adds `secrets` subcommand calling REST.

**Tech Stack:** Node.js (existing rag-api/mcp-shim/vt), `age` binary subprocess, git CLI subprocess, no new npm deps.

**Reference spec:** `docs/superpowers/specs/2026-05-14-secrets-vault-design.md`

---

## File Structure

**Create:**
- `scripts/secrets-handler.js` — `SecretsHandler` class (in-RAM cache, age subprocess, git ops, optimistic concurrency)
- `scripts/secrets-bootstrap.sh` — one-time server bootstrap (age-keygen + recipients + initial vault.age)
- `scripts/migrate-to-vault.sh` — one-time migration of existing client secrets
- `tests/secrets-handler.test.js` — unit tests for handler
- `tests/secrets-api.integration.test.js` — REST API integration (spawns ephemeral rag-api with mock-git)
- `obsidian-vault/secrets/README.md` — short usage docs (created by bootstrap)
- `obsidian-vault/secrets/.gitignore` — blocks plaintext (created by bootstrap)

**Modify:**
- `scripts/rag-api.js` — add `/api/secrets/*` handlers (5-6 routes)
- `scripts/mcp-shim.js` — add `secret_*` tools in `TOOLS` array + delegate handlers
- `scripts/vt.js` — add `secrets` subcommand parser
- `docker-compose.yml` — mount `/opt/vault-rag/.secrets/age.key` read-only into `vault-rag-api` container
- `Dockerfile.tools` — add `age` package install
- `.env.example` — document `VAULT_AGE_KEY_PATH` (path inside container)

---

## Task 1: SecretsHandler module — encrypt/decrypt round-trip

**Files:**
- Create: `scripts/secrets-handler.js`
- Create: `tests/secrets-handler.test.js`

- [ ] **Step 1: Write the failing test (decrypt of just-encrypted blob)**

```javascript
// tests/secrets-handler.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { SecretsHandler } = require('../scripts/secrets-handler.js');

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-test-'));
  // generate age keypair
  execSync(`age-keygen -o ${dir}/age.key 2>/dev/null`);
  const pub = execSync(`grep '^# public key:' ${dir}/age.key | cut -d: -f2 | tr -d ' '`).toString().trim();
  fs.writeFileSync(`${dir}/recipients`, `# host: test\n${pub}\n`);
  return { dir, ageKey: `${dir}/age.key`, recipients: `${dir}/recipients`, vaultAge: `${dir}/vault.age` };
}

(async () => {
  const t = makeTmp();
  const initial = { _meta: { schema: 1, version: 1, rotated_at: {} } };
  // encrypt initial with age CLI
  execSync(`echo '${JSON.stringify(initial)}' | age -R ${t.recipients} -o ${t.vaultAge}`);

  const h = new SecretsHandler({
    ageKeyPath: t.ageKey,
    recipientsPath: t.recipients,
    vaultAgePath: t.vaultAge,
    repoPath: t.dir,
    skipGit: true,                // unit test: skip git ops
  });
  const blob = await h._decryptVaultAge();
  assert.strictEqual(blob._meta.version, 1);
  console.log('round-trip OK');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/work/vault-rag-oss && node tests/secrets-handler.test.js`
Expected: FAIL with `Cannot find module '../scripts/secrets-handler.js'`

- [ ] **Step 3: Implement minimal SecretsHandler with `_decryptVaultAge`**

```javascript
// scripts/secrets-handler.js
const { spawn } = require('child_process');
const fs = require('fs');

class NotFound extends Error {}
class ConflictRetriesExhausted extends Error {}

function execCmd(cmd, args, { stdin, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr}`));
      resolve(stdout);
    });
    if (stdin !== undefined) proc.stdin.end(stdin);
    else proc.stdin.end();
  });
}

class SecretsHandler {
  constructor({ ageKeyPath, recipientsPath, vaultAgePath, repoPath, skipGit = false, fetchTtlMs = 10_000 }) {
    this.ageKeyPath = ageKeyPath;
    this.recipientsPath = recipientsPath;
    this.vaultAgePath = vaultAgePath;
    this.repoPath = repoPath;
    this.skipGit = skipGit;
    this.fetchTtlMs = fetchTtlMs;
    this._blob = null;
    this._blobSha = null;
    this._lastFetch = 0;
    this._writeMutex = Promise.resolve();
  }

  async _decryptVaultAge() {
    const out = await execCmd('age', ['-d', '-i', this.ageKeyPath, this.vaultAgePath]);
    return JSON.parse(out.toString('utf8'));
  }
}

module.exports = { SecretsHandler, NotFound, ConflictRetriesExhausted };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/secrets-handler.test.js`
Expected: `round-trip OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/secrets-handler.js tests/secrets-handler.test.js
git commit -m "feat(secrets): SecretsHandler decrypt round-trip"
```

---

## Task 2: encrypt + write + integrity check

**Files:**
- Modify: `scripts/secrets-handler.js` (add `_encryptAndWrite`)
- Modify: `tests/secrets-handler.test.js` (add encrypt-then-decrypt test)

- [ ] **Step 1: Write the failing test (encrypt then re-decrypt)**

Append to `tests/secrets-handler.test.js`:

```javascript
(async () => {
  const t = makeTmp();
  // initial empty
  execSync(`echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${t.recipients} -o ${t.vaultAge}`);

  const h = new SecretsHandler({
    ageKeyPath: t.ageKey, recipientsPath: t.recipients,
    vaultAgePath: t.vaultAge, repoPath: t.dir, skipGit: true,
  });
  const blob = await h._decryptVaultAge();
  blob.MY_KEY = 'super-secret-value';
  blob._meta.version += 1;
  await h._encryptAndWrite(blob);

  const back = await h._decryptVaultAge();
  assert.strictEqual(back.MY_KEY, 'super-secret-value');
  assert.strictEqual(back._meta.version, 2);
  console.log('encrypt-write OK');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/secrets-handler.test.js`
Expected: FAIL with `h._encryptAndWrite is not a function`

- [ ] **Step 3: Implement `_encryptAndWrite`**

Add to `scripts/secrets-handler.js` inside `SecretsHandler`:

```javascript
  async _encryptAndWrite(blob) {
    const json = JSON.stringify(blob);
    const encrypted = await execCmd('age', ['-R', this.recipientsPath], { stdin: json });
    fs.writeFileSync(this.vaultAgePath, encrypted);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/secrets-handler.test.js`
Expected: `round-trip OK` AND `encrypt-write OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/secrets-handler.js tests/secrets-handler.test.js
git commit -m "feat(secrets): SecretsHandler encrypt+write"
```

---

## Task 3: Public API methods — get / list / set (no git yet)

**Files:**
- Modify: `scripts/secrets-handler.js` (add `get`, `list`, `set`)
- Modify: `tests/secrets-handler.test.js` (add API tests)

- [ ] **Step 1: Write failing test for get/list/set without git**

Append to `tests/secrets-handler.test.js`:

```javascript
(async () => {
  const t = makeTmp();
  execSync(`echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${t.recipients} -o ${t.vaultAge}`);
  const h = new SecretsHandler({
    ageKeyPath: t.ageKey, recipientsPath: t.recipients,
    vaultAgePath: t.vaultAge, repoPath: t.dir, skipGit: true,
  });

  // list initially empty
  assert.deepStrictEqual(await h.list(), []);

  // set + get
  await h.set('K1', 'v1');
  assert.strictEqual(await h.get('K1'), 'v1');

  // list shows K1, no _meta
  assert.deepStrictEqual(await h.list(), ['K1']);

  // get missing → NotFound
  try { await h.get('MISSING'); assert.fail('expected NotFound'); }
  catch (e) { assert.ok(e instanceof NotFound, 'wrong error type'); }

  console.log('api basics OK');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/secrets-handler.test.js`
Expected: FAIL with `h.list is not a function`

- [ ] **Step 3: Implement get/list/set (with skipGit branch)**

Add to `scripts/secrets-handler.js`:

```javascript
  async _ensureFresh() {
    if (this.skipGit) {
      // unit-test mode: always re-read from disk
      this._blob = await this._decryptVaultAge();
      return;
    }
    const now = Date.now();
    if (now - this._lastFetch < this.fetchTtlMs && this._blob) return;
    await this._gitFetch();
    const remoteSha = await this._headShaForFile('obsidian-vault/secrets/vault.age');
    if (remoteSha !== this._blobSha) {
      await this._gitPull();
      this._blob = await this._decryptVaultAge();
      this._blobSha = remoteSha;
    }
    this._lastFetch = now;
  }

  async get(name) {
    await this._ensureFresh();
    if (!(name in this._blob)) throw new NotFound(`secret not found: ${name}`);
    return this._blob[name];
  }

  async list() {
    await this._ensureFresh();
    return Object.keys(this._blob).filter((k) => k !== '_meta').sort();
  }

  async set(name, value) {
    // Serialize all writes through a single-slot mutex.
    const release = await this._acquireWriteLock();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!this.skipGit) await this._gitPull();
        const blob = await this._decryptVaultAge();
        blob[name] = value;
        blob._meta = blob._meta || { schema: 1, version: 0, rotated_at: {} };
        blob._meta.version = (blob._meta.version || 0) + 1;
        await this._encryptAndWrite(blob);
        if (this.skipGit) {
          this._blob = blob;
          return null;
        }
        try {
          await this._gitCommit(`secrets: set ${name}`);
          await this._gitPush();
          this._blob = blob;
          this._blobSha = null;
          return await this._headShaForFile('obsidian-vault/secrets/vault.age');
        } catch (e) {
          if (!isPushReject(e)) throw e;
          await this._gitResetHard();
          continue;
        }
      }
      throw new ConflictRetriesExhausted('git push rejected 3 times in a row');
    } finally {
      release();
    }
  }

  _acquireWriteLock() {
    let release;
    const next = new Promise((r) => { release = r; });
    const prev = this._writeMutex;
    this._writeMutex = next;
    return prev.then(() => release);
  }
```

Also at top of file, add stub `isPushReject`:

```javascript
function isPushReject(err) {
  const msg = (err.message || '') + '';
  return msg.includes('non-fast-forward') || msg.includes('rejected');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/secrets-handler.test.js`
Expected: previous tests OK + `api basics OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/secrets-handler.js tests/secrets-handler.test.js
git commit -m "feat(secrets): SecretsHandler get/list/set with write mutex"
```

---

## Task 4: delete + rotate + verify

**Files:**
- Modify: `scripts/secrets-handler.js`
- Modify: `tests/secrets-handler.test.js`

- [ ] **Step 1: Write failing tests for delete/rotate/verify**

Append:

```javascript
(async () => {
  const t = makeTmp();
  execSync(`echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${t.recipients} -o ${t.vaultAge}`);
  const h = new SecretsHandler({
    ageKeyPath: t.ageKey, recipientsPath: t.recipients,
    vaultAgePath: t.vaultAge, repoPath: t.dir, skipGit: true,
  });
  await h.set('K1', 'v1');
  await h.set('K2', 'v2');

  // delete
  await h.delete('K1');
  assert.deepStrictEqual(await h.list(), ['K2']);
  try { await h.get('K1'); assert.fail(); } catch (e) { assert.ok(e instanceof NotFound); }

  // delete missing → NotFound
  try { await h.delete('MISSING'); assert.fail(); } catch (e) { assert.ok(e instanceof NotFound); }

  // rotate with explicit value
  await h.rotate('K2', 'v2-new');
  assert.strictEqual(await h.get('K2'), 'v2-new');
  const blob = await h._decryptVaultAge();
  assert.ok(blob._meta.rotated_at.K2, 'rotated_at not set');

  // rotate without value → generated 32-byte hex
  await h.rotate('GENERATED');
  const gen = await h.get('GENERATED');
  assert.strictEqual(gen.length, 64);                 // 32 bytes hex
  assert.ok(/^[0-9a-f]+$/.test(gen), 'not hex');

  // verify
  const v = await h.verify();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.count, 2);                     // K2, GENERATED
  console.log('delete/rotate/verify OK');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/secrets-handler.test.js`
Expected: FAIL with `h.delete is not a function`

- [ ] **Step 3: Implement delete/rotate/verify**

Add to `SecretsHandler`:

```javascript
  async delete(name) {
    const release = await this._acquireWriteLock();
    try {
      if (!this.skipGit) await this._gitPull();
      const blob = await this._decryptVaultAge();
      if (!(name in blob)) throw new NotFound(`secret not found: ${name}`);
      delete blob[name];
      if (blob._meta && blob._meta.rotated_at) delete blob._meta.rotated_at[name];
      blob._meta = blob._meta || { schema: 1, version: 0, rotated_at: {} };
      blob._meta.version = (blob._meta.version || 0) + 1;
      await this._encryptAndWrite(blob);
      if (this.skipGit) {
        this._blob = blob;
        return null;
      }
      await this._gitCommit(`secrets: delete ${name}`);
      await this._gitPush();
      this._blob = blob;
      this._blobSha = null;
      return await this._headShaForFile('obsidian-vault/secrets/vault.age');
    } finally {
      release();
    }
  }

  async rotate(name, newValue) {
    const value = newValue ?? require('crypto').randomBytes(32).toString('hex');
    const release = await this._acquireWriteLock();
    try {
      if (!this.skipGit) await this._gitPull();
      const blob = await this._decryptVaultAge();
      blob[name] = value;
      blob._meta = blob._meta || { schema: 1, version: 0, rotated_at: {} };
      blob._meta.rotated_at = blob._meta.rotated_at || {};
      blob._meta.rotated_at[name] = new Date().toISOString().slice(0, 10);
      blob._meta.version = (blob._meta.version || 0) + 1;
      await this._encryptAndWrite(blob);
      if (this.skipGit) {
        this._blob = blob;
        return null;
      }
      await this._gitCommit(`secrets: rotate ${name}`);
      await this._gitPush();
      this._blob = blob;
      this._blobSha = null;
      return await this._headShaForFile('obsidian-vault/secrets/vault.age');
    } finally {
      release();
    }
  }

  async verify() {
    try {
      const blob = await this._decryptVaultAge();
      return {
        ok: true,
        version: (blob._meta && blob._meta.version) || 0,
        last_rotated: (blob._meta && blob._meta.rotated_at) || {},
        count: Object.keys(blob).filter((k) => k !== '_meta').length,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/secrets-handler.test.js`
Expected: all previous + `delete/rotate/verify OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/secrets-handler.js tests/secrets-handler.test.js
git commit -m "feat(secrets): SecretsHandler delete/rotate/verify"
```

---

## Task 5: git ops + push-reject retry

**Files:**
- Modify: `scripts/secrets-handler.js`

- [ ] **Step 1: Write the failing test (set with real git, simulated push reject)**

Append to `tests/secrets-handler.test.js`:

```javascript
(async () => {
  // Create bare remote + two clones; modify both, set in clone A first,
  // then attempt set in clone B (expecting CAS retry).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-git-'));
  const bare = `${root}/origin.git`;
  execSync(`git init --bare ${bare}`);
  execSync(`age-keygen -o ${root}/age.key 2>/dev/null`);
  const pub = execSync(`grep '^# public key:' ${root}/age.key | cut -d: -f2 | tr -d ' '`).toString().trim();
  fs.writeFileSync(`${root}/recipients`, `${pub}\n`);

  function clone(name) {
    const c = `${root}/${name}`;
    execSync(`git clone ${bare} ${c} -q 2>/dev/null`);
    execSync(`cd ${c} && git config user.email t@t && git config user.name t`);
    fs.mkdirSync(`${c}/obsidian-vault/secrets`, { recursive: true });
    fs.copyFileSync(`${root}/recipients`, `${c}/obsidian-vault/secrets/recipients`);
    return c;
  }

  const A = clone('a');
  // seed initial vault.age and push from A
  execSync(`echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${A}/obsidian-vault/secrets/recipients -o ${A}/obsidian-vault/secrets/vault.age`);
  execSync(`cd ${A} && git add . && git commit -q -m init && git push -q origin master 2>/dev/null || (cd ${A} && git push -q origin HEAD:master 2>/dev/null)`);

  const B = clone('b');
  execSync(`cd ${B} && git pull -q`);

  const ha = new SecretsHandler({
    ageKeyPath: `${root}/age.key`,
    recipientsPath: `${A}/obsidian-vault/secrets/recipients`,
    vaultAgePath: `${A}/obsidian-vault/secrets/vault.age`,
    repoPath: A,
  });
  const hb = new SecretsHandler({
    ageKeyPath: `${root}/age.key`,
    recipientsPath: `${B}/obsidian-vault/secrets/recipients`,
    vaultAgePath: `${B}/obsidian-vault/secrets/vault.age`,
    repoPath: B,
  });

  // A sets K_A first
  await ha.set('K_A', 'va');
  // B tries to set K_B — its initial push will reject, retry should succeed
  await hb.set('K_B', 'vb');

  // After both ops, B's HEAD must contain both keys
  execSync(`cd ${B} && git pull -q`);
  const final = JSON.parse((await hb._decryptVaultAge()) && JSON.stringify(await hb._decryptVaultAge()));
  assert.strictEqual(final.K_A, 'va');
  assert.strictEqual(final.K_B, 'vb');
  console.log('git CAS retry OK');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/secrets-handler.test.js`
Expected: FAIL with `this._gitPull is not a function`

- [ ] **Step 3: Implement git ops**

Add to `SecretsHandler`:

```javascript
  async _gitFetch() {
    await execCmd('git', ['fetch', '--quiet', 'origin'], { cwd: this.repoPath });
  }
  async _gitPull() {
    await execCmd('git', ['pull', '--rebase', '--quiet', 'origin'], { cwd: this.repoPath });
  }
  async _gitResetHard() {
    await execCmd('git', ['fetch', '--quiet', 'origin'], { cwd: this.repoPath });
    // origin/HEAD may be master or main; resolve symbolic ref
    const head = (await execCmd('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: this.repoPath })).toString().trim();
    await execCmd('git', ['reset', '--hard', head], { cwd: this.repoPath });
  }
  async _gitCommit(msg) {
    await execCmd('git', ['add', this.vaultAgePath], { cwd: this.repoPath });
    await execCmd('git', ['commit', '-m', msg, '--quiet'], { cwd: this.repoPath });
  }
  async _gitPush() {
    await execCmd('git', ['push', '--quiet', 'origin', 'HEAD'], { cwd: this.repoPath });
  }
  async _headShaForFile(relPath) {
    const out = await execCmd('git', ['log', '-1', '--pretty=%H', '--', relPath], { cwd: this.repoPath });
    return out.toString().trim();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/secrets-handler.test.js`
Expected: all previous + `git CAS retry OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/secrets-handler.js tests/secrets-handler.test.js
git commit -m "feat(secrets): SecretsHandler git ops + CAS retry"
```

---

## Task 6: REST API handlers in rag-api.js

**Files:**
- Modify: `scripts/rag-api.js`
- Create: `tests/secrets-api.integration.test.js`

- [ ] **Step 1: Write the failing integration test**

```javascript
// tests/secrets-api.integration.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const http = require('http');
const assert = require('assert');

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-int-'));
  const bare = `${root}/origin.git`;
  execSync(`git init --bare ${bare}`);
  const clone = `${root}/clone`;
  execSync(`git clone ${bare} ${clone} -q 2>/dev/null`);
  execSync(`cd ${clone} && git config user.email t@t && git config user.name t`);
  execSync(`age-keygen -o ${root}/age.key 2>/dev/null`);
  const pub = execSync(`grep '^# public key:' ${root}/age.key | cut -d: -f2 | tr -d ' '`).toString().trim();
  fs.mkdirSync(`${clone}/obsidian-vault/secrets`, { recursive: true });
  fs.writeFileSync(`${clone}/obsidian-vault/secrets/recipients`, `${pub}\n`);
  execSync(`echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${clone}/obsidian-vault/secrets/recipients -o ${clone}/obsidian-vault/secrets/vault.age`);
  execSync(`cd ${clone} && git add . && git commit -q -m init && git push -q origin HEAD:master`);
  return { root, clone, ageKey: `${root}/age.key` };
}

function callApi(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'authorization': 'Bearer T' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  const t = setupRepo();
  const PORT = 5700 + Math.floor(Math.random() * 100);
  const api = spawn('node', ['scripts/rag-api.js'], {
    env: {
      ...process.env,
      RAG_PORT: String(PORT),
      VAULT_RAG_API_TOKEN: 'T',
      VAULT_AGE_KEY_PATH: t.ageKey,
      VAULT_REPO_PATH: t.clone,
      VAULT_AGE_PATH: `${t.clone}/obsidian-vault/secrets/vault.age`,
      VAULT_RECIPIENTS_PATH: `${t.clone}/obsidian-vault/secrets/recipients`,
      VAULT_SECRETS_SKIP_PG: '1',                  // skip postgres connect for test
    },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 800));

  try {
    let r = await callApi(PORT, '/api/secrets/list', {});
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.names, []);

    r = await callApi(PORT, '/api/secrets/set', { name: 'X', value: 'y' });
    assert.strictEqual(r.code, 200);
    assert.ok(r.body.committed_sha);

    r = await callApi(PORT, '/api/secrets/get', { name: 'X' });
    assert.strictEqual(r.body.value, 'y');

    r = await callApi(PORT, '/api/secrets/list', {});
    assert.deepStrictEqual(r.body.names, ['X']);

    r = await callApi(PORT, '/api/secrets/get', { name: 'MISSING' });
    assert.strictEqual(r.code, 404);

    console.log('rest api integration OK');
  } finally {
    api.kill();
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/secrets-api.integration.test.js`
Expected: FAIL (404 or connection refused or invalid route).

- [ ] **Step 3: Read current rag-api.js handler routing**

```bash
sed -n '230,260p' scripts/rag-api.js
```

You'll see the `http.createServer(async (req, res) => { ... })` dispatcher. Note the route pattern (likely `if (req.url === '/api/get') ...`).

- [ ] **Step 4: Add secrets handlers + routing**

Add near top of `scripts/rag-api.js` after existing requires:

```javascript
const { SecretsHandler, NotFound, ConflictRetriesExhausted } = require('./secrets-handler.js');

let secretsHandler = null;
function getSecretsHandler() {
  if (!secretsHandler) {
    secretsHandler = new SecretsHandler({
      ageKeyPath: process.env.VAULT_AGE_KEY_PATH,
      recipientsPath: process.env.VAULT_RECIPIENTS_PATH || '/opt/vault-rag/obsidian-vault/secrets/recipients',
      vaultAgePath: process.env.VAULT_AGE_PATH || '/opt/vault-rag/obsidian-vault/secrets/vault.age',
      repoPath: process.env.VAULT_REPO_PATH || '/opt/vault-rag',
    });
  }
  return secretsHandler;
}

async function handleSecretGet(body) {
  const { name } = body;
  try {
    const value = await getSecretsHandler().get(name);
    return { code: 200, body: { value } };
  } catch (e) {
    if (e instanceof NotFound) return { code: 404, body: { error: 'not_found', name } };
    throw e;
  }
}
async function handleSecretList()           { return { code: 200, body: { names: await getSecretsHandler().list() } }; }
async function handleSecretSet(body)        { return { code: 200, body: { committed_sha: await getSecretsHandler().set(body.name, body.value) } }; }
async function handleSecretDelete(body) {
  try { return { code: 200, body: { committed_sha: await getSecretsHandler().delete(body.name) } }; }
  catch (e) { if (e instanceof NotFound) return { code: 404, body: { error: 'not_found', name: body.name } }; throw e; }
}
async function handleSecretRotate(body)     { return { code: 200, body: { committed_sha: await getSecretsHandler().rotate(body.name, body.value) } }; }
async function handleSecretVerify()         { return { code: 200, body: await getSecretsHandler().verify() }; }
```

In the `http.createServer` dispatcher block, add route cases (location: inside existing `if (req.url === ...)` chain — match style of existing handlers like `handleSearch`):

```javascript
    if (req.url === '/api/secrets/get')    { const r = await handleSecretGet(body);    return send(res, r.code, r.body); }
    if (req.url === '/api/secrets/list')   { const r = await handleSecretList();       return send(res, r.code, r.body); }
    if (req.url === '/api/secrets/set')    { const r = await handleSecretSet(body);    return send(res, r.code, r.body); }
    if (req.url === '/api/secrets/delete') { const r = await handleSecretDelete(body); return send(res, r.code, r.body); }
    if (req.url === '/api/secrets/rotate') { const r = await handleSecretRotate(body); return send(res, r.code, r.body); }
    if (req.url === '/api/secrets/verify') { const r = await handleSecretVerify();     return send(res, r.code, r.body); }
```

Also: wrap the existing `pgConnect()` call so it doesn't fail in test mode. Find the early code that calls `pgConnect()`, change to:

```javascript
if (!process.env.VAULT_SECRETS_SKIP_PG) {
  await pgConnect();  // existing line
}
```

(The integration test sets `VAULT_SECRETS_SKIP_PG=1` to bypass PG which isn't needed for secrets-only tests.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/secrets-api.integration.test.js`
Expected: `rest api integration OK`

- [ ] **Step 6: Commit**

```bash
git add scripts/rag-api.js tests/secrets-api.integration.test.js
git commit -m "feat(secrets): REST API /api/secrets/* in rag-api"
```

---

## Task 7: MCP shim tools

**Files:**
- Modify: `scripts/mcp-shim.js`

- [ ] **Step 1: Read current TOOLS array structure**

```bash
sed -n '20,90p' scripts/mcp-shim.js
```

Note the schema: each tool has `name`, `description`, `inputSchema`, and elsewhere there's a handler dispatch.

- [ ] **Step 2: Add 6 new tool definitions**

In `scripts/mcp-shim.js`, append to the `TOOLS` array (before the closing `];`):

```javascript
  {
    name: 'secret_get',
    description: 'Read a secret value by name. Returns the plain-text value. Secrets are stored age-encrypted in vault-rag git; server decrypts on the fly.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Secret name (e.g. GITLAB_TOKEN)' } },
      required: ['name'],
    },
  },
  {
    name: 'secret_list',
    description: 'List all secret names (no values). Excludes the _meta entry.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'secret_set',
    description: 'Create or update a secret. Triggers a git commit + push. Returns committed sha.',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Secret name' },
        value: { type: 'string', description: 'Secret value (plain-text)' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'secret_delete',
    description: 'Delete a secret by name. Triggers commit + push.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'secret_rotate',
    description: 'Rotate a secret value. If value not given, server generates 32-byte hex. Updates _meta.rotated_at[name].',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string' },
        value: { type: ['string', 'null'], description: 'Optional new value (null → server generates)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'secret_verify',
    description: 'Health check: confirm the encrypted vault decrypts and report version/count.',
    inputSchema: { type: 'object', properties: {} },
  },
```

- [ ] **Step 3: Add tool handler dispatch**

Find the existing tool dispatch (search for `case 'search'` or `if (toolName === 'search')`). Add cases for new tools — each delegates to `/api/secrets/<verb>`:

```javascript
    case 'secret_get':    return await ragApi('/api/secrets/get',    args);
    case 'secret_list':   return await ragApi('/api/secrets/list',   {});
    case 'secret_set':    return await ragApi('/api/secrets/set',    args);
    case 'secret_delete': return await ragApi('/api/secrets/delete', args);
    case 'secret_rotate': return await ragApi('/api/secrets/rotate', args);
    case 'secret_verify': return await ragApi('/api/secrets/verify', {});
```

(`ragApi(route, body)` is the existing helper that POSTs to `RAG_URL + route` with `Authorization: Bearer ${RAG_TOKEN}`.)

- [ ] **Step 4: Smoke test mcp-shim locally**

```bash
# In one terminal:
VAULT_RAG_MCP_TOKEN=Tmcp VAULT_RAG_API_TOKEN=T \
RAG_API_URL=http://127.0.0.1:5679 MCP_PORT=5680 \
node scripts/mcp-shim.js &

# In another terminal: confirm tools/list contains new entries:
curl -s -X POST -H "x-vault-token: Tmcp" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:5680/mcp \
  | python3 -c "import sys,json; print([t['name'] for t in json.load(sys.stdin)['result']['tools']])"
```

Expected: list contains `secret_get`, `secret_list`, `secret_set`, `secret_delete`, `secret_rotate`, `secret_verify`.

- [ ] **Step 5: Commit**

```bash
git add scripts/mcp-shim.js
git commit -m "feat(secrets): MCP shim tools secret_*"
```

---

## Task 8: `vt secrets` CLI subcommand

**Files:**
- Modify: `scripts/vt.js`

- [ ] **Step 1: Read vt.js subcommand registration style**

```bash
grep -n "subcommand\|case '" scripts/vt.js | head -30
```

Find existing pattern (e.g. `case 'create':`, `case 'show':`).

- [ ] **Step 2: Add `secrets` dispatch in vt.js**

Add new case to vt.js main switch:

```javascript
    case 'secrets': {
      const sub = args[0];
      const rest = args.slice(1);
      const apiUrl = process.env.VAULT_RAG_API_URL;
      const token  = process.env.VAULT_RAG_API_TOKEN;
      if (!apiUrl || !token) {
        console.error('VAULT_RAG_API_URL and VAULT_RAG_API_TOKEN required');
        process.exit(2);
      }
      const post = async (route, body) => {
        const fetch = require('node:https').request;
        return new Promise((resolve, reject) => {
          const url = new URL(apiUrl + route);
          const data = JSON.stringify(body);
          const req = fetch({
            hostname: url.hostname, port: url.port || 443, path: url.pathname,
            method: 'POST',
            headers: {
              'content-type': 'application/json', 'content-length': data.length,
              'authorization': `Bearer ${token}`,
            },
          }, (res) => {
            let buf = ''; res.on('data', (c) => buf += c);
            res.on('end', () => {
              try { resolve({ code: res.statusCode, body: JSON.parse(buf || '{}') }); }
              catch (e) { resolve({ code: res.statusCode, body: { raw: buf } }); }
            });
          });
          req.on('error', reject); req.end(data);
        });
      };

      if (sub === 'get') {
        const name = rest[0]; if (!name) { console.error('usage: vt secrets get NAME'); process.exit(2); }
        const r = await post('/api/secrets/get', { name });
        if (r.code !== 200) { console.error(`error: ${JSON.stringify(r.body)}`); process.exit(1); }
        process.stdout.write(r.body.value);
        return;
      }
      if (sub === 'list') {
        const r = await post('/api/secrets/list', {});
        for (const n of r.body.names) console.log(n);
        return;
      }
      if (sub === 'set') {
        const name = rest[0];
        let value = rest[1];
        if (!name) { console.error('usage: vt secrets set NAME [VALUE]'); process.exit(2); }
        if (value === undefined) {
          // read from stdin (no-echo if tty)
          const readline = require('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
          value = await new Promise((r) => rl.question(`value for ${name}: `, (v) => { rl.close(); r(v); }));
        }
        const r = await post('/api/secrets/set', { name, value });
        if (r.code !== 200) { console.error(`error: ${JSON.stringify(r.body)}`); process.exit(1); }
        console.log(`ok sha=${r.body.committed_sha}`);
        return;
      }
      if (sub === 'delete') {
        const name = rest[0]; if (!name) { console.error('usage: vt secrets delete NAME'); process.exit(2); }
        const r = await post('/api/secrets/delete', { name });
        if (r.code !== 200) { console.error(`error: ${JSON.stringify(r.body)}`); process.exit(1); }
        console.log(`ok sha=${r.body.committed_sha}`);
        return;
      }
      if (sub === 'rotate') {
        const name = rest[0]; const value = rest[1] ?? null;
        if (!name) { console.error('usage: vt secrets rotate NAME [VALUE]'); process.exit(2); }
        const r = await post('/api/secrets/rotate', { name, value });
        if (r.code !== 200) { console.error(`error: ${JSON.stringify(r.body)}`); process.exit(1); }
        console.log(`ok sha=${r.body.committed_sha}`);
        return;
      }
      if (sub === 'verify') {
        const r = await post('/api/secrets/verify', {});
        console.log(JSON.stringify(r.body, null, 2));
        return;
      }
      if (sub === 'export-env') {
        const list = (await post('/api/secrets/list', {})).body.names;
        for (const n of list) {
          if (n.endsWith('_env')) continue;       // multi-line .env-блоки exclude
          const v = (await post('/api/secrets/get', { name: n })).body.value;
          process.stdout.write(`export ${n}=${JSON.stringify(v)}\n`);
        }
        return;
      }
      console.error('usage: vt secrets {get|list|set|delete|rotate|verify|export-env} ...');
      process.exit(2);
    }
```

- [ ] **Step 3: Smoke-test CLI against running rag-api**

```bash
# Pre-req: rag-api running (Task 6) with seed vault
VAULT_RAG_API_URL=http://127.0.0.1:5679 VAULT_RAG_API_TOKEN=T \
  ./scripts/vt.js secrets set TEST_KEY hello
VAULT_RAG_API_URL=http://127.0.0.1:5679 VAULT_RAG_API_TOKEN=T \
  ./scripts/vt.js secrets get TEST_KEY
```

Expected: `ok sha=...` then `hello` (without trailing newline).

- [ ] **Step 4: Commit**

```bash
git add scripts/vt.js
git commit -m "feat(secrets): vt secrets {get,list,set,delete,rotate,verify,export-env} subcommand"
```

---

## Task 9: Docker integration — age install + mount age.key

**Files:**
- Modify: `Dockerfile.tools`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Add `age` to Dockerfile.tools**

Read `Dockerfile.tools`:

```bash
cat Dockerfile.tools
```

Add `age` to apt install line. Example (adjust to existing structure):

```dockerfile
RUN apt-get update && apt-get install -y \
    git \
    age \
  && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Mount /opt/vault-rag/.secrets/age.key into vault-rag-api container**

In `docker-compose.yml`, under `vault-rag-api:` service `volumes:` section, add:

```yaml
      - /opt/vault-rag/.secrets/age.key:/run/secrets/age.key:ro
```

Under `environment:` add:

```yaml
      VAULT_AGE_KEY_PATH: /run/secrets/age.key
      VAULT_REPO_PATH: /opt/vault-rag
      VAULT_AGE_PATH: /opt/vault-rag/obsidian-vault/secrets/vault.age
      VAULT_RECIPIENTS_PATH: /opt/vault-rag/obsidian-vault/secrets/recipients
```

- [ ] **Step 3: Document new env in `.env.example`**

Append to `.env.example`:

```bash
# Server-side path to age private key (mounted read-only).
# Default in container: /run/secrets/age.key
VAULT_AGE_KEY_PATH=/run/secrets/age.key
```

- [ ] **Step 4: Verify docker-compose syntax**

```bash
docker compose -f docker-compose.yml config > /tmp/dc.out 2>&1 || { echo FAIL; tail -10 /tmp/dc.out; exit 1; }
echo OK
```

Expected: `OK` (no syntax errors).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.tools docker-compose.yml .env.example
git commit -m "feat(secrets): docker integration — age binary + age.key mount"
```

---

## Task 10: Bootstrap script

**Files:**
- Create: `scripts/secrets-bootstrap.sh`
- Create: `obsidian-vault/secrets/README.md` (generated by bootstrap, also commit template)

- [ ] **Step 1: Write the failing smoke (bootstrap on tmp dir)**

```bash
cat > /tmp/bootstrap-test.sh <<'OUTER'
#!/bin/bash
set -e
TMP=$(mktemp -d)
cd $TMP
git init --quiet
git config user.email t@t && git config user.name t

# Run bootstrap
bash /root/work/vault-rag-oss/scripts/secrets-bootstrap.sh "$TMP" "$TMP/.secrets"

# Verify outputs
test -f "$TMP/.secrets/age.key" || { echo "FAIL: no age.key"; exit 1; }
test -f "$TMP/obsidian-vault/secrets/vault.age" || { echo "FAIL: no vault.age"; exit 1; }
test -f "$TMP/obsidian-vault/secrets/recipients" || { echo "FAIL: no recipients"; exit 1; }
test -f "$TMP/obsidian-vault/secrets/.gitignore" || { echo "FAIL: no .gitignore"; exit 1; }
test "$(stat -c %a "$TMP/.secrets/age.key")" = "600" || { echo "FAIL: age.key not 0600"; exit 1; }

# Verify roundtrip
echo "bootstrap test OK"
OUTER
chmod +x /tmp/bootstrap-test.sh
/tmp/bootstrap-test.sh
```

Expected: FAIL (`No such file or directory: secrets-bootstrap.sh`).

- [ ] **Step 2: Write the script**

```bash
cat > scripts/secrets-bootstrap.sh <<'OUTER'
#!/bin/bash
# One-time bootstrap of secrets vault on the vault-rag server.
#
# Usage: secrets-bootstrap.sh <repo-path> <secrets-dir>
#   repo-path:   path to vault-rag git checkout (e.g. /opt/vault-rag)
#   secrets-dir: where to store private age key (e.g. /opt/vault-rag/.secrets)
#
# Idempotent: if secrets/ already exists, fails loudly (manual cleanup required).

set -euo pipefail
REPO=${1:?repo path required}
SECRETS_DIR=${2:?secrets dir required}

if [ -d "$REPO/obsidian-vault/secrets" ] && [ -f "$REPO/obsidian-vault/secrets/vault.age" ]; then
  echo "ERROR: $REPO/obsidian-vault/secrets/vault.age already exists; bootstrap aborted" >&2
  exit 1
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Generate keypair
age-keygen -o "$SECRETS_DIR/age.key" 2>/dev/null
chmod 600 "$SECRETS_DIR/age.key"
PUB=$(grep '^# public key:' "$SECRETS_DIR/age.key" | cut -d: -f2 | tr -d ' ')

# Create vault structure
mkdir -p "$REPO/obsidian-vault/secrets"

cat > "$REPO/obsidian-vault/secrets/.gitignore" <<'GI'
# Never commit plain-text secrets accidentally.
*.json
*.plain
*.env
vault.txt
age.key
GI

cat > "$REPO/obsidian-vault/secrets/recipients" <<RC
# host: vault-rag server
$PUB
RC

cat > "$REPO/obsidian-vault/secrets/README.md" <<'MD'
# Secrets vault

Server-side age-encrypted secret storage. Plain-text access through:

- MCP tools: `mcp__vault-rag__secret_get` / `_set` / `_list` / `_delete` / `_rotate` / `_verify`
- REST: `POST /api/secrets/<verb>` with `Authorization: Bearer $VAULT_RAG_API_TOKEN`
- CLI: `vt secrets {get,list,set,delete,rotate,verify,export-env}`

See `docs/superpowers/specs/2026-05-14-secrets-vault-design.md` for design.

**DO NOT** commit plain-text secrets into this directory. `.gitignore` blocks
common patterns but is not exhaustive.
MD

# Initial empty vault.age
TMP=$(mktemp -d)
echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' > "$TMP/init.json"
age -R "$REPO/obsidian-vault/secrets/recipients" -o "$REPO/obsidian-vault/secrets/vault.age" "$TMP/init.json"
shred -u "$TMP/init.json" 2>/dev/null || rm -P "$TMP/init.json" 2>/dev/null || rm "$TMP/init.json"
rmdir "$TMP"

echo "bootstrap OK"
echo "  age.key:        $SECRETS_DIR/age.key (BACKUP THIS!)"
echo "  recipients:     $REPO/obsidian-vault/secrets/recipients"
echo "  vault.age:      $REPO/obsidian-vault/secrets/vault.age"
echo ""
echo "Next: cd $REPO && git add obsidian-vault/secrets/ && git commit -m 'secrets: init' && git push"
OUTER
chmod +x scripts/secrets-bootstrap.sh
```

- [ ] **Step 3: Run smoke test to verify it passes**

```bash
/tmp/bootstrap-test.sh
```

Expected: `bootstrap OK ...` then `bootstrap test OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/secrets-bootstrap.sh
git commit -m "feat(secrets): bootstrap script (age keygen + initial vault)"
```

---

## Task 11: Migration script

**Files:**
- Create: `scripts/migrate-to-vault.sh`

- [ ] **Step 1: Write the script**

```bash
cat > scripts/migrate-to-vault.sh <<'OUTER'
#!/bin/bash
# One-time migration of existing client secrets into vault-rag secrets store.
#
# Pre-req:
#   - VAULT_RAG_API_URL + VAULT_RAG_API_TOKEN exported
#   - vt CLI on PATH (or use $VT_BIN)
#   - server-side bootstrap already done

set -euo pipefail
VT=${VT_BIN:-vt}

push() {
  local name=$1 value=$2
  if [ -z "$value" ]; then
    echo "  skip $name (empty)"
    return
  fi
  echo "  set $name (${#value} bytes)"
  $VT secrets set "$name" "$value" >/dev/null
}

push_file() {
  local name=$1 path=$2
  if [ ! -f "$path" ]; then
    echo "  skip $name (no file $path)"
    return
  fi
  push "$name" "$(cat "$path")"
}

push_env() {
  local name=$1 envfile=$2
  if [ ! -f "$envfile" ]; then
    echo "  skip $name (no file $envfile)"
    return
  fi
  push "$name" "$(grep -v '^\s*#' "$envfile" | grep -v '^\s*$')"
}

echo "=== env vars ==="
push ANTHROPIC_API_KEY    "${ANTHROPIC_API_KEY:-}"
push GITLAB_TOKEN         "${GITLAB_TOKEN:-}"
push JIRA_TOKEN           "${JIRA_TOKEN:-}"
push GRAFANA_TOKEN        "${GRAFANA_TOKEN:-}"
push YANDEX_APP_PASSWORD  "${YANDEX_APP_PASSWORD:-}"
push DEV_VAULT_TOKEN      "${DEV_VAULT_TOKEN:-}"

echo "=== files ==="
push_file GH_PAT             /root/.gh-token
push_file GIT_CREDENTIALS    /root/.git-credentials
push_file CLAUDE_CREDS_JSON  /root/.claude/.credentials.json

echo "=== project .env blobs ==="
push_env tarot_env           /root/tarot/.env
push_env renaper_bot_env     /root/renaper-bot/.env
push_env token_monitor_env   /root/token-monitor/.env
push_env shop_env            /root/shop/.env
push_env hermes_env          /root/.hermes/.env
push_env yc_1c_state_env     /root/yc-1c-infra/state.env

echo ""
echo "Migration complete. Verify with: vt secrets list && vt secrets verify"
echo ""
echo "After verifying — manually remove plaintext sources:"
echo "  - bashrc/zshrc 'export XXX=...' lines"
echo "  - /root/.gh-token /root/.git-credentials /root/.claude/.credentials.json"
echo "  - project .env files (or replace with 'vt secrets get <name>_env > .env' on startup)"
OUTER
chmod +x scripts/migrate-to-vault.sh
```

- [ ] **Step 2: Validate script syntax**

```bash
bash -n scripts/migrate-to-vault.sh && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-to-vault.sh
git commit -m "feat(secrets): migration script for existing client secrets"
```

---

## Task 12: Agent onboarding docs

**Files:**
- Create: `docs/superpowers/agent-onboarding-secrets.md`

- [ ] **Step 1: Write the doc**

```bash
cat > docs/superpowers/agent-onboarding-secrets.md <<'OUTER'
# Agent onboarding — secrets vault

This is the minimal "I'm a new agent on a new host, how do I get secrets" guide.

## Pre-requisites

You need exactly one thing: a valid `VAULT_RAG_API_TOKEN`.

Check:

```bash
# Should print 200 OK
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $VAULT_RAG_API_TOKEN" \
  $VAULT_RAG_API_URL/api/secrets/verify
```

If you don't have it, ask the human operator to provision one (it's the same
token used for all other vault-rag tools).

## Three ways to use secrets

### From Claude Code (preferred)

Tools are auto-registered if vault-rag MCP is configured:

```
mcp__vault-rag__secret_get(name="GITLAB_TOKEN")        # → {value: "..."}
mcp__vault-rag__secret_list()                          # → {names: [...]}
mcp__vault-rag__secret_set(name="NEW_KEY", value="v")  # → {committed_sha: "..."}
```

### From shell

```bash
vt secrets get GITLAB_TOKEN
vt secrets list
vt secrets set NEW_KEY value
vt secrets export-env > /tmp/env.sh && source /tmp/env.sh; rm /tmp/env.sh
```

(Bootstrap `vt` once: `npm install -g <vault-rag-oss>/scripts/` or symlink
`scripts/vt.js` to `/usr/local/bin/vt`.)

### From any code (Node/Python/Go/curl)

```python
import os, requests
def get_secret(name):
    r = requests.post(
        f"{os.environ['VAULT_RAG_API_URL']}/api/secrets/get",
        json={"name": name},
        headers={"Authorization": f"Bearer {os.environ['VAULT_RAG_API_TOKEN']}"},
    )
    r.raise_for_status()
    return r.json()["value"]
```

## What's stored

Run `vt secrets list` to see current names. Conventions:

- `UPPER_SNAKE` — one-line env-var-like tokens (e.g. `GITLAB_TOKEN`)
- `<service>_env` — full `.env` file content for an application (multi-line)
  - Usage: `vt secrets get tarot_env > tarot/.env`

## What NOT to do

- Don't commit plain-text secrets to git (anywhere — `.gitignore` doesn't
  cover every case).
- Don't paste secrets into shell history without leading space + `HISTCONTROL=ignorespace`.
- Don't share `VAULT_RAG_API_TOKEN` outside the team — it gives access to ALL
  secrets (Phase 1 has no scope-tokens yet).

## Onboarding a new host (operator)

1. Provide `VAULT_RAG_API_URL` + `VAULT_RAG_API_TOKEN` to the host.
2. Verify: `curl ... /api/secrets/verify` returns 200.

That's it. No SSH-key distribution, no age install, no local git clone.

## Adding a new client class (e.g. a new production service)

Phase 1: same `VAULT_RAG_API_TOKEN`. Phase 2 will add per-service scope-tokens.

## Troubleshooting

- `401 unauthorized` → check token correct + URL correct
- `404 not_found` on get → check `vt secrets list` for actual name
- `503 conflict_retries_exhausted` on set → two clients writing simultaneously; retry
- `secret_verify` returns `{ok: false}` → server-side issue, contact operator
OUTER
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/agent-onboarding-secrets.md
git commit -m "docs(secrets): agent onboarding guide"
```

---

## Task 13: End-to-end smoke test

**Files:**
- Create: `tests/secrets-e2e.smoke.sh`

- [ ] **Step 1: Write E2E smoke test**

```bash
cat > tests/secrets-e2e.smoke.sh <<'OUTER'
#!/bin/bash
# End-to-end smoke: bootstrap → rag-api → MCP shim → vt CLI all in one tmpdir.
# Requires age + node installed. No PG, no docker.

set -euo pipefail
TMP=$(mktemp -d)
trap "kill %1 %2 2>/dev/null || true; rm -rf $TMP" EXIT

cd $TMP
git init --bare origin.git
git clone -q origin.git clone
cd clone
git config user.email t@t && git config user.name t
cd ..

# Bootstrap
mkdir -p secrets_dir
bash /root/work/vault-rag-oss/scripts/secrets-bootstrap.sh $TMP/clone $TMP/secrets_dir
cd clone && git add . && git commit -q -m init && git push -q origin HEAD:master
cd ..

# Start rag-api
PORT_API=$((5800 + RANDOM % 100))
VAULT_RAG_API_TOKEN=T VAULT_AGE_KEY_PATH=$TMP/secrets_dir/age.key \
  VAULT_REPO_PATH=$TMP/clone \
  VAULT_AGE_PATH=$TMP/clone/obsidian-vault/secrets/vault.age \
  VAULT_RECIPIENTS_PATH=$TMP/clone/obsidian-vault/secrets/recipients \
  VAULT_SECRETS_SKIP_PG=1 RAG_PORT=$PORT_API \
  node /root/work/vault-rag-oss/scripts/rag-api.js >$TMP/api.log 2>&1 &
sleep 1

# Start MCP shim
PORT_MCP=$((5900 + RANDOM % 100))
VAULT_RAG_MCP_TOKEN=Tmcp VAULT_RAG_API_TOKEN=T \
  RAG_API_URL=http://127.0.0.1:$PORT_API MCP_PORT=$PORT_MCP \
  node /root/work/vault-rag-oss/scripts/mcp-shim.js >$TMP/mcp.log 2>&1 &
sleep 1

# Test via vt CLI
export VAULT_RAG_API_URL=http://127.0.0.1:$PORT_API
export VAULT_RAG_API_TOKEN=T
VT=/root/work/vault-rag-oss/scripts/vt.js

echo "--- vt secrets list (empty) ---"
node $VT secrets list

echo "--- vt secrets set MY_TOKEN ---"
node $VT secrets set MY_TOKEN "secret-value-123"

echo "--- vt secrets get MY_TOKEN ---"
RESULT=$(node $VT secrets get MY_TOKEN)
test "$RESULT" = "secret-value-123" || { echo "FAIL: got '$RESULT'"; exit 1; }

echo "--- vt secrets list (should show MY_TOKEN) ---"
node $VT secrets list | grep -q '^MY_TOKEN$' || { echo "FAIL: not in list"; exit 1; }

echo "--- vt secrets verify ---"
node $VT secrets verify

# Test via MCP shim
echo "--- MCP tools/list contains secret_* ---"
curl -sS -X POST -H "x-vault-token: Tmcp" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:$PORT_MCP/mcp \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['result']['tools']; need=['secret_get','secret_set','secret_list','secret_delete','secret_rotate','secret_verify']; assert all(any(x['name']==n for x in t) for n in need), [x['name'] for x in t]; print('OK')"

echo "--- E2E SMOKE OK ---"
OUTER
chmod +x tests/secrets-e2e.smoke.sh
```

- [ ] **Step 2: Run E2E**

```bash
tests/secrets-e2e.smoke.sh
```

Expected: `--- E2E SMOKE OK ---` at end.

- [ ] **Step 3: Commit**

```bash
git add tests/secrets-e2e.smoke.sh
git commit -m "test(secrets): end-to-end smoke (bootstrap+rag-api+mcp+vt)"
```

---

## Task 14: Final integration — push branch + open MR

- [ ] **Step 1: Verify branch is clean and complete**

```bash
cd /root/work/vault-rag-oss
git status
git log --oneline main..HEAD
```

Expected: clean working tree; ~14 commits on `spec/secrets-vault` branch.

- [ ] **Step 2: Push branch**

```bash
git push -u origin spec/secrets-vault
```

- [ ] **Step 3: Open MR via gh / GitHub UI**

```bash
gh pr create \
  --title "secrets-vault: server-side age-encrypted secret storage" \
  --body "Spec: docs/superpowers/specs/2026-05-14-secrets-vault-design.md
Plan: docs/superpowers/plans/2026-05-14-secrets-vault-implementation.md

Phase 1: server-side decryption, MCP tools + REST + vt CLI subcommand.
See spec for threat model trade-offs."
```

- [ ] **Step 4: Wait for review, merge**

(Manual step.)

- [ ] **Step 5: Post-merge bootstrap on production server**

On `brain.itiswednesdaymydud.es`:

```bash
ssh brain
cd /opt/vault-rag
git pull
./scripts/secrets-bootstrap.sh /opt/vault-rag /opt/vault-rag/.secrets
cd obsidian-vault && git add secrets/ && git commit -m "secrets: init prod" && git push
docker compose up -d --force-recreate vault-rag-api vault-rag-mcp
```

- [ ] **Step 6: Migrate existing client secrets**

On client (ai-машина):

```bash
VAULT_RAG_API_URL=https://brain.itiswednesdaymydud.es \
VAULT_RAG_API_TOKEN=... \
  scripts/migrate-to-vault.sh
vt secrets verify
vt secrets list
```

Then manually clean up plain-text sources per migration script's output.

---

## Self-Review

**Spec coverage:**

- [x] vault.age single file with JSON — Task 1-4
- [x] recipients with server pubkey — Task 10 (bootstrap)
- [x] server-side decryption in RAM — Task 3 (`_ensureFresh`)
- [x] MCP tools — Task 7
- [x] REST endpoints — Task 6
- [x] vt CLI fallback — Task 8
- [x] Docker mount age.key — Task 9
- [x] Bootstrap script — Task 10
- [x] Migration script — Task 11
- [x] Agent onboarding doc — Task 12
- [x] Optimistic concurrency retry — Task 5
- [x] Rotate with auto-generated value — Task 4
- [x] Verify endpoint — Task 4 + 6

**Placeholder scan:** clean (no TODO/TBD/FIXME; all code blocks have full content).

**Type consistency:** method names `_decryptVaultAge`/`_encryptAndWrite`/`get`/`list`/`set`/`delete`/`rotate`/`verify` consistent across tasks 1-7. `committed_sha` return type consistent. `NotFound` / `ConflictRetriesExhausted` exported once (Task 1), re-used everywhere.
