#!/usr/bin/env bash
set -euo pipefail

# Push the current working tree to /opt/github-mcp-auth on the VPS,
# install deps, rebuild, and restart the systemd unit.
#
# Usage:  scripts/push-to-vps.sh
#
# Assumes:
#   - ssh root@YOUR_SERVER_IP works without a password prompt
#   - /opt/github-mcp-auth/.env already exists on the VPS (not overwritten)
#   - github-mcp-auth.service is installed (see scripts/install-on-vps.sh)
#   - Postgres database `github_mcp` exists and DATABASE_URL in .env points at it

HOST=root@YOUR_SERVER_IP
REMOTE=/opt/github-mcp-auth
SERVICE=github-mcp-auth

cd "$(dirname "$0")/.."

echo "→ Uploading working tree to $HOST:$REMOTE"
ssh "$HOST" "mkdir -p $REMOTE"
tar --exclude=node_modules --exclude=dist --exclude=.env --exclude=.git -czf - . \
  | ssh "$HOST" "cd $REMOTE && tar -xzf -"

echo "→ Installing deps and building on VPS"
ssh "$HOST" "cd $REMOTE && npm ci && npm run build"

echo "→ Restarting $SERVICE"
ssh "$HOST" "systemctl restart $SERVICE && sleep 1 && systemctl is-active $SERVICE"

echo "→ Health check"
curl -fsS https://github.nlma.io/health && echo
