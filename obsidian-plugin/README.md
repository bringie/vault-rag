# vault-rag secrets — Obsidian plugin

Reveal secrets stored in your self-hosted [vault-rag](https://github.com/bringie/vault-rag) hub from inside Obsidian. Mobile + desktop. The age private key **never** lives on this device — secrets are decrypted server-side, sent over HTTPS, shown briefly, then wiped.

## Threat model (what this plugin protects against)

- **Lost device**: attacker gets the Obsidian app data, including
  `.obsidian/plugins/vault-rag-secrets/data.json`. That file holds the
  hub URL + an API token, but NOT the age private key. Revoke the
  token on the hub (`vt secrets rotate OBSIDIAN_PLUGIN_TOKEN`) and the
  attacker can no longer fetch new secrets. Anything already pulled +
  cached elsewhere on the device is out of scope.
- **Shoulder-surfing**: reveal modal auto-hides after 30s (configurable).
  Clipboard auto-clears 30s after copy (best-effort, may not work on
  iOS without a focused tab).
- **Compromised vault repo (Forgejo / GitHub)**: ciphertext only —
  attacker can't decrypt without `/opt/vault-rag/.secrets/age.key` on
  the hub.

What this plugin does NOT protect against:
- Compromise of the hub server.
- A keylogger or screen-recorder on this device while you reveal.
- An attacker with both the device AND the API token (token alone is
  enough to fetch every secret until you rotate).

## Install

1. Copy this directory to your vault as
   `<vault>/.obsidian/plugins/vault-rag-secrets/`
2. Enable in Obsidian: Settings → Community plugins → Installed →
   toggle "vault-rag secrets".
3. Open the plugin's settings tab:
   - **Hub URL**: e.g. `https://brain.example.com`
   - **API token**: paste a token that has `/api/secrets/*` access.
     Mint one on the hub: `vt secrets set OBSIDIAN_PLUGIN_TOKEN
     $(openssl rand -hex 32)` then add it to the rag-api ACL.
   - Click **test** under Connectivity check — expect `OK — N secrets
     visible`.

If your vault is itself committed to git (Obsidian Git plugin), add
this path to `.gitignore`:

```
.obsidian/plugins/vault-rag-secrets/data.json
```

…otherwise your API token ends up in the commit history.

## Use

Command palette (Cmd/Ctrl+P):

- **vault-rag: Reveal secret by name** — type a name (e.g. `GH_TOKEN`).
- **vault-rag: Pick secret from list** — fuzzy-find from `/secrets/list`.

The reveal modal shows the value for 30s with a countdown, then closes
itself and zeroes the in-memory binding. The "copy" button writes to
the clipboard and schedules a clear after 30s (best-effort).

## Build / package

No build step. `main.js` is plain CommonJS, loaded verbatim by
Obsidian. To distribute:

```
zip -r vault-rag-secrets-0.1.0.zip manifest.json main.js styles.css versions.json README.md
```

To bump version: edit `manifest.json` + `versions.json`, commit, tag.

## Why not decrypt locally?

The whole point of the age-encrypted vault is that **the private key
lives on exactly one host** (the operator's hub server, offline-backed
up via `vault-rag-backup`). A plugin that also decrypts locally would
need that key on every device — a lost laptop or phone would then
yield the entire vault. Server-side decrypt + revoke-on-loss is the
safer trade-off.

## See also

- `docs/obsidian-setup.md` (vt-0145) — sync the *Markdown* notes via
  Obsidian Git.
- vt-0142 — the audit log on the hub records every reveal (including
  the truncated sha256 of the bearer token), so you can see whose
  device hit which secret.
