#!/usr/bin/env bash
# 供 LaunchAgent 调用：launchd 默认没有交互 shell 的 PATH/nvm，必须显式补齐
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export HOME="${HOME:-$(eval echo "~$USER")}"

# 与终端里尽量一致的路径（Homebrew / 常见工具 / nvm）
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin:${PATH:-}"

# nvm（若使用）
if [ -s "${HOME}/.nvm/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "${HOME}/.nvm/nvm.sh"
fi
# fnm（若使用）
if command -v fnm &>/dev/null; then
  eval "$(fnm env 2>/dev/null)" || true
fi

mkdir -p "$REPO_ROOT/logs"
LOG="$REPO_ROOT/logs/launchd-start-bg-and-bridge.log"
exec >>"$LOG" 2>&1

echo "======== $(date "+%Y-%m-%dT%H:%M:%S%z") ========"
echo "REPO_ROOT=$REPO_ROOT"
echo "HOME=$HOME"
echo "PATH=$PATH"
command -v node &>/dev/null && echo "node=$(command -v node) $(node -v 2>/dev/null)" || echo "node: NOT FOUND"
command -v npm &>/dev/null && echo "npm=$(command -v npm) $(npm -v 2>/dev/null)" || echo "npm: NOT FOUND"
command -v pm2 &>/dev/null && echo "pm2=$(command -v pm2)" || echo "pm2: NOT FOUND (will use node_modules/.bin if present)"

unset CTI_HOME
export CTI_HOME=

exec "$REPO_ROOT/scripts/start-bg-and-bridge-mndzhev9-b35729a5.sh"
