#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3300}"
APP_NAME="agent-im"

if ! command -v pm2 &>/dev/null; then
  if [ -f "./node_modules/.bin/pm2" ]; then
    PM2="./node_modules/.bin/pm2"
  else
    echo "PM2 not found. Install: npm install -g pm2"
    exit 1
  fi
else
  PM2="pm2"
fi

export PORT

echo "Building (daemon + Next.js)..."
npm run build

if $PM2 describe "$APP_NAME" &>/dev/null; then
  echo "Restarting existing PM2 app $APP_NAME..."
  $PM2 restart "$APP_NAME" --update-env
else
  echo "──────────────────────────────────────────"
  echo "  agent-im (Next.js + Kanban + bridge)"
  echo ""
  echo "  URL:      http://127.0.0.1:${PORT}"
  echo "  Health:   http://127.0.0.1:${PORT}/health"
  echo "  Admin:    http://127.0.0.1:${PORT}/admin"
  echo "  API 说明: docs/API.md"
  echo "──────────────────────────────────────────"
  echo ""
  $PM2 start ecosystem.config.cjs
fi

echo ""
echo "✓ agent-im is up via PM2"
echo ""
echo "Commands:"
echo "  Logs:   $PM2 logs $APP_NAME"
echo "  Stop:   ./stop-bg.sh"
echo "  Status: $PM2 status $APP_NAME"
echo ""
