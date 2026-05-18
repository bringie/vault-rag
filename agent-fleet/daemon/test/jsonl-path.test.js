'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { encodeProjectDir, expectedJsonlPath } = require('../src/jsonl-path');

test('encodeProjectDir: /root → -root', () => {
  assert.strictEqual(encodeProjectDir('/root'), '-root');
});

test('encodeProjectDir: /tmp/foo → -tmp-foo', () => {
  assert.strictEqual(encodeProjectDir('/tmp/foo'), '-tmp-foo');
});

test('encodeProjectDir: deep nested', () => {
  assert.strictEqual(
    encodeProjectDir('/root/work/vault-rag-oss'),
    '-root-work-vault-rag-oss'
  );
});

test('encodeProjectDir: trailing slash trimmed', () => {
  assert.strictEqual(encodeProjectDir('/root/'), '-root');
});

test('encodeProjectDir: throws on relative path', () => {
  assert.throws(() => encodeProjectDir('relative/path'),
    /absolute path required/);
});

test('encodeProjectDir: throws on empty', () => {
  assert.throws(() => encodeProjectDir(''), /absolute path required/);
});

test('expectedJsonlPath: composes home + project dir + sid.jsonl', () => {
  const home = '/home/test';
  const sid = '40b7e279-a7be-4952-993c-39180c1bbbcf';
  const got = expectedJsonlPath('/root', sid, home);
  assert.strictEqual(got,
    '/home/test/.claude/projects/-root/40b7e279-a7be-4952-993c-39180c1bbbcf.jsonl');
});

test('expectedJsonlPath: rejects sessionId with path separators', () => {
  assert.throws(
    () => expectedJsonlPath('/root', '../escape', '/home/test'),
    /invalid sessionId/
  );
});
