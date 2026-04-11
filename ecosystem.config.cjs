/**
 * PM2: Next.js production (`npm start`) for Kanban platform + bridge admin APIs.
 * Default port 3300; override with PORT=... when starting.
 *
 * Git: `CTI_GIT_EXECUTABLE` is set at PM2 boot to the first path that exists and passes
 * `git --version` (/usr/local/bin → /usr/bin; no Homebrew-only path — install `brew install git`
 * if you need /opt/homebrew/bin/git and set CTI_GIT_EXECUTABLE yourself). Override before `pm2 start` if needed.
 * After editing this file: `pm2 restart agent-im --update-env`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Same probe order as src/platform/git-service.ts (non-Windows). */
function resolveGitExecutableForPm2() {
  const fromEnv = process.env.CTI_GIT_EXECUTABLE?.trim();
  if (fromEnv) {
    return { resolved: path.resolve(fromEnv), source: 'env_already_set' };
  }
  const candidates =
    process.platform === 'win32'
      ? []
      : ['/usr/local/bin/git', '/usr/bin/git'];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
    } catch {
      continue;
    }
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    if (!r.error && r.status === 0) {
      return { resolved: c, source: 'boot_probe' };
    }
  }
  return { resolved: null, source: 'none' };
}

const gitBoot = resolveGitExecutableForPm2();
const baseEnv = {
  NODE_ENV: 'production',
  PORT: process.env.PORT || 3300,
  NODE_OPTIONS: '--experimental-sqlite',
  // Empty: admin lists all bridges under CTI_BASE, not one fixed CTI_HOME.
  CTI_HOME: '',
};
if (gitBoot.resolved) {
  baseEnv.CTI_GIT_EXECUTABLE = gitBoot.resolved;
}

module.exports = {
  apps: [
    {
      name: 'agent-im',
      script: 'npm',
      args: ['start'],
      cwd: __dirname,
      env: {
        ...baseEnv,
        // For logs: how PM2 chose CTI_GIT_EXECUTABLE (see bridge / kanban logs).
        CTI_GIT_PM2_BOOT_SOURCE: gitBoot.source,
      },
      interpreter: 'none',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s',
    },
  ],
};
