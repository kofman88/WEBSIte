#!/usr/bin/env bash
# SQLite online backup using the VACUUM INTO command — safe to run while the
# backend is live (doesn't block writers beyond a brief snapshot window).
#
# Usage:
#   bash scripts/backup-db.sh                          # local dev
#   BACKUP_DIR=~/backups bash scripts/backup-db.sh     # custom dest
#
# Retention:
#   Keeps the 14 most recent backups and deletes older ones. Override with
#   RETAIN_N=30 bash scripts/backup-db.sh
#
# Cron suggestion (hourly on the box running the backend):
#   0 * * * * cd ~/chmup_backend && bash /home/chmtop/WEBSIte/scripts/backup-db.sh >> ~/backup.log 2>&1
set -euo pipefail

DB_PATH="${DB_PATH:-$HOME/chmup_backend/data/chmup.db}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/chmup}"
RETAIN_N="${RETAIN_N:-14}"

if [ ! -f "$DB_PATH" ]; then
  echo "ERR: db not found at $DB_PATH" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/chmup-$TS.db"

# VACUUM INTO produces a clean, defragmented copy. Much safer than `cp`
# since SQLite's WAL file can be mid-commit when cp reads. Takes a brief
# shared lock at the end to finalise.
sqlite3 "$DB_PATH" "VACUUM INTO '$OUT'"
gzip -9 "$OUT"
echo "OK: backup written $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Retention — keep N newest, delete older. ls -1t sorts by mtime desc.
cd "$BACKUP_DIR"
ls -1t chmup-*.db.gz 2>/dev/null | tail -n +$((RETAIN_N + 1)) | while read -r old; do
  rm -f -- "$old"
  echo "prune: $old"
done
