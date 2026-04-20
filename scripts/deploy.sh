#!/usr/bin/env bash
#
# Atomic symlink-based deploy for cPanel + Passenger.
#
# Deploys the latest git tip of the current branch to ~/releases/<sha>/
# then flips the ~/current symlink + restarts Passenger. Previous
# releases are kept for instant rollback.
#
# Usage (run from ~/WEBSIte clone on the server):
#   bash scripts/deploy.sh               # deploy current HEAD
#   bash scripts/deploy.sh --dry-run     # print plan without running
#   bash scripts/deploy.sh --rollback    # switch to previous release
#
# Environment assumed:
#   APP_ROOT         default $HOME
#   PASSENGER_APP    default $HOME/chmup_backend
#   PUBLIC_HTML      default $HOME/public_html
#   KEEP_RELEASES    default 5
#
set -euo pipefail

APP_ROOT="${APP_ROOT:-$HOME}"
PASSENGER_APP="${PASSENGER_APP:-$HOME/chmup_backend}"
PUBLIC_HTML="${PUBLIC_HTML:-$HOME/public_html}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
SHA="$(git rev-parse --short HEAD)"
NEW_REL="$RELEASES_DIR/$(date +%Y%m%d_%H%M%S)_$SHA"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR:\033[0m %s\n' "$*" >&2; exit 1; }

cmd_rollback() {
  [ -L "$CURRENT_LINK" ] || die "no current symlink"
  local cur prev
  cur="$(readlink -f "$CURRENT_LINK")"
  prev="$(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | grep -v -- "${cur##*/}" | head -1 || true)"
  [ -n "$prev" ] || die "no previous release to roll back to"
  log "rolling back: $cur -> $prev"
  ln -sfn "$prev" "$CURRENT_LINK"
  copy_to_serving "$prev"
  restart_passenger
  log "rollback complete"
}

copy_to_serving() {
  local rel="$1"
  log "copying backend to $PASSENGER_APP"
  rsync -a --delete \
    --exclude '.env' --exclude 'data/' --exclude 'logs/' --exclude 'node_modules/' \
    "$rel/backend/" "$PASSENGER_APP/"
  # Install prod deps against the live app dir (preserves .env/data/)
  ( cd "$PASSENGER_APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

  log "copying frontend to $PUBLIC_HTML"
  rsync -a --delete \
    --exclude 'node_modules/' --exclude 'tailwind.src.css' --exclude 'package*.json' --exclude 'tailwind.config.js' \
    "$rel/frontend/" "$PUBLIC_HTML/"
}

restart_passenger() {
  mkdir -p "$PASSENGER_APP/tmp"
  touch "$PASSENGER_APP/tmp/restart.txt"
  log "wait for /api/health (max 30s)"
  for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1 \
       || curl -sf https://chmup.top/api/health >/dev/null 2>&1; then
      log "health OK on attempt $i"
      return 0
    fi
    sleep 2
  done
  die "health check failed after restart"
}

prune_releases() {
  [ -d "$RELEASES_DIR" ] || return 0
  local old
  old="$(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) || true)"
  [ -z "$old" ] && return 0
  log "pruning old releases:"
  printf '  %s\n' $old
  rm -rf $old
}

main() {
  case "${1:-}" in
    --dry-run)
      echo "would deploy $SHA -> $NEW_REL"
      echo "PASSENGER_APP=$PASSENGER_APP"
      echo "PUBLIC_HTML=$PUBLIC_HTML"
      echo "KEEP_RELEASES=$KEEP_RELEASES"
      exit 0
      ;;
    --rollback)
      cmd_rollback
      exit 0
      ;;
  esac

  [ -d "$(git rev-parse --show-toplevel)" ] || die "not in a git repo"
  command -v rsync >/dev/null || die "rsync missing"
  command -v curl  >/dev/null || die "curl missing"

  mkdir -p "$RELEASES_DIR"
  log "staging release to $NEW_REL"
  git worktree add --detach "$NEW_REL" "$SHA"

  copy_to_serving "$NEW_REL"
  ln -sfn "$NEW_REL" "$CURRENT_LINK"
  restart_passenger
  prune_releases

  log "deploy ok — $SHA is live"
}

main "$@"
