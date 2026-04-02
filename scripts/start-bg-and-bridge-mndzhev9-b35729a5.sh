#!/usr/bin/env bash
set -euo pipefail
#
# 1) 调用仓库根目录 start-bg.sh（build + PM2 启动 agent-im）
# 2) 最多轮询 5 分钟，直到 GET /health 表示服务就绪
# 3) 成功后 POST /api/bridge/start 启动桥接 bridge-mndzhev9-b35729a5
#
# 环境变量（可选）:
#   PORT       默认 3300（须与 start-bg.sh / Next 一致）
#   BASE_URL   默认 http://127.0.0.1:$PORT
#   BRIDGE_SLUG 默认 bridge-mndzhev9-b35729a5
#   POLL_SECONDS 默认 300（秒）
#   POLL_INTERVAL 默认 3（秒）

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-3300}"
BASE_URL="${BASE_URL:-http://127.0.0.1:$PORT}"
BRIDGE_SLUG="${BRIDGE_SLUG:-bridge-mndzhev9-b35729a5}"
POLL_SECONDS="${POLL_SECONDS:-300}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"

health_ok() {
  curl -sfS "$BASE_URL/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

echo "==> Running start-bg.sh (build + PM2)..."
bash "$REPO_ROOT/start-bg.sh"

echo ""
echo "==> Waiting for service health at $BASE_URL/health (max ${POLL_SECONDS}s, every ${POLL_INTERVAL}s)..."
elapsed=0
healthy=0
while [ "$elapsed" -lt "$POLL_SECONDS" ]; do
  if health_ok; then
    healthy=1
    break
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

if [ "$healthy" -ne 1 ]; then
  echo "Timeout: service did not report ok=true on /health within ${POLL_SECONDS}s." >&2
  exit 1
fi

echo "==> Service is up. Starting bridge slug: $BRIDGE_SLUG"
curl -sfS -X POST "$BASE_URL/api/bridge/start" \
  -H "Content-Type: application/json" \
  -d "{\"slug\":\"$BRIDGE_SLUG\"}"
echo ""
echo "==> Done."
