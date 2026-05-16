const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class NotFound extends Error {}
class ConflictRetriesExhausted extends Error {}

function isPushReject(err) {
  const msg = (err.message || '') + '';
  return msg.includes('non-fast-forward') || msg.includes('rejected');
}

function execCmd(cmd, args, { stdin, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    proc.stdout.on('data', (c) => {
      stdout = Buffer.concat([stdout, c]);
    });
    proc.stderr.on('data', (c) => {
      stderr += c;
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr}`),
        );
      resolve(stdout);
    });
    if (stdin !== undefined) proc.stdin.end(stdin);
    else proc.stdin.end();
  });
}

class SecretsHandler {
  constructor({
    ageKeyPath,
    recipientsPath,
    vaultAgePath,
    repoPath,
    skipGit = false,
    fetchTtlMs = 10_000,
  }) {
    this.ageKeyPath = ageKeyPath;
    this.recipientsPath = recipientsPath;
    this.vaultAgePath = vaultAgePath;
    this.repoPath = repoPath;
    this.skipGit = skipGit;
    this.fetchTtlMs = fetchTtlMs;
    // I6 (audit pass 2): clear the decrypted blob from memory once we haven't
    // touched it for this long. Bounds the window where /proc/<pid>/mem or
    // gcore would yield every secret in cleartext.
    this.clearAfterMs = 60 * 1000;
    // Relative path of vault.age inside repoPath — needed for git log lookups.
    this._vaultAgeRel = repoPath ? path.relative(repoPath, vaultAgePath) : vaultAgePath;
    this._blob = null;
    this._blobSha = null;
    this._lastFetch = 0;
    this._lastAccess = 0;
    this._writeMutex = Promise.resolve();
    // I12: serialise readers so N concurrent `get()`s don't each spawn their
    // own `git fetch` + `age -d`. Reuse the same in-flight refresh.
    this._refreshInFlight = null;
  }

  async _decryptVaultAge() {
    const out = await execCmd('age', ['-d', '-i', this.ageKeyPath, this.vaultAgePath]);
    return JSON.parse(out.toString('utf8'));
  }

  async _encryptAndWrite(blob) {
    const json = JSON.stringify(blob);
    const encrypted = await execCmd('age', ['-R', this.recipientsPath], { stdin: json });
    fs.writeFileSync(this.vaultAgePath, encrypted);
  }

  async _ensureFresh() {
    // I12: coalesce concurrent refreshes into a single git fetch + decrypt.
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = this._doEnsureFresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  async _doEnsureFresh() {
    // I6: drop a cleartext blob that's gone idle past clearAfterMs.
    if (this._blob && this._lastAccess && Date.now() - this._lastAccess > this.clearAfterMs) {
      this._blob = null;
      this._blobSha = null;
      this._lastFetch = 0;
    }
    if (this.skipGit) {
      this._blob = await this._decryptVaultAge();
      this._lastAccess = Date.now();
      return;
    }
    const now = Date.now();
    if (now - this._lastFetch < this.fetchTtlMs && this._blob) {
      this._lastAccess = now;
      return;
    }
    await this._gitFetch();
    const remoteSha = await this._headShaForFile(this._vaultAgeRel);
    if (remoteSha !== this._blobSha || !this._blob) {
      await this._gitPull();
      this._blob = await this._decryptVaultAge();
      this._blobSha = remoteSha;
    }
    this._lastFetch = now;
    this._lastAccess = now;
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
          return await this._headShaForFile(this._vaultAgeRel);
        } catch (e) {
          if (!isPushReject(e)) throw e;
          await this._gitResetHard();
          continue;
        }
      }
      throw new ConflictRetriesExhausted('git push rejected 3 times');
    } finally {
      release();
    }
  }

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
      return await this._headShaForFile(this._vaultAgeRel);
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
      return await this._headShaForFile(this._vaultAgeRel);
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

  _acquireWriteLock() {
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    const prev = this._writeMutex;
    this._writeMutex = next;
    return prev.then(() => release);
  }

  async _gitFetch() {
    await execCmd('git', ['fetch', '--quiet', 'origin'], { cwd: this.repoPath });
  }

  async _gitPull() {
    await execCmd('git', ['pull', '--rebase', '--quiet', 'origin', 'HEAD'], {
      cwd: this.repoPath,
    });
  }

  async _gitResetHard() {
    await execCmd('git', ['fetch', '--quiet', 'origin'], { cwd: this.repoPath });
    // Resolve the current branch and reset to origin/<branch>
    const branch = (
      await execCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.repoPath,
      })
    )
      .toString()
      .trim();
    await execCmd('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: this.repoPath,
    });
  }

  async _gitCommit(msg) {
    await execCmd('git', ['add', this.vaultAgePath], { cwd: this.repoPath });
    await execCmd('git', ['commit', '-m', msg, '--quiet'], { cwd: this.repoPath });
  }

  async _gitPush() {
    await execCmd('git', ['push', '--quiet', 'origin', 'HEAD'], {
      cwd: this.repoPath,
    });
  }

  async _headShaForFile(relPath) {
    const out = await execCmd('git', ['log', '-1', '--pretty=%H', '--', relPath], {
      cwd: this.repoPath,
    });
    return out.toString().trim();
  }
}

module.exports = { SecretsHandler, NotFound, ConflictRetriesExhausted };
