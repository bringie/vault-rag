'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { collectInventory, inventoryChanged, resetInventoryCache, _internals } = require('../src/inventory-collector');

test('collectInventory returns required keys', () => {
  const inv = collectInventory();
  assert.ok(inv.collected_at);
  assert.ok(Array.isArray(inv.skills));
  assert.ok(Array.isArray(inv.mcp_servers));
  assert.ok('claude_version' in inv);
  assert.ok('settings' in inv);
});

test('parseSettings respects strict allowlist (drops env/hooks/credentials)', () => {
  const { parseSettings } = _internals;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
    model: 'claude-opus-4-7',
    permissionMode: 'acceptEdits',
    env: { GITLAB_TOKEN: 'SECRET', GRAFANA_TOKEN: 'SECRET2' },
    hooks: { onUserSubmit: 'curl https://internal/...' },
    permissions: { allow: ['Bash(curl :*)'] },
    autoUpdater: { enabled: true },
    enabledPlugins: { 'foo': true, 'bar': false },
  }));
  const out = parseSettings(tmp);
  assert.strictEqual(out.model, 'claude-opus-4-7');
  assert.strictEqual(out.permissionMode, 'acceptEdits');
  assert.deepStrictEqual(out.autoUpdater, { enabled: true });
  assert.deepStrictEqual(out.enabledPlugins, { 'foo': true, 'bar': false });
  assert.ok(!('env' in out), 'env must be excluded');
  assert.ok(!('hooks' in out), 'hooks must be excluded');
  assert.ok(!('permissions' in out), 'permissions must be excluded');
  fs.rmSync(tmp, { recursive: true });
});

test('parseSettings drops enabledPlugins if values not all booleans', () => {
  const { parseSettings } = _internals;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'foo': { token: 'secret' } },
  }));
  const out = parseSettings(tmp);
  assert.ok(!('enabledPlugins' in out));
  fs.rmSync(tmp, { recursive: true });
});

test('parseMcpServers extracts names + enabled flag', () => {
  const { parseMcpServers } = _internals;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.writeFileSync(path.join(tmp, '.claude', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'vault-rag': { command: 'node', args: ['/path/script.js'] },
      'broken':    { command: 'broken', disabled: true },
    },
  }));
  const out = parseMcpServers(tmp);
  assert.strictEqual(out.length, 2);
  const vr = out.find(s => s.name === 'vault-rag');
  assert.strictEqual(vr.enabled, true);
  assert.strictEqual(vr.command, 'node');
  const br = out.find(s => s.name === 'broken');
  assert.strictEqual(br.enabled, false);
  fs.rmSync(tmp, { recursive: true });
});

test('inventoryChanged + resetInventoryCache', () => {
  resetInventoryCache();
  inventoryChanged();
  const second = inventoryChanged();
  assert.strictEqual(second, false, 'second call without mtime change must be false');
  resetInventoryCache();
});
