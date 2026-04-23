#!/usr/bin/env bash
#
# Quick deploy — mirror backend/frontend to live paths + restart Passenger.
# No worktree, no release dirs. For routine deploys after git merge to main.
#
# Works on shared cPanel hosting that lacks rsync — falls back to tar-pipe
# with the same --exclude semantics.
#
#   bash scripts/deploy-quick.sh            # deploy both
#   bash scripts/deploy-quick.sh --backend  # backend only
#   bash scripts/deploy-quick.sh --frontend # frontend only
#   bash scripts/deploy-quick.sh --dry-run  # show what would copy
#
set -euo pipefail

# Resolve to repo root regardless of where the script was invoked from
# (e.g. `npm --prefix backend run deploy` sets cwd=backend/).
SCRIPT_DIR="$( cd "$(dirname "${BASH_SOURCE[0]}")" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$REPO_ROOT"

PASSENGER_APP="${PASSENGER_APP:-$HOME/chmup_backend}"
PUBLIC_HTML="${PUBLIC_HTML:-$HOME/public_html}"
HEALTH_URL="${HEALTH_URL:-https://chmup.top/api/health}"

DO_BACKEND=1
DO_FRONTEND=1
DRY=0

for arg in "$@"; do
  case "$arg" in
    --backend)  DO_FRONTEND=0 ;;
    --frontend) DO_BACKEND=0 ;;
    --dry-run)  DRY=1 ;;
    -h|--help)  sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d backend ] && [ -d frontend ] || die "repo root missing backend/ or frontend/ (cwd=$PWD)"

HAVE_RSYNC=0
if command -v rsync >/dev/null 2>&1; then HAVE_RSYNC=1; fi
command -v tar >/dev/null || die "need rsync or tar — neither found"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
log "branch=$BRANCH sha=$SHA target=$PASSENGER_APP + $PUBLIC_HTML"
[ $HAVE_RSYNC = 0 ] && log "rsync missing — using tar-pipe fallback"

# Mirror SRC → DST with excludes. Uses rsync when available (supports
# --delete), else tar-pipe (does not delete stale files, only adds/updates).
mirror() {
  local src="$1" dst="$2"; shift 2
  local excludes=("$@")
  mkdir -p "$dst"
  if [ $HAVE_RSYNC = 1 ]; then
    local args=(-a)
    [ $DRY = 1 ] && args+=(--dry-run --itemize-changes)
    for e in "${excludes[@]}"; do args+=(--exclude "$e"); done
    rsync "${args[@]}" "$src/" "$dst/"
  else
    if [ $DRY = 1 ]; then
      echo "  [dry-run] would tar-pipe $src/ → $dst/ excluding: ${excludes[*]}"
      return 0
    fi
    local tar_args=(-cf -)
    for e in "${excludes[@]}"; do tar_args+=(--exclude="$e"); done
    tar "${tar_args[@]}" -C "$src" . | tar -xf - -C "$dst"
  fi
}

if [ "$DO_BACKEND" = 1 ]; then
  log "backend → $PASSENGER_APP"
  mirror backend "$PASSENGER_APP" \
    .env data logs node_modules tmp .git
fi

if [ "$DO_FRONTEND" = 1 ]; then
  log "frontend → $PUBLIC_HTML"
  mirror frontend "$PUBLIC_HTML" \
    node_modules tailwind.src.css package.json package-lock.json tailwind.config.js .DS_Store
fi

if [ $DRY = 1 ]; then
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
