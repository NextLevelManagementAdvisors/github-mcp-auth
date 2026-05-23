#!/usr/bin/env bash
set -euo pipefail

# One-time bootstrap on the VPS. Idempotent.
#
# Pre-reqs (must already be done on the VPS, see README.md "Deployment" section):
#   - github-mcp-server container running at 127.0.0.1:3060
#   - Postgres reachable; database "github_mcp" + user with full privileges exist
#   - DNS for github.nlma.io points at this VPS
#   - Let's Encrypt cert for github.nlma.io issued (/etc/letsencrypt/live/github.nlma.io/)
#   - /opt/github-mcp-auth/.env populated from .env.example
#
# Run as root on the VPS, from /opt/github-mcp-auth (after the first
# push-to-vps.sh upload — or copy this file across separately).

REPO=/opt/github-mcp-auth
SERVICE=github-mcp-auth

if [[ "$EUID" -ne 0 ]]; then
  echo "must be run as root on the VPS" >&2
  exit 1
fi
if [[ ! -d "$REPO" ]]; then
  echo "$REPO does not exist — push the working tree first" >&2
  exit 1
fi

echo "→ Installing systemd unit"
cp "$REPO/systemd/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE.service"

echo "→ Installing nginx rate-limit zone (if missing)"
cp -n "$REPO/nginx/limit-req-github.conf" /etc/nginx/conf.d/limit-req-github.conf || true

echo "→ Swapping nginx vhost to point at the gateway"
cp "$REPO/nginx/github.nlma.io.conf" /etc/nginx/sites-enabled/github.nlma.io
nginx -t
systemctl reload nginx

echo "→ Building & starting the service"
cd "$REPO"
npm ci
npm run build
systemctl restart "$SERVICE"
sleep 1
systemctl is-active "$SERVICE"

echo
echo "Health check:"
curl -fsS https://github.nlma.io/health && echo
echo
echo "Done. claude.ai connector URL: https://github.nlma.io/mcp"
