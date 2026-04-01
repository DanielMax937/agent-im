/**
 * PM2: Next.js production (`npm start`) for Kanban platform + bridge admin APIs.
 * Default port 3300; override with PORT=... when starting.
 */
module.exports = {
  apps: [
    {
      name: 'agent-im',
      script: 'npm',
      args: ['start'],
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3300,
        NODE_OPTIONS: '--experimental-sqlite',
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
