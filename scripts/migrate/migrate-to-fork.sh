#!/usr/bin/env bash
# Migrate an existing LogicLabs-OU/OpenArchiver install to jacksonm36/OpenArchiver_fork
# while preserving database, email storage, Meilisearch data, secrets, and ingestion sources.
#
# Usage:
#   sudo bash scripts/migrate/migrate-to-fork.sh --mode bare-metal
#   sudo bash scripts/migrate/migrate-to-fork.sh --mode docker --compose-dir /opt/openarchiver
#   sudo bash scripts/migrate/migrate-to-fork.sh --mode git --oa-dir /path/to/OpenArchiver
#
# Options:
#   --mode bare-metal|docker|git   Installation type (default: auto-detect)
#   --oa-dir PATH                  App source dir (default: /opt/openarchiver or compose dir)
#   --data-dir PATH                Storage/data dir (default: from .env STORAGE_LOCAL_ROOT_PATH or OA_DATA)
#   --backup-dir PATH              Backup root (default: ./openarchiver-migration-backup-TIMESTAMP)
#   --fork-repo URL                Git remote (default: jacksonm36/OpenArchiver_fork)
#   --fork-branch BRANCH           Git branch (default: main)
#   --skip-backup                  Skip backup step (not recommended)
#   --skip-reindex                 Skip search re-index queue
#   --dry-run                      Print actions without executing destructive steps

set -euo pipefail

FORK_REPO="${FORK_REPO:-https://github.com/jacksonm36/OpenArchiver_fork.git}"
FORK_BRANCH="${FORK_BRANCH:-main}"
OA_DIR="${OA_DIR:-/opt/openarchiver}"
DATA_DIR=""
BACKUP_DIR=""
MODE="auto"
SKIP_BACKUP=0
SKIP_REINDEX=0
DRY_RUN=0
COMPOSE_DIR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

msg() { echo -e "\e[34m[migrate]\e[0m $*"; }
ok()  { echo -e "\e[32m[ ok ]\e[0m $*"; }
warn(){ echo -e "\e[33m[warn]\e[0m $*"; }
err() { echo -e "\e[31m[err ]\e[0m $*"; exit 1; }

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode) MODE="${2:?}"; shift 2 ;;
      --oa-dir) OA_DIR="${2:?}"; shift 2 ;;
      --compose-dir) COMPOSE_DIR="${2:?}"; shift 2 ;;
      --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
      --backup-dir) BACKUP_DIR="${2:?}"; shift 2 ;;
      --fork-repo) FORK_REPO="${2:?}"; shift 2 ;;
      --fork-branch) FORK_BRANCH="${2:?}"; shift 2 ;;
      --skip-backup) SKIP_BACKUP=1; shift ;;
      --skip-reindex) SKIP_REINDEX=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage ;;
      *) err "Unknown option: $1" ;;
    esac
  done
}

detect_mode() {
  [[ "$MODE" != "auto" ]] && return 0
  if [[ -n "$COMPOSE_DIR" && -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
    MODE="docker"
  elif [[ -f "${OA_DIR}/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    MODE="docker"
    COMPOSE_DIR="$OA_DIR"
  elif systemctl is-active --quiet openarchiver 2>/dev/null || [[ -d "${OA_DIR}/.git" ]]; then
    MODE="bare-metal"
  elif [[ -f "${REPO_ROOT}/package.json" ]]; then
    MODE="git"
    OA_DIR="$REPO_ROOT"
  else
    err "Could not detect install mode. Pass --mode docker|bare-metal|git"
  fi
  msg "Detected mode: ${MODE}"
}

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

resolve_data_dir() {
  if [[ -n "$DATA_DIR" ]]; then
    return 0
  fi
  local env_file=""
  case "$MODE" in
    docker) env_file="${COMPOSE_DIR}/.env" ;;
    *) env_file="${OA_DIR}/.env" ;;
  esac
  load_env_file "$env_file"
  DATA_DIR="${OA_DATA:-${STORAGE_LOCAL_ROOT_PATH:-/opt/openarchiver-data}}"
}

backup_all() {
  [[ "$SKIP_BACKUP" -eq 1 ]] && { warn "Skipping backup (--skip-backup)"; return 0; }

  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="${BACKUP_DIR:-./openarchiver-migration-backup-${ts}}"
  mkdir -p "$BACKUP_DIR"
  msg "Backup directory: $BACKUP_DIR"

  case "$MODE" in
    docker)
      load_env_file "${COMPOSE_DIR}/.env"
      cp -a "${COMPOSE_DIR}/.env" "${BACKUP_DIR}/.env" 2>/dev/null || true
      cp -a "${COMPOSE_DIR}/docker-compose.yml" "${BACKUP_DIR}/" 2>/dev/null || true

      msg "PostgreSQL dump..."
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T postgres \
        pg_dump -U "${POSTGRES_USER:-admin}" "${POSTGRES_DB:-open_archive}" \
        >"${BACKUP_DIR}/postgres.sql"

      msg "Archiving email storage (${DATA_DIR})..."
      if [[ -d "$DATA_DIR" ]]; then
        run tar -czf "${BACKUP_DIR}/storage.tar.gz" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
      fi
      ;;
    bare-metal|git)
      cp -a "${OA_DIR}/.env" "${BACKUP_DIR}/.env" 2>/dev/null || true
      msg "PostgreSQL dump..."
      load_env_file "${OA_DIR}/.env"
      if command -v pg_dump >/dev/null 2>&1; then
        run pg_dump "$DATABASE_URL" >"${BACKUP_DIR}/postgres.sql" 2>/dev/null || \
          run sudo -u postgres pg_dump "${POSTGRES_DB}" >"${BACKUP_DIR}/postgres.sql"
      else
        warn "pg_dump not found — back up PostgreSQL manually"
      fi
      if [[ -d "$DATA_DIR" ]]; then
        msg "Archiving email storage..."
        run tar -czf "${BACKUP_DIR}/storage.tar.gz" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
      fi
      ;;
  esac

  ok "Backup complete: $BACKUP_DIR"
}

stop_services() {
  case "$MODE" in
    docker)
      msg "Stopping Docker stack..."
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" stop open-archiver || true
      ;;
    bare-metal)
      msg "Stopping openarchiver.service..."
      run systemctl stop openarchiver || true
      ;;
    git)
      msg "Git mode — stop local dev processes manually if running"
      ;;
  esac
}

start_services() {
  case "$MODE" in
    docker)
      msg "Starting Docker stack (fork image)..."
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" -f "${COMPOSE_DIR}/docker-compose.fork.yml" up -d
      ;;
    bare-metal)
      msg "Starting openarchiver.service..."
      run systemctl start openarchiver
      ;;
    git)
      msg "Git mode — start with: pnpm docker-start:oss"
      ;;
  esac
}

update_source_docker() {
  msg "Fetching fork source and building Docker image..."
  local build_dir="${COMPOSE_DIR}/.fork-build"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] git clone $FORK_REPO -> $build_dir && docker build"
    return 0
  fi

  rm -rf "$build_dir"
  git clone --depth 1 --branch "$FORK_BRANCH" "$FORK_REPO" "$build_dir"
  cp -a "${REPO_ROOT}/docker-compose.fork.yml" "${COMPOSE_DIR}/docker-compose.fork.yml" 2>/dev/null || \
    cp -a "${build_dir}/docker-compose.fork.yml" "${COMPOSE_DIR}/docker-compose.fork.yml"

  docker build -t open-archiver-fork:local -f "${build_dir}/apps/open-archiver/Dockerfile" "$build_dir"
  bash "${build_dir}/scripts/migrate/merge-env.sh" "${COMPOSE_DIR}/.env" "${build_dir}/.env.example"
  ok "Docker image built: open-archiver-fork:local"
}

update_source_bare_metal() {
  msg "Updating source at ${OA_DIR} to fork..."
  if [[ ! -d "${OA_DIR}/.git" ]]; then
    err "No git repo at ${OA_DIR}. Clone the fork first or use --mode docker."
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] git -C $OA_DIR remote set-url origin $FORK_REPO && git fetch && reset --hard"
    return 0
  fi

  cp -a "${OA_DIR}/.env" "/tmp/openarchiver.env.migrate.$$"
  git -C "$OA_DIR" remote set-url origin "$FORK_REPO"
  git -C "$OA_DIR" fetch origin "$FORK_BRANCH"
  git -C "$OA_DIR" reset --hard "origin/${FORK_BRANCH}"
  cp -a "/tmp/openarchiver.env.migrate.$$" "${OA_DIR}/.env"
  rm -f "/tmp/openarchiver.env.migrate.$$"

  bash "${OA_DIR}/scripts/migrate/merge-env.sh" "${OA_DIR}/.env"
  ok "Source updated to fork @ ${FORK_BRANCH}"
}

build_and_migrate_db() {
  case "$MODE" in
    docker)
      msg "Migrations run on container start (docker-entrypoint.sh)"
      ;;
    bare-metal|git)
      msg "Installing dependencies and running migrations..."
      run bash -c "cd '${OA_DIR}' && pnpm install --shamefully-hoist --frozen-lockfile --prod=false"
      run bash -c "cd '${OA_DIR}' && pnpm run build:oss"
      run bash -c "cd '${OA_DIR}' && pnpm --filter @open-archiver/backend db:migrate"
      ;;
  esac
}

queue_reindex() {
  [[ "$SKIP_REINDEX" -eq 1 ]] && { warn "Skipping reindex (--skip-reindex)"; return 0; }

  msg "Queueing full search re-index (tags + hasAttachments fields)..."
  case "$MODE" in
    docker)
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" -f "${COMPOSE_DIR}/docker-compose.fork.yml" \
        exec -T open-archiver node /app/scripts/migrate/reindex-all-emails.mjs || {
        warn "Reindex via container failed — run manually after stack is healthy:"
        warn "  docker compose exec open-archiver node /app/scripts/migrate/reindex-all-emails.mjs"
      }
      ;;
    bare-metal|git)
      if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[dry-run] node --env-file=${OA_DIR}/.env scripts/migrate/reindex-all-emails.mjs"
      else
        (cd "${OA_DIR}" && node --env-file=.env scripts/migrate/reindex-all-emails.mjs)
      fi
      ;;
  esac
  ok "Re-index jobs queued — monitor progress in Admin → Jobs or ingestion diagnostics"
}

print_summary() {
  cat <<EOF

================================================================================
Migration to OpenArchiver_fork complete
================================================================================
Mode:        ${MODE}
App dir:     ${OA_DIR:-$COMPOSE_DIR}
Data dir:    ${DATA_DIR}
Backup:      ${BACKUP_DIR:-skipped}

Preserved:
  - PostgreSQL (ingestion sources, archived emails, users, roles, audit logs)
  - Email files on disk (${DATA_DIR})
  - Meilisearch volume (search re-index queued for new fields)
  - .env secrets (JWT, encryption key, DB passwords)

New in fork:
  - Fast PST ingest, resource profiles, advanced search, dedup index (#394)
  - Security hardening (path validation, IAM-scoped diagnostics)

Next steps:
  1. Open the UI and verify ingestion sources + archived emails
  2. Wait for indexing jobs to finish (search tags/filters need this)
  3. Set OA_DATA=${DATA_DIR} in .env for Local Path PST imports
  4. Keep backup at ${BACKUP_DIR:-n/a} until verified

Docs: ${OA_DIR:-$COMPOSE_DIR}/scripts/migrate/README.md
================================================================================
EOF
}

main() {
  parse_args "$@"
  detect_mode
  resolve_data_dir

  msg "Migrating to ${FORK_REPO} (${FORK_BRANCH})"
  backup_all
  stop_services

  case "$MODE" in
    docker)
      COMPOSE_DIR="${COMPOSE_DIR:-$OA_DIR}"
      update_source_docker
      ;;
    bare-metal)
      update_source_bare_metal
      build_and_migrate_db
      ;;
    git)
      OA_DIR="${OA_DIR:-$REPO_ROOT}"
      update_source_bare_metal
      build_and_migrate_db
      ;;
  esac

  start_services
  sleep 5
  queue_reindex
  print_summary
}

main "$@"
