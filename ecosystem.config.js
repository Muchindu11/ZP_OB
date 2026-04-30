// ============================================================
//  ZAMBIA POLICE SERVICE — Occurrence Book
//  ecosystem.config.js  |  PM2 process manager configuration
//
//  Commands:
//    pm2 start ecosystem.config.js      ← start
//    pm2 reload ecosystem.config.js     ← zero-downtime reload
//    pm2 stop zp-ob                     ← stop
//    pm2 logs zp-ob                     ← live log tail
//    pm2 monit                          ← resource dashboard
//
//  Enable auto-start on server reboot:
//    pm2 save
//    pm2 startup        ← follow the printed instruction
// ============================================================

module.exports = {
  apps: [
    {
      name        : 'zp-ob',
      script      : 'server.js',
      cwd         : '/opt/zp_ob',

      // ── Process model ────────────────────────────────────
      instances   : 1,        // single instance (SQLite does not support multi-process writes)
      exec_mode   : 'fork',   // fork mode for single-instance SQLite apps

      // ── Environment ──────────────────────────────────────
      env_production: {
        NODE_ENV: 'production',
      },

      // ── Restart policy ───────────────────────────────────
      watch           : false,           // do not watch for file changes in production
      max_restarts    : 10,              // restart up to 10 times before giving up
      min_uptime      : '30s',           // must stay up at least 30s to count as a successful start
      restart_delay   : 4000,            // wait 4 seconds between restarts

      // ── Memory limit ─────────────────────────────────────
      max_memory_restart: '256M',        // restart if RSS exceeds 256 MB

      // ── Logging ──────────────────────────────────────────
      out_file        : '/var/log/zp_ob/out.log',
      error_file      : '/var/log/zp_ob/error.log',
      log_date_format : 'YYYY-MM-DD HH:mm:ss',
      merge_logs      : true,

      // ── Source maps ──────────────────────────────────────
      source_map_support: false,
    },
  ],
};
