#!/usr/bin/env bash
set -euo pipefail
#
# 安装「登录后」自启动：执行 start-bg-and-bridge-mndzhev9-b35729a5（build + PM2 + 健康检查 + 启动桥接）
# 适用：macOS LaunchAgent（用户登录后运行，非 root 开机无登录场景）
#
# 用法：在仓库根目录执行
#   bash scripts/install-macos-launchagent-start-bg-and-bridge.sh
#
# 卸载：bash scripts/uninstall-macos-launchagent-start-bg-and-bridge.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.agent-im.start-bg-and-bridge"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
WRAPPER="${REPO_ROOT}/scripts/start-bg-and-bridge-mndzhev9-launchd-wrapper.sh"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi

# macOS TCC：后台任务（LaunchAgent）默认不能访问「桌面 / 文稿 / 下载」等受保护目录，
# 会出现 getcwd / Operation not permitted。请把仓库移到非保护路径后再安装。
is_tcc_protected_repo_path() {
  local r
  r="$(cd "$REPO_ROOT" && pwd -P 2>/dev/null)" || return 1
  case "$r" in
    "$HOME/Desktop"/* | "$HOME/Documents"/* | "$HOME/Downloads"/*)
      return 0
      ;;
    "$HOME/Library/Mobile Documents"/*)
      return 0
      ;;
  esac
  return 1
}

if is_tcc_protected_repo_path; then
  echo "" >&2
  echo "错误：当前仓库在 macOS 受 TCC 保护的路径下：" >&2
  echo "  $REPO_ROOT" >&2
  echo "" >&2
  echo "LaunchAgent 在后台无法可靠访问「桌面 / 文稿 / 下载 / iCloud 文稿」下的目录，" >&2
  echo "会导致：getcwd: Operation not permitted、无法执行脚本。" >&2
  echo "" >&2
  echo "请把 agent-im 移到例如 ~/Developer/agent-im、~/src/agent-im 或 /opt/agent-im，" >&2
  echo "在新路径下重新执行本安装脚本。" >&2
  echo "" >&2
  echo "（高级用法：若已为 /bin/bash 开启「完全磁盘访问权限」，可设置" >&2
  echo "  CTI_ALLOW_LAUNCHAGENT_FROM_DESKTOP=1 后重试安装，不推荐。）" >&2
  echo "" >&2
  if [ "${CTI_ALLOW_LAUNCHAGENT_FROM_DESKTOP:-}" = "1" ]; then
    echo "已设置 CTI_ALLOW_LAUNCHAGENT_FROM_DESKTOP=1，继续安装…" >&2
  else
    exit 1
  fi
fi

if [ ! -x "$WRAPPER" ]; then
  chmod +x "$WRAPPER"
fi

mkdir -p "${REPO_ROOT}/logs"

cat >"$PLIST_DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WRAPPER}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${REPO_ROOT}/logs/launchd-agent-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${REPO_ROOT}/logs/launchd-agent-stderr.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "Installed LaunchAgent: $PLIST_DEST"
echo "Label: $LABEL"
echo "Logs: ${REPO_ROOT}/logs/launchd-start-bg-and-bridge.log (wrapper)"
echo "      ${REPO_ROOT}/logs/launchd-agent-stdout.log / stderr (launchd)"
echo ""
echo "Test now: launchctl kickstart -k gui/$(id -u)/${LABEL}"
echo "Unload:   bash scripts/uninstall-macos-launchagent-start-bg-and-bridge.sh"
