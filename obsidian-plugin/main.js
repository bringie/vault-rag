'use strict';
// vault-rag secrets — Obsidian plugin (vt-0148).
//
// Reveals secrets stored in the operator's self-hosted vault-rag hub.
// The age private key NEVER lives on this device — secret values arrive
// already-decrypted over HTTPS, are shown for 30 seconds, then wiped.
//
// Plain CommonJS (no TS toolchain) so Obsidian loads main.js verbatim.

const obsidian = require('obsidian');

const DEFAULT_SETTINGS = Object.freeze({
  hubUrl: '',
  apiToken: '',
  autoHideSeconds: 30,
  clipboardClearSeconds: 30,
});

class VaultRagPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new VaultRagSettingTab(this.app, this));
    this.addCommand({
      id: 'vault-rag-reveal',
      name: 'Reveal secret by name',
      callback: () => new SecretNameModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'vault-rag-pick',
      name: 'Pick secret from list',
      callback: () => this.pickSecret(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  preflight() {
    if (!this.settings.hubUrl) {
      new obsidian.Notice('vault-rag: configure Hub URL in settings first');
      return false;
    }
    if (!this.settings.apiToken) {
      new obsidian.Notice('vault-rag: configure API token in settings first');
      return false;
    }
    return true;
  }

  async api(path, body) {
    const url = this.settings.hubUrl.replace(/\/$/, '') + '/api' + path;
    const headers = {
      'Authorization': 'Bearer ' + this.settings.apiToken,
      'Content-Type': 'application/json',
    };
    const r = await obsidian.requestUrl({
      url,
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      throw: false,
    });
    if (r.status < 200 || r.status >= 300) {
      let detail = '';
      try { detail = JSON.parse(r.text).error || r.text; } catch { detail = r.text; }
      throw new Error(`${r.status}: ${detail || 'http error'}`);
    }
    try { return JSON.parse(r.text); } catch { return r.text; }
  }

  async pickSecret() {
    if (!this.preflight()) return;
    let names;
    try {
      const r = await this.api('/secrets/list', {});
      names = r.names || [];
    } catch (e) {
      new obsidian.Notice('vault-rag list failed: ' + e.message);
      return;
    }
    if (!names.length) {
      new obsidian.Notice('vault-rag: no secrets in vault');
      return;
    }
    new SecretSuggestModal(this.app, this, names).open();
  }

  async revealSecretByName(name) {
    if (!this.preflight()) return;
    let r;
    try {
      r = await this.api('/secrets/get', { name });
    } catch (e) {
      new obsidian.Notice('vault-rag reveal failed: ' + e.message);
      return;
    }
    new SecretRevealModal(this.app, this, name, String(r.value || '')).open();
  }
}

class SecretNameModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Reveal secret' });
    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: 'secret name (e.g. GH_TOKEN)',
    });
    input.style.width = '100%';
    input.style.padding = '8px';
    input.style.marginTop = '8px';
    input.focus();
    const submit = async () => {
      const name = input.value.trim();
      if (!name) return;
      this.close();
      await this.plugin.revealSecretByName(name);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
    const btnBar = contentEl.createDiv();
    btnBar.style.marginTop = '12px';
    btnBar.style.textAlign = 'right';
    const goBtn = btnBar.createEl('button', { text: 'reveal' });
    goBtn.addEventListener('click', submit);
  }
  onClose() { this.contentEl.empty(); }
}

class SecretSuggestModal extends obsidian.FuzzySuggestModal {
  constructor(app, plugin, names) {
    super(app);
    this.plugin = plugin;
    this.names = names.slice().sort();
    this.setPlaceholder('pick a secret to reveal…');
  }
  getItems() { return this.names; }
  getItemText(n) { return n; }
  async onChooseItem(name) {
    await this.plugin.revealSecretByName(name);
  }
}

class SecretRevealModal extends obsidian.Modal {
  constructor(app, plugin, name, value) {
    super(app);
    this.plugin = plugin;
    this.name = name;
    // Mutable: closeReveal nulls this so no live binding holds the
    // plaintext after the modal closes.
    this.plaintext = value;
    this.timer = null;
    this.tick = null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const head = contentEl.createEl('h3', { text: 'SECRET // ' + this.name });
    head.style.margin = '0 0 .6em 0';

    const remainingEl = contentEl.createEl('div');
    remainingEl.style.fontSize = '12px';
    remainingEl.style.opacity = '0.7';
    remainingEl.style.marginBottom = '.6em';

    const pre = contentEl.createEl('pre');
    pre.textContent = this.plaintext;
    pre.style.padding = '12px';
    pre.style.background = 'var(--background-secondary)';
    pre.style.borderRadius = '4px';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-all';
    pre.style.userSelect = 'all';
    pre.style.maxHeight = '40vh';
    pre.style.overflow = 'auto';
    pre.style.margin = '0';

    const bar = contentEl.createDiv();
    bar.style.marginTop = '12px';
    bar.style.display = 'flex';
    bar.style.gap = '8px';
    bar.style.alignItems = 'center';

    const copyBtn = bar.createEl('button', { text: 'copy' });
    copyBtn.addEventListener('click', () => {
      if (!this.plaintext) return;
      navigator.clipboard.writeText(this.plaintext).then(() => {
        new obsidian.Notice('copied — clipboard auto-clears in '
          + this.plugin.settings.clipboardClearSeconds + 's');
        // Auto-clear clipboard: write empty string after configured delay.
        // Best-effort — user may have copied something else by then; the
        // explicit clear still helps the common case.
        setTimeout(() => {
          navigator.clipboard.writeText('').catch(() => {});
        }, this.plugin.settings.clipboardClearSeconds * 1000);
      }).catch((e) => {
        new obsidian.Notice('copy failed: ' + e.message);
      });
    });

    const closeBtn = bar.createEl('button', { text: '× close' });
    closeBtn.addEventListener('click', () => this.close());

    const total = Math.max(5, this.plugin.settings.autoHideSeconds | 0);
    let remaining = total;
    remainingEl.textContent = `auto-hide in ${remaining}s`;
    this.tick = window.setInterval(() => {
      remaining -= 1;
      remainingEl.textContent = `auto-hide in ${remaining}s`;
      if (remaining <= 0) this.close();
    }, 1000);
  }
  onClose() {
    if (this.tick) { window.clearInterval(this.tick); this.tick = null; }
    this.plaintext = '';
    this.contentEl.empty();
  }
}

class VaultRagSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'vault-rag secrets' });
    containerEl.createEl('p', {
      text: 'Configure the hub this plugin talks to. The age private key '
        + 'stays on the server — this device only ever receives plaintext '
        + 'values over HTTPS, briefly, on demand.',
    });
    const warn = containerEl.createEl('p', {
      text: 'WARNING: API token is stored unencrypted in '
        + '.obsidian/plugins/vault-rag-secrets/data.json inside this vault. '
        + 'gitignore that path on shared vaults; rotate the token if a '
        + 'device is lost.',
    });
    warn.style.color = 'var(--text-error)';

    new obsidian.Setting(containerEl)
      .setName('Hub URL')
      .setDesc('Base URL of your vault-rag deployment (e.g. https://brain.example.com)')
      .addText(t => t
        .setPlaceholder('https://...')
        .setValue(this.plugin.settings.hubUrl)
        .onChange(async (v) => {
          this.plugin.settings.hubUrl = v.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('API token')
      .setDesc('Viewer-or-better Bearer token. Generate one on the hub via '
        + '`vt secrets set OBSIDIAN_PLUGIN_TOKEN $(openssl rand -hex 32)` '
        + 'and grant it /api/secrets/* via the rag-api ACL.')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste token…')
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (v) => {
            this.plugin.settings.apiToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new obsidian.Setting(containerEl)
      .setName('Auto-hide seconds')
      .setDesc('Reveal modal closes itself after this many seconds (min 5).')
      .addText(t => t
        .setValue(String(this.plugin.settings.autoHideSeconds))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 5) {
            this.plugin.settings.autoHideSeconds = n;
            await this.plugin.saveSettings();
          }
        }));

    new obsidian.Setting(containerEl)
      .setName('Clipboard auto-clear seconds')
      .setDesc('Plugin writes "" to the clipboard this long after copy. '
        + 'Best-effort — your OS may not allow it on mobile.')
      .addText(t => t
        .setValue(String(this.plugin.settings.clipboardClearSeconds))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.clipboardClearSeconds = n;
            await this.plugin.saveSettings();
          }
        }));

    const test = new obsidian.Setting(containerEl)
      .setName('Connectivity check')
      .setDesc('Pings /api/secrets/list to confirm URL+token are wired up.');
    test.addButton(b => b.setButtonText('test').onClick(async () => {
      try {
        const r = await this.plugin.api('/secrets/list', {});
        const n = (r.names || []).length;
        new obsidian.Notice(`vault-rag: OK — ${n} secrets visible`);
      } catch (e) {
        new obsidian.Notice('vault-rag: ' + e.message);
      }
    }));
  }
}

module.exports = VaultRagPlugin;
