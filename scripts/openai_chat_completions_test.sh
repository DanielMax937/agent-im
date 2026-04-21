#!/usr/bin/env bash
# Regression helper for POST /v1/chat/completions (OpenAI-compatible).
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3300}"
MODEL="${MODEL:-gpt-5-mini}"
MODE="all"
TEXT_PROMPT=""
IMAGE_URL=""
CURL_MAX_TIME="${CURL_MAX_TIME:-180}"

usage() {
  cat <<'EOF'
用法: openai_chat_completions_test.sh [选项]

调用本地 agent-im 的 OpenAI 兼容接口 POST /v1/chat/completions，做文本或图文回归测试。

选项:
  -h, --help              显示本帮助并退出
  --base-url URL          服务根地址 (默认: http://127.0.0.1:3300)
  --model MODEL           模型名 (默认: gpt-5-mini)
  --all                   依次运行文本测试与图文混合测试 (默认)
  --text-only             仅运行纯文本请求
  --vision                仅运行文本 + image_url 混合请求
  --text PROMPT           用户问题/提示词
                          --text-only 默认: 「请回复：测试通过」
                          --vision / --all 中图文默认: 「图片出现了什么交通工具」
  --image-url URL         图文测试中的图片地址 (默认: bitstripe 示例图)
  --max-time SECONDS      curl 超时秒数 (默认: 180)

环境变量 (与选项等价，选项优先):
  BASE_URL, MODEL, CURL_MAX_TIME

示例:
  ./scripts/openai_chat_completions_test.sh
  ./scripts/openai_chat_completions_test.sh --text-only --text 'ping'
  ./scripts/openai_chat_completions_test.sh --vision \\
    --text '图片出现了什么交通工具' \\
    --image-url 'https://www.bitstripe.cn/files/01-cover-first-cheating-experience.png'
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_python() {
  command -v python3 >/dev/null 2>&1 || die "需要 python3 以安全生成 JSON 请求体"
}

json_payload_text() {
  local prompt="$1"
  require_python
  TEXT_PROMPT_JSON="$prompt" MODEL_JSON="$MODEL" python3 - <<'PY'
import json, os
body = {
  "model": os.environ["MODEL_JSON"],
  "messages": [{"role": "user", "content": os.environ["TEXT_PROMPT_JSON"]}],
}
print(json.dumps(body, ensure_ascii=False))
PY
}

json_payload_vision() {
  local prompt="$1"
  local url="$2"
  require_python
  export TEXT_PROMPT_JSON="$prompt" IMAGE_URL_JSON="$url" MODEL_JSON="$MODEL"
  python3 - <<'PY'
import json, os
body = {
  "model": os.environ["MODEL_JSON"],
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": os.environ["TEXT_PROMPT_JSON"]},
        {"type": "image_url", "image_url": {"url": os.environ["IMAGE_URL_JSON"]}},
      ],
    }
  ],
}
print(json.dumps(body, ensure_ascii=False))
PY
}

post_completions() {
  local payload="$1"
  local label="$2"
  local response_file
  response_file="$(mktemp)"
  local http_code
  echo "── ${label} ──"
  echo "POST ${BASE_URL}/v1/chat/completions  model=${MODEL}  timeout=${CURL_MAX_TIME}s"
  http_code="$(
    curl -sS --max-time "${CURL_MAX_TIME}" -o "${response_file}" -w "%{http_code}" \
      "${BASE_URL}/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d "${payload}"
  )" || true
  echo "HTTP ${http_code}"
  cat "${response_file}"
  rm -f "${response_file}"
  echo ""
  if [[ "${http_code}" != "200" ]]; then
    die "请求未返回 200 (got ${http_code})"
  fi
}

run_text_only() {
  local p="${TEXT_PROMPT:-请回复：测试通过}"
  post_completions "$(json_payload_text "${p}")" "纯文本"
}

run_vision() {
  local p="${TEXT_PROMPT:-图片出现了什么交通工具}"
  local u="${IMAGE_URL:-https://www.bitstripe.cn/files/01-cover-first-cheating-experience.png}"
  post_completions "$(json_payload_vision "${p}" "${u}")" "文本 + image_url"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --base-url)
      [[ $# -ge 2 ]] || die "--base-url 需要参数"
      BASE_URL="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || die "--model 需要参数"
      MODEL="$2"
      shift 2
      ;;
    --all)
      MODE="all"
      shift
      ;;
    --text-only)
      MODE="text"
      shift
      ;;
    --vision)
      MODE="vision"
      shift
      ;;
    --text)
      [[ $# -ge 2 ]] || die "--text 需要参数"
      TEXT_PROMPT="$2"
      shift 2
      ;;
    --image-url)
      [[ $# -ge 2 ]] || die "--image-url 需要参数"
      IMAGE_URL="$2"
      shift 2
      ;;
    --max-time)
      [[ $# -ge 2 ]] || die "--max-time 需要参数"
      CURL_MAX_TIME="$2"
      shift 2
      ;;
    *)
      die "未知参数: $1 (使用 --help)"
      ;;
  esac
done

case "${MODE}" in
  all)
    run_text_only
    run_vision
    ;;
  text)
    run_text_only
    ;;
  vision)
    run_vision
    ;;
  *)
    die "内部错误: MODE=${MODE}"
    ;;
esac

echo "done."
