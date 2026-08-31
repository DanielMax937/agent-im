#!/usr/bin/env bash
# GitHub Actions self-hosted runner (macOS launchd): run after unsetting proxy and applying npm registry.
# Install: copy to "$RUNNER_ROOT/runsvc-local-env.sh", chmod +x; point LaunchAgent ProgramArguments to this script + use runsvc.sh via cwd.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Clear proxy so gh/npm/git talk to public endpoints reliably (LaunchAgent may inherit shell proxy).
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy no_proxy NO_PROXY

# Default China npm mirror (override with NPM_CONFIG_REGISTRY before start if needed).
export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
if command -v npm >/dev/null 2>&1; then
  npm config set registry "$NPM_CONFIG_REGISTRY" --location=global 2>/dev/null || true
fi

exec ./runsvc.sh
