#!/usr/bin/env bash
set -euo pipefail
# 移除 install-macos-launchagent-start-bg-and-bridge.sh 安装的 LaunchAgent

LABEL="com.agent-im.start-bg-and-bridge"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST_DEST"
echo "Removed LaunchAgent ${LABEL} (if it was loaded)."
