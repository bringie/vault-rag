'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, 'mcp-json-merge.js');

function run(target, name, url, token, extraArgs = []) {
  return execFileSync('node', [SCRIPT, '--target', target, '--name', name, '--url', url, '--token', token, ...extraArgs], { encoding: 'utf8' });
}

test('vt-0143: merge preserves other mcpServers entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  try {
    const target = path.join(dir, 'claude.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://x' } } }, null, 2));
    run(target, 'vault-rag', 'http://h/mcp', 'T1');
    const out = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(out.mcpServers.other);
    assert.equal(out.mcpServers['vault-rag'].headers['X-Vault-Token'], 'T1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vt-0143: rotation only rewrites the named entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  try {
    const target = path.join(dir, 'claude.json');
    run(target, 'vault-rag', 'http://h/mcp', 'T1');
    run(target, 'vault-rag', 'http://h/mcp', 'T2');
    const out = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(out.mcpServers['vault-rag'].headers['X-Vault-Token'], 'T2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vt-0143: REFUSES to clobber malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  try {
    const target = path.join(dir, 'claude.json');
    fs.writeFileSync(target, 'not json {');
    let threw = false;
    try { run(target, 'vault-rag', 'http://h/mcp', 'T1'); }
    catch { threw = true; }
    assert.ok(threw, 'should exit non-zero');
    assert.equal(fs.readFileSync(target, 'utf8'), 'not json {');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vt-0143: creates parent dir + sets 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  try {
    const target = path.join(dir, 'nested', 'sub', 'claude.json');
    run(target, 'vault-rag', 'http://h/mcp', 'T1');
    const mode = fs.statSync(target).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vt-0143: custom --token-header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-merge-'));
  try {
    const target = path.join(dir, 'claude.json');
    run(target, 'vault-rag', 'http://h/mcp', 'T1', ['--token-header', 'Authorization']);
    const out = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(out.mcpServers['vault-rag'].headers.Authorization, 'T1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
