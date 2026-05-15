const { spawn } = require('child_process');
const fs = require('fs');

class NotFound extends Error {}
class ConflictRetriesExhausted extends Error {}

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
}

module.exports = { SecretsHandler, NotFound, ConflictRetriesExhausted };
