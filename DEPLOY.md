# Deployment Guide

## Quick Deploy (Recommended for Development)

The simplest way to deploy after making changes:

```bash
./deploy cursor
```

This will:
1. ✅ Build the daemon bundle
2. ✅ Remove any existing installation
3. ✅ Create a symlink (dev mode)
4. ✅ Verify the build

For other targets:
```bash
./deploy claude    # Deploy to Claude Code
./deploy codex     # Deploy to Codex
./deploy cursor    # Deploy to Cursor (default)
```

## Advanced Deploy Options

Use the full deploy script for more control:

### Development Mode (Symlink)
Changes are immediately reflected without redeploying:
```bash
bash scripts/deploy.sh cursor --link
```

### Production Mode (Copy)
Creates a standalone copy:
```bash
bash scripts/deploy.sh cursor
```

### Force Redeploy
Remove existing installation and redeploy:
```bash
bash scripts/deploy.sh cursor --link --force
```

### Combined Options
```bash
# Development mode with force
bash scripts/deploy.sh cursor --link --force

# Production mode with force
bash scripts/deploy.sh cursor --force
```

## Deployment Modes Comparison

| Mode | Command | Use Case | Changes Reflected |
|------|---------|----------|-------------------|
| **Quick Deploy** | `./deploy cursor` | Fast iteration during development | Immediately (symlink) |
| **Symlink** | `bash scripts/deploy.sh cursor --link` | Development | Immediately (symlink) |
| **Copy** | `bash scripts/deploy.sh cursor` | Production/Testing | After rebuild + redeploy |

## After Deployment

Restart the bridge to pick up changes:
```bash
bash ~/.cursor/skills/claude-to-im/scripts/daemon.sh stop
bash ~/.cursor/skills/claude-to-im/scripts/daemon.sh start
```

Or check status:
```bash
bash ~/.cursor/skills/claude-to-im/scripts/daemon.sh status
```

## Targets

- **claude** → `~/.claude/skills/claude-to-im`
- **codex** → `~/.codex/skills/claude-to-im`
- **cursor** → `~/.cursor/skills/claude-to-im`
