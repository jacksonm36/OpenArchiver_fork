# Migrate between upstream OpenArchiver and this fork

Both migration scripts **automatically back up every mission-critical asset** before changing anything. Migration aborts if the backup verification fails (unless you pass `--skip-backup`, which is not recommended).

## What gets backed up automatically

| Asset | Backup files | Why it matters |
|-------|----------------|----------------|
| **PostgreSQL** | `postgres.sql`, `postgres.dump`, `postgres-volume.tar.gz` (Docker) | Ingestion sources, archived email metadata, users, roles, credentials |
| **Secrets (`.env`)** | `.env`, `critical-secrets-inventory.txt` | `JWT_SECRET`, `ENCRYPTION_KEY`, `STORAGE_ENCRYPTION_KEY`, DB/Redis/Meili passwords |
| **Archived emails** | `storage.tar.gz` | `.eml` files on disk (`STORAGE_LOCAL_ROOT_PATH` / `OA_DATA`) |
| **Meilisearch** | `meilisearch-volume.tar.gz`, `meilisearch-dump-response.json` | Search index |
| **Valkey/Redis** | `valkey.rdb`, `valkeydata-volume.tar.gz` | In-flight job queues (volatile but backed up when possible) |
| **Compose config** | `docker-compose.yml` (+ fork overlay if present) | Restore deployment layout |

**S3 storage:** If `STORAGE_TYPE=s3`, blobs live in your S3 bucket. The backup includes S3 credentials in `.env` only — ensure the bucket has its own backup policy.

### Standalone backup (no migration)

```bash
# Docker
bash scripts/migrate/backup-critical.sh --mode docker --compose-dir /path/to/compose

# Bare-metal / systemd
sudo bash scripts/migrate/backup-critical.sh --mode bare-metal --oa-dir /opt/openarchiver
```

Backup lands in `./openarchiver-migration-backup-YYYYMMDD-HHMMSS/` with `backup-manifest.txt` restore instructions.

---

## Upstream → Fork

```bash
# Bare-metal
sudo bash scripts/migrate/migrate-to-fork.sh --mode bare-metal --oa-dir /opt/openarchiver

# Docker
cd /path/to/compose-project
sudo bash scripts/migrate/migrate-to-fork.sh --mode docker --compose-dir "$(pwd)"

# Dry run
sudo bash scripts/migrate/migrate-to-fork.sh --mode docker --compose-dir . --dry-run
```

Steps: **backup → stop → deploy fork → migrate DB → start → reindex**

---

## Fork → Upstream (rollback)

```bash
sudo bash scripts/migrate/migrate-to-upstream.sh --mode docker --compose-dir /path/to/compose
sudo bash scripts/migrate/migrate-to-upstream.sh --mode bare-metal --oa-dir /opt/openarchiver
```

Steps: **backup → stop → deploy upstream → start** (fork DB migrations 0035/0036 remain harmlessly)

---

## Options (both scripts)

```
--mode bare-metal|docker|git   Force install type (default: auto-detect)
--oa-dir PATH                  Source/install directory
--compose-dir PATH             Docker compose project directory
--data-dir PATH                Override storage path
--backup-dir PATH              Custom backup location
--skip-backup                  Not recommended — skips all automatic backups
--skip-reindex                 Skip Meilisearch re-index queue
--dry-run                      Show planned steps only
```

Fork-only options (`migrate-to-fork.sh`):

```
--fork-repo URL                Default: jacksonm36/OpenArchiver_fork
--fork-branch BRANCH           Default: main
```

Upstream-only options (`migrate-to-upstream.sh`):

```
--upstream-ref REF             Default: main
--upstream-image IMAGE         Default: logiclabshq/open-archiver:latest
```

---

## Manual steps

### Merge new environment variables only

```bash
bash scripts/migrate/merge-env.sh /opt/openarchiver/.env
```

Adds keys from `.env.example` without overwriting existing secrets.

### Re-index search only

```bash
cd /opt/openarchiver
node --env-file=.env scripts/migrate/reindex-all-emails.mjs
```

Optional: `REINDEX_BATCH_SIZE=25` for low-RAM hosts.

---

## Full restore from backup

1. Stop app + workers (`systemctl stop openarchiver` or `docker compose stop`)
2. Restore `.env`: `cp backup/.env /opt/openarchiver/.env`
3. Restore PostgreSQL:
   ```bash
   psql "$DATABASE_URL" < backup/postgres.sql
   # or: pg_restore -d "$DATABASE_URL" --clean --if-exists backup/postgres.dump
   ```
4. Restore email storage:
   ```bash
   tar -xzf backup/storage.tar.gz -C "$(dirname "$STORAGE_LOCAL_ROOT_PATH")"
   ```
5. Restore Meilisearch (Docker): extract `meilisearch-volume.tar.gz` into the `meilidata` volume
6. Restore Valkey (optional): copy `valkey.rdb` into the Valkey data directory or extract `valkeydata-volume.tar.gz`
7. Start the stack and verify archived emails + search

See `backup-manifest.txt` inside each backup directory for paths specific to that run.

---

## DB migrations when switching

| Direction | Migrations |
|-----------|------------|
| Upstream → Fork | Runs `db:migrate` forward (0035, 0036, …) |
| Fork → Upstream | Does **not** downgrade schema; extra indexes stay in PostgreSQL |

Migration `0036` deduplicates `(message_id_header, ingestion_source_id)` — always review backup before applying on production.

---

## Requirements

- Bash 4+, `git`, `curl`, `tar`, `pg_dump`
- Docker mode: Docker Compose v2
- Bare-metal: `pnpm`, Node 22
- Disk space: plan for ~2× storage size + DB dump size temporarily
