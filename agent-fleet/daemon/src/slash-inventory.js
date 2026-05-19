'use strict';
// vt-0398 / vt-0392 v6: slash-command inventory for the chat-view
// composer autocomplete.
//
// One-shot scan when the daemon connects to the hub:
//   1. Built-in Claude Code commands (hard-coded — claude /help is
//      unavailable in --print mode, so we can't introspect at runtime).
//   2. User plugin commands — walk ~/.claude/plugins/marketplaces/<m>/
//      plugins/<p>/commands/*.md, treating each filename (sans .md) as
//      the command and the first non-blank `description:` frontmatter
//      line (or the first non-empty content line) as the summary.
//
// Result shape:
//   { commands: [ {name: '/help', description: '...', source: 'builtin' | 'plugin:<id>'} ] }

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BUILTIN_COMMANDS = [
  { name: '/help',         description: 'show all commands' },
  { name: '/clear',         description: 'clear conversation context' },
  { name: '/compact',       description: 'summarise old turns to free context' },
  { name: '/memory',        description: 'edit CLAUDE.md memory files' },
  { name: '/resume',        description: 'resume a recent session' },
  { name: '/continue',      description: 'continue most recent session in cwd' },
  { name: '/model',         description: 'switch model (opus/sonnet/haiku)' },
  { name: '/effort',        description: 'set effort level (low/medium/high/xhigh/max)' },
  { name: '/agents',        description: 'manage subagents' },
  { name: '/mcp',           description: 'manage MCP servers' },
  { name: '/skill',         description: 'invoke a skill' },
  { name: '/fast',          description: 'toggle fast mode' },
  { name: '/init',          description: 'initialise CLAUDE.md' },
  { name: '/config',        description: 'open configuration' },
  { name: '/status',        description: 'show session status' },
  { name: '/vim',           description: 'edit current input in $EDITOR' },
  { name: '/save',          description: 'save conversation' },
  { name: '/quit',          description: 'exit Claude Code' },
  { name: '/exit',          description: 'exit Claude Code' },
];

function readPluginCommands(home = os.homedir()) {
  const root = path.join(home, '.claude', 'plugins', 'marketplaces');
  const out = [];
  let marketDirs;
  try { marketDirs = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const md of marketDirs) {
    if (!md.isDirectory()) continue;
    const pluginsDir = path.join(root, md.name, 'plugins');
    let plugins;
    try { plugins = fs.readdirSync(pluginsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const pd of plugins) {
      if (!pd.isDirectory()) continue;
      const cmdDir = path.join(pluginsDir, pd.name, 'commands');
      let files;
      try { files = fs.readdirSync(cmdDir); }
      catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const stem = f.slice(0, -3);
        // vt-0398 CRIT fix: only accept ASCII word-char filenames so a
        // malicious plugin can't smuggle HTML/control characters via
        // command names. Dotfiles + spaces + path separators rejected.
        // vt-0405: warn so legitimate plugins with underscore/digit
        // prefixes (e.g. _private-cmd, 0pen) aren't silently dropped.
        if (!/^[A-Za-z][\w\-]{0,63}$/.test(stem)) {
          console.warn(`[daemon] slash-inventory: skipping non-conformant filename ${md.name}/${pd.name}/commands/${f}`);
          continue;
        }
        const name = '/' + stem;
        const filePath = path.join(cmdDir, f);
        let description = '';
        try {
          const text = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
          // YAML frontmatter description: pattern
          const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const descLine = fm.match(/^description:\s*(.+)$/m);
            if (descLine) description = descLine[1].trim().replace(/^["']|["']$/g, '');
          }
          if (!description) {
            // First non-blank, non-fence line after frontmatter.
            const body = fmMatch ? text.slice(fmMatch[0].length) : text;
            const firstLine = body.split('\n').map(l => l.trim())
              .find(l => l && !l.startsWith('---') && !l.startsWith('```'));
            if (firstLine) description = firstLine.slice(0, 160);
          }
        } catch {}
        out.push({
          name, description: description || `(plugin: ${pd.name})`,
          source: `plugin:${md.name}/${pd.name}`,
        });
      }
    }
  }
  return out;
}

function buildInventory(home = os.homedir()) {
  const seen = new Set();
  const commands = [];
  for (const c of BUILTIN_COMMANDS) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    commands.push({ ...c, source: 'builtin' });
  }
  for (const c of readPluginCommands(home)) {
    if (seen.has(c.name)) continue;  // builtin wins
    seen.add(c.name);
    commands.push(c);
  }
  // Sort alphabetically — keeps the dropdown stable.
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands };
}

module.exports = { buildInventory, BUILTIN_COMMANDS, readPluginCommands };
