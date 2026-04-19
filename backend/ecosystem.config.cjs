/**
 * PM2 ecosystem config for standalone (non-Passenger) production deploys.
 *
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup     # persist across reboots
 *   pm2 logs chm-api            # tail logs
 *   pm2 monit                   # live dashboard
 *
 * On cPanel with Passenger, PM2 is not needed — Passenger manages the process.
 */

module.exports = {
  apps: [
    {
      name: 'chm-api',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3001,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
