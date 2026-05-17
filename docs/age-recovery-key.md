# Recovery key for vault.age (vt-0275)

`vault.age` is encrypted with **age**. By default it is encrypted to **one**
recipient — the public key derived from `/opt/vault-rag/.secrets/age.key`.
Lose that file and the entire history of secrets is unreadable forever.

This document covers adding a second **recovery recipient** (offline-stored
keypair) so that the loss of the primary key is recoverable.

## Threat model

What we are protecting against:

- Accidental `rm -rf /opt/vault-rag/.secrets/` during operator error.
- Disk failure on the host (the only place `age.key` lives).
- Ransomware encrypting the host volume.
- Sloppy host rebuild that forgot to restore `.secrets/`.

What we are NOT protecting against:

- Targeted theft of the offline backup. The recovery key, by definition,
  decrypts every secret. Keep it where you keep paper wills and lasting
  power-of-attorney documents.

## One-time setup

### 1. Generate the recovery key on a clean offline machine

Boot a Tails / Knoppix live ISO, or simply a freshly-imaged laptop. The
goal is that this keypair NEVER touches the prod host or any
internet-connected disk.

```bash
mkdir -p /tmp/vault-recovery
age-keygen -o /tmp/vault-recovery/recovery.key
cat /tmp/vault-recovery/recovery.key
```

Output:

```
# created: 2026-…
# public key: age1...
AGE-SECRET-KEY-1...
```

**Print the public key** (the `age1…` line). You'll only need this on
the server.

**Copy the entire file** (private + comment lines) to either:
- A USB key, then physically lock it in a drawer.
- A QR-code printout (the file is short — `qrencode -o recovery.png < recovery.key`).
- An offline password manager that you ALSO trust with offline backups.

Now wipe the temp directory and shut down the offline machine:

```bash
shred -u /tmp/vault-recovery/recovery.key
poweroff
```

### 2. Add the public key on the prod host

```bash
ssh -p 977 root@brain.itiswednesdaymydud.es
cd /opt/vault-rag
./scripts/bin/vault-rag-recipients add age1<recovery-pubkey> -c "offline-recovery-2026Q2"
```

The script:
1. Verifies the current `age.key` can still decrypt `vault.age` (refuses
   otherwise, to avoid locking the operator out).
2. Appends the new pubkey + comment to `secrets/recipients`.
3. Re-encrypts `vault.age` with the full recipient set.
4. Commits the change to the obsidian-vault git repo.
5. Restarts `vault-rag-secrets` so it loads the new ciphertext.

Verify:

```bash
./scripts/bin/vault-rag-recipients list
vt secrets list   # should still work
```

### 3. Document the recovery procedure

Add a printed page to your physical safe / family-safe location:

```
vault-rag age recovery key
location: <safe / drawer / cloud-cold-storage>
public key (matches recipients line):
  age1...
Created: 2026-…
Operator at time of creation: <name + contact>
```

## Disaster recovery using the offline key

When the primary `age.key` is lost / corrupted:

```bash
# On any machine with docker + age + this repo:
git clone <forgejo-mirror> obsidian-vault
docker run --rm -v $(pwd)/obsidian-vault:/v alpine sh -c 'apk add age && \
  cat /v/secrets/vault.age | age -d -i /mnt/usb/recovery.key > /v/secrets/vault.txt'
# Inspect /v/secrets/vault.txt — this is the plaintext (KEY=value) backing
# the secrets store. Restore + re-encrypt to a fresh primary recipient.
```

## Rotating the primary key

The same flow works to rotate the primary `age.key` itself:

1. Generate new primary: `age-keygen -o /opt/vault-rag/.secrets/age.key.new`.
2. Add its pubkey: `vault-rag-recipients add age1<new-primary>`.
3. Verify decrypt works with the new key:
   `age -d -i /opt/vault-rag/.secrets/age.key.new /root/obsidian-vault/secrets/vault.age | head`.
4. Swap: `mv /opt/vault-rag/.secrets/age.key{,.old} && mv /opt/vault-rag/.secrets/age.key{.new,}`.
5. Restart: `docker compose restart vault-rag-secrets`.
6. Remove the old pubkey: `vault-rag-recipients remove age1<old-primary>`.
7. Securely wipe `age.key.old`: `shred -u /opt/vault-rag/.secrets/age.key.old`.

Cadence: rotate the primary key when a teammate with shell access leaves,
or annually whichever comes first. The offline recovery key need not
rotate as often — operator decides based on offline storage threat model.
