#!/usr/bin/env bash
# 诊断「开机/登录自启」LaunchAgent：是否已加载、最近日志
set -euo pipefail

LABEL="com.agent-im.start-bg-and-bridge"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== launchctl (user gui domain) ==="
if launchctl print "gui/$(id -u)/${LABEL}" &>/dev/null; then
  launchctl print "gui/$(id -u)/${LABEL}" 2>&1 | head -35
else
  echo "未加载: 在 ${PLIST} 找不到已 bootstrap 的 ${LABEL}"
  echo "若未安装，请执行: bash ${REPO_ROOT}/scripts/install-macos-launchagent-start-bg-and-bridge.sh"
fi

echo ""
echo "=== plist 文件 ==="
if [ -f "$PLIST" ]; then
  echo "$PLIST"
  cat "$PLIST"
else
  echo "不存在: $PLIST"
fi

echo ""
echo "=== TCC / 路径提示 ==="
if REPO_REAL="$(cd "$REPO_ROOT" && pwd -P 2>/dev/null)"; then
  case "$REPO_REAL" in
    "$HOME/Desktop"/* | "$HOME/Documents"/* | "$HOME/Downloads"/* | "$HOME/Library/Mobile Documents"/*)
      echo "仓库在受保护目录下: $REPO_REAL"
      echo "LaunchAgent 常见报错: getcwd / Operation not permitted"
      echo "处理: 将仓库移到 ~/Developer、~/src、/opt 等非「桌面/文稿/下载」路径后重装 LaunchAgent。"
      echo ""
      ;;
  esac
fi

echo "=== 日志（若存在，各取末尾 80 行）==="
for f in \
  "${REPO_ROOT}/logs/launchd-start-bg-and-bridge.log" \
  "${REPO_ROOT}/logs/launchd-agent-stdout.log" \
  "${REPO_ROOT}/logs/launchd-agent-stderr.log"
do
  if [ -f "$f" ]; then
    echo "--- $f ---"
    tail -80 "$f"
    if grep -q 'Operation not permitted\|getcwd' "$f" 2>/dev/null; then
      echo ""
      echo "↑ 若含 Operation not permitted / getcwd：多为仓库在「桌面/文稿/下载」下，请迁移仓库后重装 install 脚本。"
    fi
  else
    echo "--- $f --- (无此文件)"
  fi
  echo ""
done

echo "=== 手动试跑 wrapper（当前 shell 环境，非 launchd）==="
echo "bash ${REPO_ROOT}/scripts/start-bg-and-bridge-mndzhev9-launchd-wrapper.sh"
echo ""
