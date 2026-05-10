const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeResponse, validateTargetFolder, shouldSkip, enrichFrontmatter } = require('../lib/classifier-lib');

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
