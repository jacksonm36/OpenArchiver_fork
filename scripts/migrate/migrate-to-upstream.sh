#!/usr/bin/env bash
# Roll back from jacksonm36/OpenArchiver_fork to LogicLabs-OU/OpenArchiver (upstream main)
# while preserving database, email storage, Meilisearch, secrets, and ingestion sources.
#
# Usage:
#   sudo bash scripts/migrate/migrate-to-upstream.sh --mode bare-metal
#   sudo bash scripts/migrate/migrate-to-upstream.sh --mode docker --compose-dir /opt/openarchiver
#
# Options: same as migrate-to-fork.sh (see --help)

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/LogicLabs-OU/OpenArchiver.git}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
UPSTREAM_IMAGE="${UPSTREAM_IMAGE:-logiclabshq/open-archiver:latest}"
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

# shellcheck source=backup-critical.sh
source "${SCRIPT_DIR}/backup-critical.sh"

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
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  echo ""
  echo "Options:"
  echo "  --mode bare-metal|docker|git"
  echo "  --oa-dir PATH"
  echo "  --compose-dir PATH"
  echo "  --data-dir PATH"
  echo "  --backup-dir PATH"
  echo "  --upstream-ref REF          Git ref (default: main)"
  echo "  --upstream-image IMAGE      Docker image (default: logiclabshq/open-archiver:latest)"
  echo "  --skip-backup               Not recommended"
  echo "  --skip-reindex"
  echo "  --dry-run"
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
      --upstream-ref) UPSTREAM_REF="${2:?}"; shift 2 ;;
      --upstream-image) UPSTREAM_IMAGE="${2:?}"; shift 2 ;;
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

run_backup() {
  [[ "$SKIP_BACKUP" -eq 1 ]] && { warn "Skipping backup (--skip-backup)"; return 0; }

  BC_MODE="$MODE"
  BC_OA_DIR="$OA_DIR"
  BC_COMPOSE_DIR="${COMPOSE_DIR:-}"
  BC_DATA_DIR="$DATA_DIR"
  BC_BACKUP_DIR="$BACKUP_DIR"
  BC_DRY_RUN="$DRY_RUN"
  backup_critical
  BACKUP_DIR="${BACKUP_DIR:-$BC_BACKUP_DIR}"
}

stop_services() {
  case "$MODE" in
    docker)
      msg "Stopping Docker stack..."
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" -f "${COMPOSE_DIR}/docker-compose.fork.yml" stop open-archiver 2>/dev/null || \
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

start_services_upstream() {
  case "$MODE" in
    docker)
      msg "Starting Docker stack (upstream image: ${UPSTREAM_IMAGE})..."
      if [[ "$DRY_RUN" -eq 0 && -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
        if grep -q 'image:.*open-archiver-fork' "${COMPOSE_DIR}/docker-compose.fork.yml" 2>/dev/null; then
          warn "Remove or rename docker-compose.fork.yml to use upstream image"
        fi
      fi
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" up -d
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

update_source_docker_upstream() {
  msg "Switching to upstream Docker image ${UPSTREAM_IMAGE}..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] docker compose pull && up -d with ${UPSTREAM_IMAGE}"
    return 0
  fi

  if [[ -f "${COMPOSE_DIR}/docker-compose.fork.yml" ]]; then
    run mv "${COMPOSE_DIR}/docker-compose.fork.yml" "${COMPOSE_DIR}/docker-compose.fork.yml.disabled"
    warn "Disabled docker-compose.fork.yml (renamed to .disabled)"
  fi

  run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" pull open-archiver || true
  ok "Upstream image ready — stack will use ${UPSTREAM_IMAGE} from compose file"
}

update_source_bare_metal_upstream() {
  msg "Updating source at ${OA_DIR} to upstream ${UPSTREAM_REF}..."
  if [[ ! -d "${OA_DIR}/.git" ]]; then
    err "No git repo at ${OA_DIR}"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] git -C $OA_DIR remote set-url origin $UPSTREAM_REPO && fetch && checkout $UPSTREAM_REF"
    return 0
  fi

  cp -a "${OA_DIR}/.env" "/tmp/openarchiver.env.migrate.$$"
  git -C "$OA_DIR" remote set-url origin "$UPSTREAM_REPO"
  git -C "$OA_DIR" fetch origin "$UPSTREAM_REF"
  git -C "$OA_DIR" checkout "origin/${UPSTREAM_REF}" -B upstream-main
  cp -a "/tmp/openarchiver.env.migrate.$$" "${OA_DIR}/.env"
  rm -f "/tmp/openarchiver.env.migrate.$$"

  ok "Source updated to upstream @ ${UPSTREAM_REF}"
}

build_upstream() {
  case "$MODE" in
    docker)
      msg "Upstream does not run fork-only migrations — existing DB indexes are kept"
      ;;
    bare-metal|git)
      msg "Installing upstream dependencies..."
      run bash -c "cd '${OA_DIR}' && pnpm install --shamefully-hoist --frozen-lockfile --prod=false"
      run bash -c "cd '${OA_DIR}' && pnpm run build:oss"
      msg "Skipping db:migrate on rollback — fork migrations (0035+) remain in DB harmlessly"
      ;;
  esac
}

queue_reindex() {
  [[ "$SKIP_REINDEX" -eq 1 ]] && { warn "Skipping reindex (--skip-reindex)"; return 0; }

  msg "Optional search re-index after rollback..."
  case "$MODE" in
    docker)
      run docker compose -f "${COMPOSE_DIR}/docker-compose.yml" \
        exec -T open-archiver node /app/scripts/migrate/reindex-all-emails.mjs 2>/dev/null || \
        warn "Reindex skipped — run manually if search is stale"
      ;;
    bare-metal|git)
      if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[dry-run] node --env-file=${OA_DIR}/.env scripts/migrate/reindex-all-emails.mjs"
      else
        (cd "${OA_DIR}" && node --env-file=.env scripts/migrate/reindex-all-emails.mjs) 2>/dev/null || \
          warn "Reindex script not available on upstream — search may still work from existing index"
      fi
      ;;
  esac
}

print_summary() {
  cat <<EOF

================================================================================
Rollback to upstream OpenArchiver complete
================================================================================
Mode:        ${MODE}
App dir:     ${OA_DIR:-$COMPOSE_DIR}
Data dir:    ${DATA_DIR}
Backup:      ${BACKUP_DIR:-skipped}

Preserved (not modified):
  - PostgreSQL (including fork migration indexes 0035/0036 if applied)
  - Email files on disk
  - Meilisearch volume
  - .env secrets (JWT, ENCRYPTION_KEY, STORAGE_ENCRYPTION_KEY, DB passwords)

Next steps:
  1. Verify archived emails and ingestion sources in the UI
  2. Users may need to sign in again after auth changes
  3. Keep backup at ${BACKUP_DIR:-n/a} until verified

Full restore from backup: see ${BACKUP_DIR:-n/a}/backup-manifest.txt
================================================================================
EOF
}

main() {
  parse_args "$@"
  detect_mode
  resolve_data_dir

  msg "Rolling back to upstream ${UPSTREAM_REPO} (${UPSTREAM_REF})"
  run_backup
  stop_services

  case "$MODE" in
    docker)
      COMPOSE_DIR="${COMPOSE_DIR:-$OA_DIR}"
      update_source_docker_upstream
      ;;
    bare-metal)
      update_source_bare_metal_upstream
      build_upstream
      ;;
    git)
      OA_DIR="${OA_DIR:-$REPO_ROOT}"
      update_source_bare_metal_upstream
      build_upstream
      ;;
  esac

  start_services_upstream
  sleep 5
  queue_reindex
  print_summary
}

main "$@"
