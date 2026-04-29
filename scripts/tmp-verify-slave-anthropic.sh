#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ANTHROPIC_BASE_URL:-https://token-plan-sgp.xiaomimimo.com/anthropic}"
MODEL="${1:-${ANTHROPIC_MODEL:-mimo-v2.5-pro}}"
API_KEY="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}"

if [ -z "$API_KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is not set." >&2
  exit 2
fi

endpoint="${BASE_URL%/}/v1/messages"
tmp_body="$(mktemp)"
tmp_headers="$(mktemp)"
cleanup() {
  rm -f "$tmp_body" "$tmp_headers"
}
trap cleanup EXIT

echo "base_url=$BASE_URL"
echo "endpoint=$endpoint"
echo "model=$MODEL"
echo "api_key_present=yes"
echo "api_key_suffix=****${API_KEY: -4}"
echo "proxy=${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-none}}}}"

payload=$(
  MODEL="$MODEL" node - <<'NODE'
const model = process.env.MODEL;
process.stdout.write(JSON.stringify({
  model,
  max_tokens: 64,
  messages: [
    { role: "user", content: "Reply with exactly: ok" }
  ]
}));
NODE
)

status="$(
  curl -sS \
    -D "$tmp_headers" \
    -o "$tmp_body" \
    -w "%{http_code}" \
    --connect-timeout 20 \
    --max-time 60 \
    -X POST "$endpoint" \
    -H "content-type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    -H "x-api-key: $API_KEY" \
    -H "authorization: Bearer $API_KEY" \
    --data "$payload"
)"

echo "http_status=$status"

node - "$tmp_body" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const raw = fs.readFileSync(file, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.log("response_body=" + raw.slice(0, 1200));
  process.exit(0);
}

if (parsed.error) {
  console.log("error_type=" + (parsed.error.type ?? "(none)"));
  console.log("error_message=" + (parsed.error.message ?? JSON.stringify(parsed.error)));
  if (parsed.request_id) console.log("request_id=" + parsed.request_id);
  process.exit(0);
}

console.log("response_id=" + (parsed.id ?? "(none)"));
console.log("response_model=" + (parsed.model ?? "(none)"));
console.log("stop_reason=" + (parsed.stop_reason ?? "(none)"));
const text = Array.isArray(parsed.content)
  ? parsed.content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text)
      .join("")
  : "";
console.log("text=" + text.slice(0, 500));
NODE

case "$status" in
  2*) exit 0 ;;
  *) exit 1 ;;
esac
