#!/bin/sh
set -eu

if [ -n "${CTI_PROXY:-}" ]; then
  : "${HTTP_PROXY:=$CTI_PROXY}"
  : "${HTTPS_PROXY:=$CTI_PROXY}"
  : "${ALL_PROXY:=$CTI_PROXY}"
  export HTTP_PROXY HTTPS_PROXY ALL_PROXY

  : "${http_proxy:=$CTI_PROXY}"
  : "${https_proxy:=$CTI_PROXY}"
  : "${all_proxy:=$CTI_PROXY}"
  export http_proxy https_proxy all_proxy
fi

exec codex --dangerously-bypass-approvals-and-sandbox "$@"
