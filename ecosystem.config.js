module.exports = {
    apps: [
        {
            name: 'polymarket-bot',
            script: './dist/index.js',

            // Restart every day at 3 AM
            cron_restart: '0 3 * * *',

            // Auto restart on crash
            autorestart: true,

            // Maximum memory before restart (optional)
            max_memory_restart: '500M',

            // Watch for file changes in development (set to false in production)
            watch: false,

            // Environment variables (optional - uses .env by default)
            // TELEGRAM_COMMAND_LISTENER_ENABLED must be true for THIS app only.
            // Telegram permits a single getUpdates long-poll consumer per bot
            // token, so the worker apps below deliberately leave it unset and
            // stay send-only.
            env: {
                NODE_ENV: 'production',
                TELEGRAM_COMMAND_LISTENER_ENABLED: 'true',
            },

            // Development environment
            env_development: {
                NODE_ENV: 'development',
                TELEGRAM_COMMAND_LISTENER_ENABLED: 'true',
            },

            // Logging
            error_file: './logs/error.log',
            out_file: './logs/out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

            // Combine logs from all instances
            merge_logs: true,

            // Time to wait before force killing app on restart
            kill_timeout: 5000,

            // Time to wait before considering app as online
            listen_timeout: 10000,

            // Number of times to retry start if app crashes immediately
            max_restarts: 10,
            min_uptime: '10s',
        },
        {
            name: 'discovery-worker',
            script: './dist/discoveryWorker.js',
            autorestart: true,
            watch: false,
            env: {
                NODE_ENV: 'production',
            },
            error_file: './logs/discovery-worker-error.log',
            out_file: './logs/discovery-worker-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            kill_timeout: 5000,
            max_restarts: 10,
            min_uptime: '10s',
        },
        {
            name: 'new-wallet-worker',
            script: './dist/newWalletWorker.js',
            autorestart: true,
            watch: false,
            env: {
                NODE_ENV: 'production',
            },
            error_file: './logs/new-wallet-worker-error.log',
            out_file: './logs/new-wallet-worker-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            kill_timeout: 5000,
            max_restarts: 10,
            min_uptime: '10s',
        },
    ],
};
