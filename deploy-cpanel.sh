#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# CHM Finance — cPanel Deployment Script
# Usage: CPANEL_HOST=chmup.top CPANEL_USER=chmtop ./deploy-cpanel.sh
# ═══════════════════════════════════════════════════════════════════

set -e

HOST="${CPANEL_HOST:?Set CPANEL_HOST}"
USER="${CPANEL_USER:?Set CPANEL_USER}"
PORT="${CPANEL_SSH_PORT:-22}"
BASE="/home/${USER}"

echo "=== CHM Finance Deploy ==="
echo "Host: ${HOST} | User: ${USER}"
echo ""

# Upload frontend
echo "[1/4] Uploading frontend..."
rsync -avz --delete \
  --exclude='.DS_Store' \
  -e "ssh -p ${PORT}" \
  ./frontend/ "${USER}@${HOST}:${BASE}/public_html/"

# Upload backend
echo "[2/4] Uploading backend..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='.git' \
  -e "ssh -p ${PORT}" \
  ./backend/ "${USER}@${HOST}:${BASE}/chmup_backend/"

# Install dependencies
echo "[3/4] Installing dependencies..."
ssh -p "${PORT}" "${USER}@${HOST}" "cd ${BASE}/chmup_backend && npm install --production"

# Restart Node.js app
echo "[4/4] Restarting application..."
ssh -p "${PORT}" "${USER}@${HOST}" "cd ${BASE}/chmup_backend && touch tmp/restart.txt 2>/dev/null || true"

echo ""
echo "=== Deploy Complete ==="
echo "Frontend: https://${HOST}/"
echo "API:      https://${HOST}/api/health"
