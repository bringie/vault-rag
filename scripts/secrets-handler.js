const { spawn } = require('child_process');
const fs = require('fs');

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
    this._blob = null;
    this._blobSha = null;
    this._lastFetch = 0;
    this._writeMutex = Promise.resolve();
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
    if (this.skipGit) {
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

  _acquireWriteLock() {
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    const prev = this._writeMutex;
    this._writeMutex = next;
    return prev.then(() => release);
  }
}

module.exports = { SecretsHandler, NotFound, ConflictRetriesExhausted };
