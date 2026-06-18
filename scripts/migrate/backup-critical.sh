#!/usr/bin/env bash
# Backup every mission-critical Open Archiver asset before migration or rollback.
#
# Usage (standalone):
#   bash scripts/migrate/backup-critical.sh --mode docker --compose-dir /path/to/compose
#   bash scripts/migrate/backup-critical.sh --mode bare-metal --oa-dir /opt/openarchiver
#
# Usage (sourced from migrate-to-fork.sh / migrate-to-upstream.sh):
#   source scripts/migrate/backup-critical.sh
#   backup_critical

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Mission-critical env keys (values live in .env backup; this list is for post-backup verification).
readonly CRITICAL_ENV_KEYS=(
  DATABASE_URL
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  STORAGE_ENCRYPTION_KEY
  ENCRYPTION_KEY
  JWT_SECRET
  MEILI_MASTER_KEY
  MEILI_HOST
  REDIS_PASSWORD
  REDIS_HOST
  REDIS_PORT
  STORAGE_TYPE
  STORAGE_LOCAL_ROOT_PATH
  STORAGE_S3_BUCKET
  STORAGE_S3_ACCESS_KEY_ID
  STORAGE_S3_SECRET_ACCESS_KEY
)

BC_MODE="${BC_MODE:-}"
BC_OA_DIR="${BC_OA_DIR:-/opt/openarchiver}"
BC_COMPOSE_DIR="${BC_COMPOSE_DIR:-}"
BC_DATA_DIR="${BC_DATA_DIR:-}"
BC_BACKUP_DIR="${BC_BACKUP_DIR:-}"
BC_DRY_RUN="${BC_DRY_RUN:-0}"

bc_msg() { echo -e "\e[34m[backup]\e[0m $*"; }
bc_ok()  { echo -e "\e[32m[ ok ]\e[0m $*"; }
bc_warn(){ echo -e "\e[33m[warn]\e[0m $*"; }
bc_err() { echo -e "\e[31m[err ]\e[0m $*"; exit 1; }

bc_run() {
  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

bc_load_env() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

bc_resolve_paths() {
  local env_file=""
  case "$BC_MODE" in
    docker) env_file="${BC_COMPOSE_DIR}/.env" ;;
    *) env_file="${BC_OA_DIR}/.env" ;;
  esac
  bc_load_env "$env_file"

  if [[ -z "$BC_DATA_DIR" ]]; then
    BC_DATA_DIR="${OA_DATA:-${STORAGE_LOCAL_ROOT_PATH:-/opt/openarchiver-data}}"
  fi

  if [[ -z "$BC_BACKUP_DIR" ]]; then
    local ts
    ts="$(date +%Y%m%d-%H%M%S)"
    BC_BACKUP_DIR="./openarchiver-migration-backup-${ts}"
  fi
}

bc_compose() {
  docker compose -f "${BC_COMPOSE_DIR}/docker-compose.yml" "$@"
}

bc_compose_project_name() {
  local project=""
  local cid
  cid="$(bc_compose ps -aq 2>/dev/null | head -1 || true)"
  if [[ -n "$cid" ]]; then
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null || true)"
  fi
  if [[ -z "$project" ]]; then
    project="$(basename "$(cd "${BC_COMPOSE_DIR}" && pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
  fi
  echo "$project"
}

bc_docker_volume_name() {
  local vol_suffix="$1"
  local project vol_name
  project="$(bc_compose_project_name)"
  vol_name="${project}_${vol_suffix}"
  if docker volume inspect "$vol_name" >/dev/null 2>&1; then
    echo "$vol_name"
    return 0
  fi
  if docker volume inspect "$vol_suffix" >/dev/null 2>&1; then
    echo "$vol_suffix"
    return 0
  fi
  echo ""
}

bc_backup_docker_volume() {
  local vol_suffix="$1"
  local out_name="$2"
  local vol_name

  vol_name="$(bc_docker_volume_name "$vol_suffix")"
  [[ -n "$vol_name" ]] || {
    bc_warn "Docker volume not found (${vol_suffix}) — skipped ${out_name}"
    return 0
  }

  bc_msg "Archiving Docker volume ${vol_name} -> ${out_name}..."
  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] docker run alpine tar ${vol_name} -> ${out_name}"
    return 0
  fi
  docker run --rm \
    -v "${vol_name}:/volume:ro" \
    -v "${BC_BACKUP_DIR}:/backup" \
    alpine tar -czf "/backup/${out_name}" -C /volume .
  bc_ok "${out_name}"
}

bc_backup_postgres_docker() {
  bc_msg "PostgreSQL dump (SQL)..."
  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] pg_dump -> ${BC_BACKUP_DIR}/postgres.sql"
    echo "[dry-run] pg_dump -Fc -> ${BC_BACKUP_DIR}/postgres.dump"
    return 0
  fi
  bc_compose exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-admin}" "${POSTGRES_DB:-open_archive}" \
    >"${BC_BACKUP_DIR}/postgres.sql"

  bc_msg "PostgreSQL dump (custom format, for pg_restore)..."
  bc_compose exec -T postgres \
    pg_dump -Fc -U "${POSTGRES_USER:-admin}" "${POSTGRES_DB:-open_archive}" \
    >"${BC_BACKUP_DIR}/postgres.dump"
}

bc_backup_postgres_native() {
  bc_msg "PostgreSQL dump (SQL)..."
  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] pg_dump -> ${BC_BACKUP_DIR}/postgres.sql"
    echo "[dry-run] pg_dump -Fc -> ${BC_BACKUP_DIR}/postgres.dump"
    return 0
  fi
  if [[ -n "${DATABASE_URL:-}" ]] && command -v pg_dump >/dev/null 2>&1; then
    pg_dump "$DATABASE_URL" >"${BC_BACKUP_DIR}/postgres.sql"
    pg_dump -Fc "$DATABASE_URL" >"${BC_BACKUP_DIR}/postgres.dump"
  elif command -v pg_dump >/dev/null 2>&1 && [[ -n "${POSTGRES_DB:-}" ]]; then
    pg_dump -U "${POSTGRES_USER:-admin}" "${POSTGRES_DB}" >"${BC_BACKUP_DIR}/postgres.sql"
    pg_dump -Fc -U "${POSTGRES_USER:-admin}" "${POSTGRES_DB}" >"${BC_BACKUP_DIR}/postgres.dump"
  else
    bc_warn "pg_dump unavailable — back up PostgreSQL manually before migrating"
    return 1
  fi
}

bc_backup_meilisearch_api() {
  local meili_host="${MEILI_HOST:-http://localhost:7700}"
  local meili_key="${MEILI_MASTER_KEY:-}"

  [[ -n "$meili_key" ]] || { bc_warn "MEILI_MASTER_KEY unset — skipping Meilisearch API dump"; return 0; }

  bc_msg "Meilisearch snapshot via API (${meili_host})..."
  if command -v curl >/dev/null 2>&1; then
    local dump_resp
    dump_resp="$(curl -sf -X POST "${meili_host}/dumps" \
      -H "Authorization: Bearer ${meili_key}" 2>/dev/null || true)"
    if [[ -n "$dump_resp" ]]; then
      echo "$dump_resp" >"${BC_BACKUP_DIR}/meilisearch-dump-response.json"
      bc_ok "Meilisearch dump triggered (see meilisearch-dump-response.json)"
      return 0
    fi
  fi
  bc_warn "Meilisearch API dump failed — volume/archive backup used if available"
  return 0
}

bc_backup_valkey_native() {
  local redis_host="${REDIS_HOST:-localhost}"
  local redis_port="${REDIS_PORT:-6379}"
  local redis_pass="${REDIS_PASSWORD:-}"

  command -v redis-cli >/dev/null 2>&1 || command -v valkey-cli >/dev/null 2>&1 || {
    bc_warn "redis-cli/valkey-cli not found — skipping Valkey RDB backup"
    return 0
  }

  local cli="redis-cli"
  command -v valkey-cli >/dev/null 2>&1 && cli="valkey-cli"

  bc_msg "Valkey/Redis RDB snapshot..."
  if [[ -n "$redis_pass" ]]; then
    bc_run "$cli" -h "$redis_host" -p "$redis_port" -a "$redis_pass" --no-auth-warning BGSAVE >/dev/null 2>&1 || true
    bc_run "$cli" -h "$redis_host" -p "$redis_port" -a "$redis_pass" --no-auth-warning --rdb "${BC_BACKUP_DIR}/valkey.rdb" >/dev/null 2>&1 || \
      bc_warn "Could not export Valkey RDB — job queues may not restore (re-queue jobs after rollback)"
  else
    bc_run "$cli" -h "$redis_host" -p "$redis_port" BGSAVE >/dev/null 2>&1 || true
    bc_run "$cli" -h "$redis_host" -p "$redis_port" --rdb "${BC_BACKUP_DIR}/valkey.rdb" >/dev/null 2>&1 || \
      bc_warn "Could not export Valkey RDB"
  fi
}

bc_backup_valkey_docker() {
  local vol_name
  vol_name="$(bc_docker_volume_name "valkeydata")"

  bc_msg "Valkey/Redis RDB snapshot..."
  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] valkey BGSAVE + copy dump.rdb"
    return 0
  fi

  bc_compose exec -T valkey valkey-cli -a "${REDIS_PASSWORD}" --no-auth-warning BGSAVE >/dev/null 2>&1 || true
  if [[ -n "$vol_name" ]]; then
    docker run --rm \
      -v "${vol_name}:/data:ro" \
      -v "${BC_BACKUP_DIR}:/backup" \
      alpine sh -c 'cp /data/dump.rdb /backup/valkey.rdb 2>/dev/null || true'
  fi
  if [[ -f "${BC_BACKUP_DIR}/valkey.rdb" && -s "${BC_BACKUP_DIR}/valkey.rdb" ]]; then
    bc_ok "valkey.rdb"
  else
    bc_warn "Valkey RDB empty or missing — job queues are volatile; drain jobs before migrating if possible"
  fi
}

bc_write_secrets_inventory() {
  local env_file="$1"
  local out="${BC_BACKUP_DIR}/critical-secrets-inventory.txt"

  {
    echo "# Open Archiver critical secrets inventory"
    echo "# Generated: $(date -Iseconds)"
    echo "# Values are NOT stored here — they are in the .env backup file."
    echo ""
  } >"$out"

  [[ -f "$env_file" ]] || return 0

  local key val present
  for key in "${CRITICAL_ENV_KEYS[@]}"; do
    present="MISSING"
    if grep -q "^${key}=" "$env_file" 2>/dev/null; then
      val="$(grep "^${key}=" "$env_file" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
      if [[ -n "$val" ]]; then
        present="SET (${#val} chars)"
      else
        present="EMPTY (optional or misconfigured)"
      fi
    fi
    printf "%-32s %s\n" "$key" "$present" >>"$out"
  done
}

bc_write_manifest() {
  local manifest="${BC_BACKUP_DIR}/backup-manifest.txt"
  local env_file=""
  case "$BC_MODE" in
    docker) env_file="${BC_COMPOSE_DIR}/.env" ;;
    *) env_file="${BC_OA_DIR}/.env" ;;
  esac

  {
    echo "Open Archiver mission-critical backup"
    echo "======================================"
    echo "Timestamp:    $(date -Iseconds)"
    echo "Mode:         ${BC_MODE}"
    echo "Backup dir:   ${BC_BACKUP_DIR}"
    echo "Data dir:     ${BC_DATA_DIR}"
    echo "Storage type: ${STORAGE_TYPE:-local}"
    echo ""
    echo "Files:"
    ls -lh "${BC_BACKUP_DIR}" 2>/dev/null | tail -n +2 || true
    echo ""
    echo "Restore (quick reference):"
    echo "  1. Stop app + workers"
    echo "  2. cp ${BC_BACKUP_DIR}/.env <install>/.env"
    echo "  3. psql \$DATABASE_URL < ${BC_BACKUP_DIR}/postgres.sql"
    echo "     # or: pg_restore -d \$DATABASE_URL ${BC_BACKUP_DIR}/postgres.dump"
    echo "  4. tar -xzf ${BC_BACKUP_DIR}/storage.tar.gz -C \$(dirname ${BC_DATA_DIR})"
    echo "  5. Restore Meilisearch volume from meilisearch-volume.tar.gz if present"
    echo "  6. Restore Valkey from valkey.rdb or valkeydata-volume.tar.gz if present"
    echo ""
    if [[ "${STORAGE_TYPE:-local}" == "s3" ]]; then
      echo "NOTE: STORAGE_TYPE=s3 — email blobs live in S3 (${STORAGE_S3_BUCKET:-unknown bucket})."
      echo "      This backup includes S3 credentials in .env only, not bucket contents."
      echo "      Ensure your S3 bucket has its own backup/replication policy."
      echo ""
    fi
  } >"$manifest"

  bc_write_secrets_inventory "$env_file"
}

bc_verify_backup() {
  local failed=0

  if [[ ! -s "${BC_BACKUP_DIR}/.env" ]]; then
    bc_warn ".env backup missing or empty"
    failed=1
  fi

  if [[ ! -s "${BC_BACKUP_DIR}/postgres.sql" ]]; then
    bc_warn "postgres.sql missing or empty — database cannot be restored from this backup"
    failed=1
  fi

  if [[ "${STORAGE_TYPE:-local}" == "local" ]]; then
    if [[ ! -s "${BC_BACKUP_DIR}/storage.tar.gz" ]]; then
      if [[ -d "$BC_DATA_DIR" ]]; then
        bc_warn "storage.tar.gz missing but data dir exists — archived emails may not be restorable"
        failed=1
      else
        bc_warn "No local storage directory at ${BC_DATA_DIR} (empty install?)"
      fi
    fi
  fi

  if [[ "$failed" -eq 1 ]]; then
    bc_err "Backup verification failed — fix errors above before migrating (or use --skip-backup at your own risk)"
  fi

  bc_ok "Backup verification passed"
}

# Main entry when sourced or called directly.
backup_critical() {
  bc_resolve_paths
  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    bc_msg "Backup directory (dry-run): ${BC_BACKUP_DIR}"
  else
    mkdir -p "$BC_BACKUP_DIR"
    bc_msg "Backup directory: ${BC_BACKUP_DIR}"
  fi

  local env_file compose_file
  case "$BC_MODE" in
    docker)
      env_file="${BC_COMPOSE_DIR}/.env"
      compose_file="${BC_COMPOSE_DIR}/docker-compose.yml"
      [[ -f "$compose_file" ]] || bc_err "docker-compose.yml not found in ${BC_COMPOSE_DIR}"

      bc_msg "Copying .env and compose files..."
      bc_run cp -a "$env_file" "${BC_BACKUP_DIR}/.env" 2>/dev/null || bc_warn ".env not found at ${env_file}"
      bc_run cp -a "$compose_file" "${BC_BACKUP_DIR}/docker-compose.yml" 2>/dev/null || true
      [[ -f "${BC_COMPOSE_DIR}/docker-compose.fork.yml" ]] && \
        bc_run cp -a "${BC_COMPOSE_DIR}/docker-compose.fork.yml" "${BC_BACKUP_DIR}/" 2>/dev/null || true

      bc_backup_postgres_docker || bc_warn "PostgreSQL backup incomplete"

      if [[ -d "$BC_DATA_DIR" ]]; then
        bc_msg "Archiving email storage (${BC_DATA_DIR})..."
        if [[ "$BC_DRY_RUN" -eq 1 ]]; then
          echo "[dry-run] tar storage -> storage.tar.gz"
        else
          tar -czf "${BC_BACKUP_DIR}/storage.tar.gz" -C "$(dirname "$BC_DATA_DIR")" "$(basename "$BC_DATA_DIR")"
          bc_ok "storage.tar.gz"
        fi
      elif [[ "${STORAGE_TYPE:-local}" == "local" ]]; then
        bc_warn "Storage path not found: ${BC_DATA_DIR}"
      fi

      bc_backup_docker_volume "meilidata" "meilisearch-volume.tar.gz"
      bc_backup_meilisearch_api
      bc_backup_docker_volume "valkeydata" "valkeydata-volume.tar.gz"
      bc_backup_valkey_docker
      bc_backup_docker_volume "pgdata" "postgres-volume.tar.gz"
      ;;
    bare-metal|git)
      env_file="${BC_OA_DIR}/.env"
      bc_msg "Copying .env..."
      if [[ "$BC_DRY_RUN" -eq 1 ]]; then
        echo "[dry-run] cp ${env_file} -> ${BC_BACKUP_DIR}/.env"
      else
        cp -a "$env_file" "${BC_BACKUP_DIR}/.env" 2>/dev/null || bc_warn ".env not found at ${env_file}"
      fi

      bc_backup_postgres_native || bc_warn "PostgreSQL backup incomplete"

      if [[ -d "$BC_DATA_DIR" ]]; then
        bc_msg "Archiving email storage (${BC_DATA_DIR})..."
        if [[ "$BC_DRY_RUN" -eq 1 ]]; then
          echo "[dry-run] tar storage -> storage.tar.gz"
        else
          tar -czf "${BC_BACKUP_DIR}/storage.tar.gz" -C "$(dirname "$BC_DATA_DIR")" "$(basename "$BC_DATA_DIR")"
          bc_ok "storage.tar.gz"
        fi
      elif [[ "${STORAGE_TYPE:-local}" == "local" ]]; then
        bc_warn "Storage path not found: ${BC_DATA_DIR}"
      fi

      bc_backup_meilisearch_api
      bc_backup_valkey_native
      ;;
    *)
      bc_err "Unknown backup mode: ${BC_MODE} (use docker|bare-metal|git)"
      ;;
  esac

  if [[ "$BC_DRY_RUN" -eq 1 ]]; then
    bc_ok "Dry-run backup plan complete: ${BC_BACKUP_DIR}"
    export BACKUP_DIR="$BC_BACKUP_DIR"
    return 0
  fi

  bc_write_manifest
  bc_verify_backup

  bc_ok "Mission-critical backup complete: ${BC_BACKUP_DIR}"
  export BACKUP_DIR="$BC_BACKUP_DIR"
}

bc_parse_standalone_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode) BC_MODE="${2:?}"; shift 2 ;;
      --oa-dir) BC_OA_DIR="${2:?}"; shift 2 ;;
      --compose-dir) BC_COMPOSE_DIR="${2:?}"; shift 2 ;;
      --data-dir) BC_DATA_DIR="${2:?}"; shift 2 ;;
      --backup-dir) BC_BACKUP_DIR="${2:?}"; shift 2 ;;
      --dry-run) BC_DRY_RUN=1; shift ;;
      -h|--help)
        sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
      *) bc_err "Unknown option: $1" ;;
    esac
  done

  [[ -n "$BC_MODE" ]] || bc_err "Pass --mode docker|bare-metal|git"
  [[ "$BC_MODE" != "docker" || -n "$BC_COMPOSE_DIR" ]] || \
    bc_err "Docker mode requires --compose-dir"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  bc_parse_standalone_args "$@"
  backup_critical
fi
