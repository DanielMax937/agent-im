#!/bin/sh
set -eu

exec codex --dangerously-bypass-approvals-and-sandbox "$@"
