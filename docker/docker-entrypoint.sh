#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e

# Cap Node.js heap when NODE_MAX_OLD_SPACE_MB is set (recommended for low-RAM hosts).
# When unset and RESOURCE_PROFILE=auto, detect from cgroup/host RAM limits.
if [ -z "$NODE_MAX_OLD_SPACE_MB" ]; then
	if [ "${RESOURCE_PROFILE:-auto}" = "auto" ] && [ -f /app/scripts/detect-resources.mjs ]; then
		DETECTED_HEAP=$(node /app/scripts/detect-resources.mjs heap-mb 2>/dev/null || true)
		if [ -n "$DETECTED_HEAP" ]; then
			export NODE_MAX_OLD_SPACE_MB="$DETECTED_HEAP"
		fi
	fi
fi

if [ -n "$NODE_MAX_OLD_SPACE_MB" ]; then
	case "$NODE_OPTIONS" in
		*max-old-space-size*) ;;
		*) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}" ;;
	esac
fi

# Run pnpm install to ensure all dependencies, including native addons,
# are built for the container's architecture. This is crucial for
# multi-platform Docker images, as it prevents "exec format error"
# when running on a different architecture than the one used for building.
pnpm install --frozen-lockfile --prod

# Run database migrations before starting the application to prevent
# race conditions where the app starts before the database is ready.
pnpm db:migrate

# Execute the main container command
exec "$@"
