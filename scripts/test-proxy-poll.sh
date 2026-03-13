#!/usr/bin/env bash
set -euo pipefail

# Test proxy connectivity and Telegram long-polling (getUpdates).
# Usage: bash scripts/test-proxy-poll.sh

CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
CONFIG_FILE="$CTI_HOME/config.env"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: $CONFIG_FILE not found. Run setup first."
  exit 1
fi

source "$CONFIG_FILE"

if [ -z "${CTI_TG_BOT_TOKEN:-}" ]; then
  echo "Error: CTI_TG_BOT_TOKEN not set in $CONFIG_FILE"
  exit 1
fi

BASE_URL="https://api.telegram.org/bot${CTI_TG_BOT_TOKEN}"

PROXY_URL="${CTI_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-${ALL_PROXY:-}}}}"
CURL_PROXY_OPTS=""
if [ -n "$PROXY_URL" ]; then
  CURL_PROXY_OPTS="-x $PROXY_URL"
fi

echo "=== Proxy & Telegram Poll Test ==="
echo ""

# Step 1: Test raw proxy connectivity
echo "1. Testing proxy connectivity..."
if [ -n "$PROXY_URL" ]; then
  echo "   Proxy: $PROXY_URL"
  if curl -s --max-time 5 $CURL_PROXY_OPTS -o /dev/null -w "   HTTP %{http_code} — connected in %{time_connect}s, total %{time_total}s\n" "https://api.telegram.org"; then
    echo "   OK"
  else
    echo "   FAIL — cannot reach api.telegram.org through proxy"
    echo ""
    echo "   Possible causes:"
    echo "   - Proxy not running on $PROXY_URL"
    echo "   - Proxy blocks HTTPS CONNECT to api.telegram.org"
    echo "   - Firewall / network issue"
    exit 1
  fi
else
  echo "   No proxy configured, testing direct connection..."
  if curl -s --max-time 5 -o /dev/null -w "   HTTP %{http_code} — connected in %{time_connect}s, total %{time_total}s\n" "https://api.telegram.org"; then
    echo "   OK"
  else
    echo "   FAIL — cannot reach api.telegram.org directly"
    exit 1
  fi
fi
echo ""

# Step 2: Test getMe (quick API health check)
echo "2. Testing getMe..."
ME_RESULT=$(curl -s --max-time 10 $CURL_PROXY_OPTS "${BASE_URL}/getMe" 2>&1) || true

if echo "$ME_RESULT" | grep -q '"ok":true'; then
  BOT_NAME=$(echo "$ME_RESULT" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  echo "   OK — bot: @${BOT_NAME}"
else
  echo "   FAIL — response: $ME_RESULT"
  exit 1
fi
echo ""

# Step 3: Test getUpdates (short poll, timeout=5s)
echo "3. Testing getUpdates (short poll, timeout=5s)..."
POLL_START=$(date +%s)
POLL_HTTP_CODE=$(curl -s -o /tmp/cti_poll_result.json -w "%{http_code}" \
  --max-time 15 ${CURL_PROXY_OPTS} \
  "${BASE_URL}/getUpdates?timeout=5&limit=1" 2>/dev/null) || POLL_HTTP_CODE="000"
POLL_RESULT=$(cat /tmp/cti_poll_result.json 2>/dev/null || echo "")
POLL_END=$(date +%s)
POLL_DURATION=$((POLL_END - POLL_START))

if [ "$POLL_HTTP_CODE" = "200" ] && echo "$POLL_RESULT" | grep -q '"ok":true'; then
  UPDATE_COUNT=$(echo "$POLL_RESULT" | grep -o "update_id" | wc -l | tr -d ' ')
  echo "   OK — HTTP $POLL_HTTP_CODE, ${UPDATE_COUNT} pending update(s), took ${POLL_DURATION}s"
else
  echo "   FAIL — HTTP $POLL_HTTP_CODE"
  [ -n "$POLL_RESULT" ] && echo "   Response: $POLL_RESULT"
  echo ""
  echo "   Possible causes:"
  echo "   - Proxy drops long-lived connections"
  echo "   - Proxy timeout too short"
  exit 1
fi
echo ""

# Step 4: Test long poll (timeout=30s) to simulate real bridge usage
echo "4. Testing long poll (timeout=30s, simulates real bridge polling)..."
echo "   Waiting up to 35s for Telegram to respond..."
LONG_START=$(date +%s)
LONG_HTTP_CODE=$(curl -s -o /tmp/cti_longpoll_result.json -w "%{http_code}" \
  --max-time 45 ${CURL_PROXY_OPTS} \
  "${BASE_URL}/getUpdates?timeout=30&limit=1&offset=-1" 2>/dev/null) || LONG_HTTP_CODE="000"
LONG_RESULT=$(cat /tmp/cti_longpoll_result.json 2>/dev/null || echo "")
LONG_END=$(date +%s)
LONG_DURATION=$((LONG_END - LONG_START))

if [ "$LONG_HTTP_CODE" = "200" ] && echo "$LONG_RESULT" | grep -q '"ok":true'; then
  echo "   OK — HTTP $LONG_HTTP_CODE, long poll returned after ${LONG_DURATION}s"
else
  echo "   FAIL — HTTP $LONG_HTTP_CODE after ${LONG_DURATION}s"
  [ -n "$LONG_RESULT" ] && echo "   Response: $LONG_RESULT"
  echo ""
  echo "   Long poll failed but short poll succeeded."
  echo "   Your proxy likely kills idle connections held open >5s."
  echo "   Fix: increase proxy read-timeout / idle-timeout to ≥60s."
  exit 1
fi
echo ""

echo "=== All tests passed ==="
