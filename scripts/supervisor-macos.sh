#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

LAUNCHD_LABEL="com.claude-to-im.bridge"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"
ZSH_ENV_CACHE=""

# ── launchd helpers ──

plist_escape() {
  local s="${1:-}"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

should_forward_shell_env_var() {
  case "${1:-}" in
    HOME|PATH|USER|LOGNAME|SHELL|LANG|TMPDIR|TEMP|TMP|TERM|COLORTERM|LC_ALL|LC_CTYPE|NODE_EXTRA_CA_CERTS|SSH_AUTH_SOCK|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)
      return 0
      ;;
    OPENAI_*|ANTHROPIC_*|CODEX_*|CURSOR_*|GITHUB_*|GH_*|COPILOT_*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

load_zsh_startup_env() {
  if [ -n "$ZSH_ENV_CACHE" ]; then
    printf '%s\n' "$ZSH_ENV_CACHE"
    return
  fi

  if ! command -v zsh >/dev/null 2>&1; then
    return
  fi

  ZSH_ENV_CACHE="$(
    env -i \
      HOME="$HOME" \
      USER="${USER:-}" \
      LOGNAME="${LOGNAME:-${USER:-}}" \
      SHELL="${SHELL:-/bin/zsh}" \
      PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
      TERM="${TERM:-xterm-256color}" \
      zsh -lic 'command env' 2>/dev/null || true
  )"
  printf '%s\n' "$ZSH_ENV_CACHE"
}

# Collect env vars that should be forwarded into the plist.
# We honour clean_env() logic by reading *after* clean_env runs.
build_env_dict() {
  local indent="            "
  local dict=""
  local seen=$'\n'

  append_env_var() {
    local name="$1"
    local val="$2"
    [ -n "$name" ] || return 0
    [ -n "$val" ] || return 0
    case "$seen" in
      *$'\n'"$name"$'\n'*) return 0 ;;
    esac
    seen+="${name}"$'\n'
    dict+="${indent}<key>$(plist_escape "$name")</key>\n${indent}<string>$(plist_escape "$val")</string>\n"
  }

  # Forward current process basics first.
  for var in HOME PATH USER LOGNAME SHELL LANG TMPDIR TEMP TMP TERM COLORTERM LC_ALL LC_CTYPE NODE_EXTRA_CA_CERTS SSH_AUTH_SOCK XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME; do
    append_env_var "$var" "${!var:-}"
  done

  # Merge provider/auth env from zsh startup files (`~/.zprofile`, `~/.zshrc`) as fallback.
  while IFS= read -r line; do
    [[ "$line" == *=* ]] || continue
    local name="${line%%=*}"
    local val="${line#*=}"
    should_forward_shell_env_var "$name" || continue
    append_env_var "$name" "$val"
  done < <(load_zsh_startup_env)

  # Merge provider/auth env from the current process environment. This is intentionally
  # runtime-agnostic because one bridge may host multiple runner runtimes.
  while IFS='=' read -r name val; do
    should_forward_shell_env_var "$name" || continue
    append_env_var "$name" "$val"
  done < <(env)

  # Forward CTI_* vars last so bridge/config values always win over shell defaults.
  while IFS='=' read -r name val; do
    case "$name" in
      CTI_*)
        dict+="${indent}<key>$(plist_escape "$name")</key>\n${indent}<string>$(plist_escape "$val")</string>\n"
        ;;
    esac
  done < <(env)

  echo -e "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path}</string>
        <string>${SKILL_DIR}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

supervisor_stop() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
