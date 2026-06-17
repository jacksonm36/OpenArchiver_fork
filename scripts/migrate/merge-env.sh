#!/usr/bin/env bash
# Append missing keys from .env.example into an existing .env (never overwrites values).
set -euo pipefail

TARGET_ENV="${1:?Usage: merge-env.sh <target-.env> [example-.env>]}"
EXAMPLE_ENV="${2:-$(dirname "$0")/../../.env.example}"

if [[ ! -f "$TARGET_ENV" ]]; then
  echo "Target .env not found: $TARGET_ENV" >&2
  exit 1
fi

if [[ ! -f "$EXAMPLE_ENV" ]]; then
  echo "Example .env not found: $EXAMPLE_ENV" >&2
  exit 1
fi

added=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" != *"="* ]] && continue

  key="${line%%=*}"
  key="$(echo "$key" | xargs)"
  [[ -z "$key" ]] && continue

  if ! grep -q "^${key}=" "$TARGET_ENV" && ! grep -q "^# ${key}=" "$TARGET_ENV"; then
    echo "$line" >>"$TARGET_ENV"
    added=$((added + 1))
  fi
done <"$EXAMPLE_ENV"

# Fork-specific defaults when still missing after example merge.
declare -A FORK_DEFAULTS=(
  [RESOURCE_PROFILE]="auto"
  [BODY_SIZE_LIMIT]="Infinity"
  [OA_DATA]="${OA_DATA:-/opt/openarchiver-data}"
)

for key in "${!FORK_DEFAULTS[@]}"; do
  if ! grep -q "^${key}=" "$TARGET_ENV"; then
    echo "${key}=${FORK_DEFAULTS[$key]}" >>"$TARGET_ENV"
    added=$((added + 1))
  fi
done

echo "merge-env: added ${added} key(s) to ${TARGET_ENV}"
