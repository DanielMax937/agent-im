#!/usr/bin/env bash
set -euo pipefail

# Quick smoke test: verify Telegram bot token and send a test message.
# Usage: bash scripts/test-telegram.sh [message]

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

if [ -z "${CTI_TG_CHAT_ID:-}" ]; then
  echo "Error: CTI_TG_CHAT_ID not set in $CONFIG_FILE"
  exit 1
fi

BASE_URL="https://api.telegram.org/bot${CTI_TG_BOT_TOKEN}"
MESSAGE="${1:-Hello from claude-to-im test!}"

# Resolve proxy: CTI_PROXY > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
PROXY_URL="${CTI_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-${ALL_PROXY:-}}}}"
CURL_PROXY_OPTS=""
if [ -n "$PROXY_URL" ]; then
  CURL_PROXY_OPTS="-x $PROXY_URL"
  echo "Proxy: $PROXY_URL"
  echo ""
fi

# Step 1: Validate bot token
echo "1. Validating bot token..."
ME_RESULT=$(curl -s --max-time 10 $CURL_PROXY_OPTS "${BASE_URL}/getMe")

if echo "$ME_RESULT" | grep -q '"ok":true'; then
  BOT_NAME=$(echo "$ME_RESULT" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  echo "   OK — bot: @${BOT_NAME}"
else
  echo "   FAIL — getMe response: $ME_RESULT"
  exit 1
fi

# Step 2: Send test message
echo "2. Sending message to chat ${CTI_TG_CHAT_ID}..."
SEND_RESULT=$(curl -s --max-time 10 $CURL_PROXY_OPTS "${BASE_URL}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${CTI_TG_CHAT_ID}\", \"text\": \"${MESSAGE}\"}")

if echo "$SEND_RESULT" | grep -q '"ok":true'; then
  MSG_ID=$(echo "$SEND_RESULT" | sed -n 's/.*"message_id":\([0-9]*\).*/\1/p')
  echo "   OK — message_id: ${MSG_ID}"
else
  echo "   FAIL — sendMessage response: $SEND_RESULT"
  exit 1
fi

echo ""
echo "All checks passed."
