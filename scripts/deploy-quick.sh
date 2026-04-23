#!/usr/bin/env bash
#
# Quick deploy — rsync backend/frontend to live paths + restart Passenger.
# No worktree, no release dirs. For routine deploys after git merge to main.
#
# Run from ~/WEBSIte on the cPanel server, on the branch you want live:
#   bash scripts/deploy-quick.sh           # deploy current tree
#   bash scripts/deploy-quick.sh --backend # backend only (skip frontend)
#   bash scripts/deploy-quick.sh --frontend
#   bash scripts/deploy-quick.sh --dry-run # print what would copy
#
# Safer than per-file `cp -v` because:
#  - rsync --exclude keeps .env/data/ on the server untouched
#  - mirrors directory structure → no flat-copy bug
#  - single restart at the end (not per-file)
#  - health check on /api/health after restart
#
set -euo pipefail

PASSENGER_APP="${PASSENGER_APP:-$HOME/chmup_backend}"
PUBLIC_HTML="${PUBLIC_HTML:-$HOME/public_html}"
HEALTH_URL="${HEALTH_URL:-https://chmup.top/api/health}"

DO_BACKEND=1
DO_FRONTEND=1
DRY=""

for arg in "$@"; do
  case "$arg" in
    --backend)  DO_FRONTEND=0 ;;
    --frontend) DO_BACKEND=0 ;;
    --dry-run)  DRY="--dry-run" ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d backend ] && [ -d frontend ] || die "run from repo root (expects backend/ and frontend/)"
command -v rsync >/dev/null || die "rsync missing"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse --short HEAD)"
log "branch=$BRANCH sha=$SHA target=$PASSENGER_APP + $PUBLIC_HTML"

if [ "$DO_BACKEND" = 1 ]; then
  log "backend → $PASSENGER_APP"
  rsync -a $DRY \
    --exclude '.env' \
    --exclude 'data/' \
    --exclude 'logs/' \
    --exclude 'node_modules/' \
    --exclude 'tmp/' \
    --exclude '.git/' \
    backend/ "$PASSENGER_APP/"
fi

if [ "$DO_FRONTEND" = 1 ]; then
  log "frontend → $PUBLIC_HTML"
  rsync -a $DRY \
    --exclude 'node_modules/' \
    --exclude 'tailwind.src.css' \
    --exclude 'package*.json' \
    --exclude 'tailwind.config.js' \
    --exclude '.DS_Store' \
    frontend/ "$PUBLIC_HTML/"
fi

if [ -n "$DRY" ]; then
  log "dry-run complete — no changes applied"
  exit 0
fi

if [ "$DO_BACKEND" = 1 ]; then
  log "restarting Passenger"
  mkdir -p "$PASSENGER_APP/tmp"
  touch "$PASSENGER_APP/tmp/restart.txt"

  log "waiting for $HEALTH_URL (max 30s)"
  for i in $(seq 1 15); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      log "health OK (attempt $i)"
      break
    fi
    [ "$i" = 15 ] && die "health check failed — check logs in $PASSENGER_APP/logs/"
    sleep 2
  done
fi

log "deploy ok — $BRANCH@$SHA is live"
