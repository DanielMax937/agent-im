#!/bin/sh
set -eu

if [ -n "${CTI_CODEX_CLI_EXECUTABLE:-}" ]; then
  exec "${CTI_CODEX_CLI_EXECUTABLE}" --dangerously-bypass-approvals-and-sandbox "$@"
fi

# `npm start` prepends the repository's node_modules/.bin to PATH. Prefer the
# complete user-level Codex installation when present so a pruned optional
# native package in node_modules cannot shadow it.
if [ -x "${HOME}/.npm_global/bin/codex" ]; then
  exec "${HOME}/.npm_global/bin/codex" --dangerously-bypass-approvals-and-sandbox "$@"
fi

exec codex --dangerously-bypass-approvals-and-sandbox "$@"
