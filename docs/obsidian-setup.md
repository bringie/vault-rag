# Obsidian + vault-rag setup (vt-0145)

Open your vault-rag notes in Obsidian: full local Markdown editing, mobile support, graph view, plugin ecosystem. Sync via the bundled Forgejo using a dedicated PAT + the [Obsidian Git](https://github.com/Vinzent03/obsidian-git) community plugin.

> **Heads-up**: Obsidian and the Fleet UI vault tab (vt-0146/vt-0147) write to the same git repo. Concurrent edits to the same note within a minute can collide. The Fleet UI editor uses optimistic concurrency (`expected_sha` → 412 on conflict, vt-0141); the host-side `vault-sync.sh` will quarantine divergent commits into `_refactor/conflicts/`. Best practice: don't edit the same note in both places at once.

## 1. Generate a Forgejo PAT

1. Open `https://<your-hub-domain>/git/-/user/settings/applications`
2. **Generate New Token**:
   - Name: `obsidian-vault-sync-<your-device-name>` (one PAT per device)
   - Scopes: `read:repository` + `write:repository` ONLY (do NOT enable admin/admin_org — minimum privilege)
   - Expiration: 90 days (rotate quarterly)
3. Copy the token immediately — Forgejo won't show it again. You'll paste it into the clone URL below.

## 2. Clone the vault locally

HTTPS clone (works behind firewalls + on mobile; SSH 222 is filtered to LAN-only per vt-0138):

```bash
PAT='<your-PAT-from-step-1>'
USER='<your-forgejo-username>'   # e.g. root for single-tenant deployments
HUB='<your-hub-domain>'           # e.g. brain.itiswednesdaymydud.es
git clone "https://${USER}:${PAT}@${HUB}/git/${USER}/obsidian-vault.git" ~/Obsidian/vault-rag
```

The PAT ends up in `~/Obsidian/vault-rag/.git/config`. Treat that file as a secret.

## 3. Open as an Obsidian vault

1. Launch Obsidian → **Open folder as vault** → `~/Obsidian/vault-rag`
2. Trust the vault when prompted (it has community plugins via Obsidian Git).
3. Wait for the index to build (~30s for a 26 MB vault).

## 4. Install Obsidian Git plugin

1. Settings → Community plugins → Browse → search **Obsidian Git** → Install → Enable.
2. Configure (Settings → Obsidian Git):
   - **Auto pull on startup**: on
   - **Auto push interval**: 10 minutes
   - **Commit message template**: `obsidian: {{numFiles}} files updated`
   - **List filenames affected by commit in the commit body**: on
   - **Disable on mobile data**: on (saves your phone plan)
   - **Show status bar**: on (so you can spot sync errors)
3. Verify the plugin is happy:
   - Bottom-right status bar should show **synced ...s ago** within a minute of opening the vault.
   - If it shows **conflict**, see "Conflicts" below.

## 5. Mobile (iOS / Android)

Obsidian Git on mobile uses [isomorphic-git](https://isomorphic-git.org/) — a pure-JS git client. Differences vs desktop:

- **Slower** initial clone (~60 s for our vault).
- **HTTPS only** — same PAT-in-URL approach as desktop.
- **Binary files** (`secrets/vault.age`, `secrets/recipients`) — marked `binary` in `.gitattributes` (vt-0145) so isomorphic-git doesn't attempt line-ending normalisation or delta diffs (both would corrupt the age blob).
- **Conflicts** open a Markdown diff in a textbox — resolve manually, then push from the desktop client.

To clone on mobile:
1. Install Obsidian app.
2. Create a new vault (any name; we'll overwrite).
3. Open Obsidian Git plugin settings → **Clone from URL** → paste the same HTTPS URL with PAT.

## 6. Secrets (encrypted at rest)

`secrets/vault.age` is age-encrypted. Obsidian sees it as a binary blob — it does NOT decrypt locally. To view a secret value:

- **From Fleet UI**: open the Secrets tab in `https://<your-hub>/fleet/` (admin token required, see vt-0142/0147).
- **From CLI**: `vt secrets get NAME` (uses MCP / REST under the hood).
- **Future** (vt-0148, deferred): in-Obsidian decrypt plugin.

The age private key (`/opt/vault-rag/.secrets/age.key`) lives ONLY on the hub server — it is NOT cloned to your Obsidian device. This is intentional: a stolen laptop / phone yields ciphertext, not plaintext.

## 7. Conflicts

If Obsidian Git status shows **conflict**:

1. **Don't panic** — your local edits are still on disk under `~/Obsidian/vault-rag`.
2. Open the conflicted file in Obsidian. It will contain `<<<<<<< HEAD` / `=======` / `>>>>>>>` markers.
3. Edit to keep what you want.
4. Obsidian Git → **Commit all changes** with a message like `resolve conflict: <reason>`.
5. **Pull** then **Push**.

If `vault-sync.sh` quarantined your commit into `obsidian-vault/_refactor/conflicts/`:

1. On the hub server: `ls /root/obsidian-vault/_refactor/conflicts/`
2. The `.patch` file holds your divergent commit. Inspect it.
3. Re-apply manually after a clean pull, or `git am --3way <patch>`.

## 8. PAT rotation

Every 90 days:

1. Forgejo → Settings → Applications → revoke the old PAT.
2. Generate a new one with the same scopes.
3. On each device: `git remote set-url origin "https://${USER}:${NEW_PAT}@..."`
4. Verify with `git fetch`.

## 9. Removing a device

If you lose a laptop / phone:

1. Forgejo → Applications → revoke that device's PAT immediately. (You'll want to maintain a one-PAT-per-device naming discipline to make this easy.)
2. On the hub: nothing else — the host's deploy key (`/opt/vault-rag/.secrets/git_deploy.key`) is separate.

---

**Links**

- [Obsidian Git plugin](https://github.com/Vinzent03/obsidian-git) (community)
- vt-0141: `/api/put expected_sha` optimistic-concurrency design
- vt-0146/vt-0147: Fleet UI vault tab
- vt-0148: in-Obsidian decrypt plugin (deferred)
