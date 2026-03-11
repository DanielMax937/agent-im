#!/usr/bin/env bash
set -euo pipefail

# Deploy claude-to-im skill to a target runtime.
#
# Usage:
#   bash scripts/deploy.sh <target> [--link]
#
#   target:  claude | codex | cursor
#   --link:  create a symlink instead of copying (for development)

SKILL_NAME="claude-to-im"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 <target> [--link]"
  echo ""
  echo "Targets:"
  echo "  claude   Deploy to ~/.claude/skills/$SKILL_NAME"
  echo "  codex    Deploy to ~/.codex/skills/$SKILL_NAME"
  echo "  cursor   Deploy to ~/.cursor/skills/$SKILL_NAME"
  echo ""
  echo "Options:"
  echo "  --link   Create a symlink instead of copying (for development)"
  exit 1
}

TARGET="${1:-}"
LINK_MODE=false

if [ -z "$TARGET" ]; then
  usage
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    --link) LINK_MODE=true ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
  shift
done

# Resolve target directory and runtime name
case "$TARGET" in
  claude)
    SKILLS_DIR="$HOME/.claude/skills"
    RUNTIME="claude"
    ;;
  codex)
    SKILLS_DIR="$HOME/.codex/skills"
    RUNTIME="codex"
    ;;
  cursor)
    SKILLS_DIR="$HOME/.cursor/skills"
    RUNTIME="cursor"
    ;;
  *)
    echo "Error: unknown target '$TARGET'"
    echo ""
    usage
    ;;
esac

TARGET_DIR="$SKILLS_DIR/$SKILL_NAME"

echo "Deploying $SKILL_NAME skill for $TARGET..."
echo "  Source:  $SOURCE_DIR"
echo "  Target:  $TARGET_DIR"
echo "  Runtime: $RUNTIME"
echo ""

# ── Validate source ──

if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

if [ ! -f "$SOURCE_DIR/package.json" ]; then
  echo "Error: package.json not found in $SOURCE_DIR"
  exit 1
fi

# ── Check if already installed ──

if [ -e "$TARGET_DIR" ]; then
  if [ -L "$TARGET_DIR" ]; then
    EXISTING=$(readlink "$TARGET_DIR")
    if [ "$LINK_MODE" = true ] && [ "$EXISTING" = "$SOURCE_DIR" ]; then
      echo "Already symlinked to the same source."
    else
      echo "Already installed as symlink → $EXISTING"
      echo "To reinstall, remove it first: rm $TARGET_DIR"
      exit 0
    fi
  else
    echo "Already installed at $TARGET_DIR"
    echo "To reinstall, remove it first: rm -rf $TARGET_DIR"
    exit 0
  fi
fi

# ── Install ──

mkdir -p "$SKILLS_DIR"

if [ "$LINK_MODE" = true ]; then
  if [ ! -L "$TARGET_DIR" ]; then
    ln -s "$SOURCE_DIR" "$TARGET_DIR"
  fi
  echo "Symlinked: $TARGET_DIR → $SOURCE_DIR"
  WORK_DIR="$SOURCE_DIR"
else
  cp -R "$SOURCE_DIR" "$TARGET_DIR"
  echo "Copied to: $TARGET_DIR"
  WORK_DIR="$TARGET_DIR"
fi

# ── Dependencies ──

NEED_INSTALL=false

if [ ! -d "$WORK_DIR/node_modules" ]; then
  NEED_INSTALL=true
fi

# Runtime-specific dependency checks
case "$RUNTIME" in
  codex|cursor)
    if [ ! -d "$WORK_DIR/node_modules/@openai/codex-sdk" ]; then
      NEED_INSTALL=true
    fi
    ;;
esac

if [ "$NEED_INSTALL" = true ]; then
  echo ""
  echo "Installing dependencies..."
  (cd "$WORK_DIR" && npm install)
fi

# ── Build ──

if [ ! -f "$WORK_DIR/dist/daemon.mjs" ]; then
  echo ""
  echo "Building daemon bundle..."
  (cd "$WORK_DIR" && npm run build)
else
  # Check if source is newer than bundle
  STALE_SRC=$(find "$WORK_DIR/src" -name '*.ts' -newer "$WORK_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
  if [ -n "$STALE_SRC" ]; then
    echo ""
    echo "Source files changed, rebuilding..."
    (cd "$WORK_DIR" && npm run build)
  fi
fi

# ── Prune dev dependencies (copy mode only) ──

if [ "$LINK_MODE" = false ]; then
  echo ""
  echo "Pruning dev dependencies..."
  (cd "$WORK_DIR" && npm prune --production)
fi

# ── Verify wrapper scripts ──

case "$RUNTIME" in
  codex)
    WRAPPER="$WORK_DIR/scripts/codex-wrapper.sh"
    if [ -f "$WRAPPER" ] && [ ! -x "$WRAPPER" ]; then
      chmod +x "$WRAPPER"
    fi
    ;;
  cursor)
    WRAPPER="$WORK_DIR/scripts/cursor-wrapper.sh"
    if [ -f "$WRAPPER" ] && [ ! -x "$WRAPPER" ]; then
      chmod +x "$WRAPPER"
    fi
    ;;
esac

# ── Config hint ──

CTI_HOME="$HOME/.claude-to-im"
CONFIG_FILE="$CTI_HOME/config.env"

echo ""
echo "=== Deployment complete ==="
echo ""

if [ -f "$CONFIG_FILE" ]; then
  CURRENT_RUNTIME=$(grep "^CTI_RUNTIME=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//' || true)
  if [ -n "$CURRENT_RUNTIME" ] && [ "$CURRENT_RUNTIME" != "$RUNTIME" ]; then
    echo "Note: config.env has CTI_RUNTIME=$CURRENT_RUNTIME but you deployed for $RUNTIME."
    echo "  To switch runtime, update ~/.claude-to-im/config.env:"
    echo "    CTI_RUNTIME=$RUNTIME"
    echo ""
  fi
fi

echo "Next steps:"
if [ ! -f "$CONFIG_FILE" ]; then
  case "$TARGET" in
    claude)
      echo "  1. Start a Claude Code session and run: /claude-to-im setup"
      ;;
    codex)
      echo "  1. Start a Codex session and say: claude-to-im setup"
      ;;
    cursor)
      echo "  1. Start a Cursor agent session and say: claude-to-im setup"
      ;;
  esac
else
  case "$TARGET" in
    claude)
      echo "  1. /claude-to-im start    — start the bridge daemon"
      echo "  2. /claude-to-im doctor   — diagnose issues"
      echo "  3. /claude-to-im status   — check bridge status"
      ;;
    *)
      echo "  1. claude-to-im start     — start the bridge daemon"
      echo "  2. claude-to-im doctor    — diagnose issues"
      echo "  3. claude-to-im status    — check bridge status"
      ;;
  esac
fi
