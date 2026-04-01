#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="agent-im"
PORT="${PORT:-3300}"

if command -v pm2 &>/dev/null; then
  PM2="pm2"
elif [ -f "./node_modules/.bin/pm2" ]; then
  PM2="./node_modules/.bin/pm2"
else
  echo "PM2 not found. Trying fallback (port kill)..."
  if PID=$(lsof -ti:"$PORT" 2>/dev/null); then
    echo "Stopping process on port $PORT (PID: $PID)..."
    echo "$PID" | xargs kill 2>/dev/null || true
    sleep 2
    lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
    echo "✓ Stopped"
  else
    echo "No process on port $PORT"
  fi
  exit 0
fi

if $PM2 describe "$APP_NAME" &>/dev/null; then
  echo "Stopping $APP_NAME (PM2)..."
  $PM2 stop "$APP_NAME"
  echo "✓ Service stopped"
else
  echo "PM2 app '$APP_NAME' not found. Service not running?"
fi
