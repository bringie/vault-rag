# Point-in-time recovery (vt-0303)

Daily `pg_dump` (vt-0272) gives ~24h RPO. WAL archiving cuts that to
~5 minutes by streaming every WAL segment to `/backups/wal/` on the
host. Combine the two for full PITR.

## What's running

- `archive_mode=on`, `archive_command="test ! -f /backups/wal/%f && cp %p /backups/wal/%f"`.
- `archive_timeout=300` forces a WAL switch every 5 min on idle
  databases. Busy DBs fill 16 MiB faster and switch on their own.
- ofelia `wal-prune` at 02:30 UTC removes WAL files older than 7
  days. Anything beyond 7d is reachable via the daily pg_dump.
- 7d of WAL ≈ ~hundreds of 16 MiB segments depending on write rate;
  budget ~5-30 GiB on the host.

## Recovery (PITR) procedure

You'll need:
- The most recent `vault_rag-YYYY-MM-DD.dump` from `/var/backups/vault-rag/`.
- All WAL segments produced AFTER that dump, in `/var/backups/vault-rag/wal/`.
- A target recovery timestamp (e.g. "2026-05-17 10:14:00 UTC", right
  before the bad operator command).

### 1. Stop the current postgres

```bash
cd /opt/vault-rag
docker compose stop vault-rag-postgres
```

### 2. Restore the base backup into a scratch volume

```bash
docker volume create vault-rag-pgdata-pitr
docker run --rm \
  -v vault-rag-pgdata-pitr:/var/lib/postgresql/data \
  -v /var/backups/vault-rag:/backups:ro \
  pgvector/pgvector:pg16 \
  bash -c '
    set -e
    chown -R postgres:postgres /var/lib/postgresql/data
    chmod 0700 /var/lib/postgresql/data
    su postgres -c "
      initdb -D /var/lib/postgresql/data
      pg_restore -d postgres /backups/vault_rag-YYYY-MM-DD.dump || true
    "
  '
```

(The `|| true` is because `pg_restore` may emit "errors ignored" on
the global ACL sections — they're cosmetic.)

### 3. Configure recovery target

In the new pgdata, create `recovery.signal` and set restore params via
`postgresql.auto.conf`:

```bash
docker run --rm \
  -v vault-rag-pgdata-pitr:/var/lib/postgresql/data \
  -v /var/backups/vault-rag:/backups:ro \
  pgvector/pgvector:pg16 \
  bash -c "
    touch /var/lib/postgresql/data/recovery.signal
    cat >> /var/lib/postgresql/data/postgresql.auto.conf <<EOF
restore_command = 'cp /backups/wal/%f %p'
recovery_target_time = '2026-05-17 10:14:00 UTC'
recovery_target_action = 'promote'
EOF
    chown -R postgres:postgres /var/lib/postgresql/data
  "
```

### 4. Verify by attaching a throwaway pg

```bash
docker run --rm -p 15432:5432 \
  -v vault-rag-pgdata-pitr:/var/lib/postgresql/data \
  -v /var/backups/vault-rag:/backups:ro \
  pgvector/pgvector:pg16
```

Connect with `psql -h localhost -p 15432 -U postgres` and inspect the
state. If it looks right, kill the throwaway container.

### 5. Swap into production

If you're satisfied:

```bash
docker compose stop vault-rag-postgres
docker volume rm vault-rag-pgdata          # destructive — backup first
docker volume create vault-rag-pgdata
# Restore the recovered volume contents
docker run --rm \
  -v vault-rag-pgdata-pitr:/src:ro \
  -v vault-rag-pgdata:/dst \
  alpine sh -c 'cp -a /src/. /dst/'
docker compose up -d vault-rag-postgres
```

## Tuning knobs

| Setting | Default | What it does |
|---|---|---|
| `archive_timeout` | 300 (5 min) | Forces WAL switch every N seconds. Lower = better RPO, more files. |
| `wal-prune` mtime | 7 days | How long PITR window stretches. Bump if you need older recovery points. |
| `wal_keep_size` | 512MB | Keeps WAL on the active server even if archiving lags. Cheap insurance. |

## Caveats

- This is **local** PITR — both base + WAL live on the same host. A
  full host loss still loses everything. Off-host copy (rsync the
  /var/backups/vault-rag tree to S3 or a second host) closes that
  gap. Doc'd separately.
- `archive_command` blocks postgres if the destination is full /
  read-only. The wal-prune cron should keep `/backups/wal/` healthy
  but the operator should also monitor `df /var/backups/vault-rag`.
- recovery_target_time is in **UTC**. Off-by-three-hours operator
  mistakes are common.

## Runbook: archive_command retry-loop on duplicate file (vt-0317)

The canonical `test ! -f /backups/wal/%f && cp %p /backups/wal/%f`
returns non-zero when the destination file ALREADY exists. Postgres
retries the same segment every ~60 s indefinitely. This is the
documented postgres pattern — duplicate-filename means something
went wrong (crash mid-archive, manual `mv-back`, restored-from-base-
backup-then-promoted) and the operator must investigate.

**Symptom:** `WalArchiveStale` alert fires; `docker logs vault-rag-postgres`
shows repeated `archive command failed with exit code 1` for the same
filename.

**Diagnosis + recovery:**

```bash
# Identify the wedged segment from postgres logs
SEG=$(docker logs vault-rag-postgres --tail 50 2>&1 \
  | grep -oE '[0-9A-F]{24}\.partial?|[0-9A-F]{24}' | tail -1)
echo "wedged on: $SEG"

# Compare the archived copy with what postgres is trying to push
docker exec vault-rag-postgres bash -c "
  diff -q /backups/wal/$SEG /var/lib/postgresql/data/pg_wal/$SEG
"
# Output: 'Files … differ' → operator decision (mv-aside old, re-archive)
# Output: '(no output, exit 0)' → safe to rm the dest; postgres will re-cp

# If identical, simply remove the destination — postgres advances:
docker exec vault-rag-postgres rm /backups/wal/$SEG

# Verify the archiver caught up
docker exec vault-rag-postgres psql -U postgres -d vault_rag -c \
  "SELECT last_archived_wal, last_failed_wal FROM pg_stat_archiver"
```

If the files **differ** (rare — implies corruption or a mismatched
restore), move the old archive aside:

```bash
docker exec vault-rag-postgres mv /backups/wal/$SEG /backups/wal/$SEG.diff-$(date +%s)
# Postgres re-archives the current pg_wal copy on the next retry tick.
```
