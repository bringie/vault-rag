const { execFile } = require('node:child_process');

const DEFAULT_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

function callClaude({ prompt, binary = DEFAULT_BIN, model = DEFAULT_MODEL, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'json'];
    execFile(
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
  });
}

module.exports = { callClaude };
