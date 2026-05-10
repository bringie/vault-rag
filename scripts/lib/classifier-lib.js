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

function shouldSkip(basename, frontmatter) {
  if (basename === 'current-context.md') return true;
  if (basename.startsWith('_')) return true;
  if (frontmatter && frontmatter.type === 'index') return true;
  return false;
}

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

module.exports = {
  parseClaudeResponse, validateTargetFolder, shouldSkip,
  enrichFrontmatter, buildPrompt, ALLOWED_TARGETS,
};
