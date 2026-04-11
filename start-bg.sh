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
# Admin `/admin` lists every bridge under CTI_BASE only when the server is not pinned by CTI_HOME.
unset CTI_HOME
export CTI_HOME=

# Same git resolution as ecosystem.config.cjs (no /opt/homebrew/bin/git probe — use CTI_GIT_EXECUTABLE or brew install git).
resolve_git_for_pm2() {
  if [[ -n "${CTI_GIT_EXECUTABLE:-}" ]]; then
    echo "  Git: using CTI_GIT_EXECUTABLE=${CTI_GIT_EXECUTABLE} (already set)"
    return 0
  fi
  local _c
  for _c in /usr/local/bin/git /usr/bin/git; do
    if [[ -x "${_c}" ]] && "${_c}" --version &>/dev/null; then
      export CTI_GIT_EXECUTABLE="${_c}"
      echo "  Git: CTI_GIT_EXECUTABLE=${CTI_GIT_EXECUTABLE} (start-bg probe → PM2 inherits)"
      return 0
    fi
  done
  echo "  Git: CTI_GIT_EXECUTABLE unset (ecosystem.config.cjs will probe /usr/local → /usr/bin)"
  return 0
}

echo "Building (daemon + Next.js)..."
npm run build

resolve_git_for_pm2

if $PM2 describe "$APP_NAME" &>/dev/null; then
  echo "Restarting existing PM2 app $APP_NAME (ecosystem env, CTI_HOME cleared)..."
  $PM2 restart ecosystem.config.cjs --update-env
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
