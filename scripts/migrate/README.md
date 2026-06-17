# Migrate from upstream OpenArchiver to this fork

Preserves **everything that matters**:

| Asset | Preserved how |
|-------|----------------|
| PostgreSQL | `pg_dump` backup + same volume/DB; fork runs `db:migrate` (adds indexes only) |
| Archived `.eml` files | Storage directory untouched (`STORAGE_LOCAL_ROOT_PATH` / `OA_DATA`) |
| Meilisearch data | Volume kept; **re-index queued** for new fields (`tags`, `hasAttachments`) |
| Secrets (`.env`) | Copied/restored; missing fork keys merged via `merge-env.sh` |
| Ingestion sources | Rows + encrypted credentials unchanged in DB |
| Users / roles / API keys | Unchanged in DB |

## Quick start

### Bare-metal (installer / systemd)

```bash
sudo bash scripts/migrate/migrate-to-fork.sh --mode bare-metal --oa-dir /opt/openarchiver
```

### Docker (upstream `logiclabshq/open-archiver` image)

```bash
cd /path/to/compose-project   # directory with docker-compose.yml + .env
sudo bash /opt/openarchiver/scripts/migrate/migrate-to-fork.sh \
  --mode docker \
  --compose-dir "$(pwd)"
```

This will:

1. Backup `.env`, PostgreSQL dump, and storage tarball
2. Stop the app container
3. Clone the fork, build `open-archiver-fork:local`
4. Apply `docker-compose.fork.yml` overlay
5. Start stack (migrations run in entrypoint)
6. Queue full search re-index

### Git checkout (development)

```bash
bash scripts/migrate/migrate-to-fork.sh --mode git --oa-dir "$(pwd)"
```

## Options

```
--mode bare-metal|docker|git   Force install type (default: auto-detect)
--oa-dir PATH                  Source/install directory
--compose-dir PATH             Docker compose project directory
--data-dir PATH                Override storage path
--backup-dir PATH              Custom backup location
--fork-repo URL                Default: jacksonm36/OpenArchiver_fork
--fork-branch BRANCH           Default: main
--skip-backup                  Not recommended
--skip-reindex                 Skip Meilisearch re-index queue
--dry-run                      Show planned steps only
```

## Manual steps (if needed)

### Merge new environment variables only

```bash
bash scripts/migrate/merge-env.sh /opt/openarchiver/.env
```

Adds keys from `.env.example` without overwriting existing secrets:

- `RESOURCE_PROFILE`
- `BODY_SIZE_LIMIT=Infinity`
- `OA_DATA` / `IMPORT_ALLOWED_PATHS`

### Re-index search only

After workers are running:

```bash
cd /opt/openarchiver
node --env-file=.env scripts/migrate/reindex-all-emails.mjs
```

Optional: `REINDEX_BATCH_SIZE=25` for low-RAM hosts.

## Rollback

If something goes wrong:

1. Stop the fork (`systemctl stop openarchiver` or `docker compose stop`)
2. Restore `.env` from backup
3. Restore PostgreSQL: `psql $DATABASE_URL < backup/postgres.sql`
4. Restore storage: `tar -xzf backup/storage.tar.gz -C /`
5. Revert git remote to upstream or redeploy upstream Docker image

## What changes in the fork (not data loss)

- New DB migration `0035_msgid_header_source_idx` (index only)
- Meilisearch settings extended (app updates on startup)
- New env vars for resource tuning and import path security
- Application code only — no schema changes to email tables

## Requirements

- Bash 4+, `git`, `curl`, `tar`, `pg_dump`
- Docker mode: Docker Compose v2
- Bare-metal: `pnpm`, Node 22 (same as installer)
- Disk space: backup needs ~2× storage size temporarily
