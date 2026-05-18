'use strict';
const path = require('node:path');

// Encodes an absolute cwd into Claude Code's project dir name.
// Rule (empirically derived from ~/.claude/projects/ dir listings):
//   - Strip trailing slash
//   - Replace every '/' with '-' (so absolute paths gain a leading '-')
// Examples:
//   /root           → -root
//   /tmp/foo        → -tmp-foo
//   /root/work/vault-rag-oss → -root-work-vault-rag-oss
function encodeProjectDir(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new Error(`absolute path required, got: ${JSON.stringify(cwd)}`);
  }
  let trimmed = cwd;
  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split('/').join('-');
}

// Builds the full path Claude Code is expected to write its jsonl to.
// home — the user's home directory ($HOME). Always passed in for testability.
// sessionId — uuid produced by the daemon (--session-id flag).
function expectedJsonlPath(cwd, sessionId, home) {
  if (typeof sessionId !== 'string' || /[\/\\\0]/.test(sessionId)) {
    throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
  const dir = encodeProjectDir(cwd);
  return path.join(home, '.claude', 'projects', dir, `${sessionId}.jsonl`);
}

module.exports = { encodeProjectDir, expectedJsonlPath };
