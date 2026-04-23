#!/usr/bin/env bash
#
# Build the mobile/www directory from frontend/.
#
# In "remote" mode (default) Capacitor points the WebView at chmup.top
# and www/ only serves as a bootstrap — just the splash page. No copy.
# In "bundle" mode we mirror the entire frontend/ so the app can run
# offline against a cached shell.
#
# Usage:
#   bash scripts/mobile-build-www.sh            # remote mode (no-op)
#   CHM_MOBILE_MODE=bundle bash scripts/mobile-build-www.sh
set -euo pipefail

SCRIPT_DIR="$( cd "$(dirname "${BASH_SOURCE[0]}")" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$REPO_ROOT"

MODE="${CHM_MOBILE_MODE:-remote}"
WWW="mobile/www"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if [ "$MODE" = "remote" ]; then
  log "remote mode — www/ stays minimal (bootstrap splash)"
  log "WebView will load https://chmup.top directly via capacitor.config.ts server.url"
  exit 0
fi

log "bundle mode — mirroring frontend/ → $WWW/"
mkdir -p "$WWW"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules/' --exclude 'tailwind.src.css' \
    --exclude 'package*.json' --exclude 'tailwind.config.js' \
    --exclude '.DS_Store' \
    frontend/ "$WWW/"
else
  # tar-pipe fallback (shared-hosting environments without rsync)
  rm -rf "$WWW"; mkdir -p "$WWW"
  tar -cf - --exclude=node_modules --exclude=tailwind.src.css \
      --exclude=package.json --exclude=package-lock.json \
      --exclude=tailwind.config.js --exclude=.DS_Store \
      -C frontend . | tar -xf - -C "$WWW"
fi

log "bundle complete — www/ has $(find "$WWW" -type f | wc -l | tr -d ' ') files"
