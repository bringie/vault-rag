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
