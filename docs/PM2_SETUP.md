# PM2 Process Manager Setup

This guide shows you how to run the Polymarket copy trading bot with PM2 for production deployment with automatic restarts.

## Prerequisites

Install PM2 globally:
```bash
npm install -g pm2
```

## Quick Start

### 1. Build the project
```bash
npm run build
```

### 2. Start with PM2
```bash
pm2 start ecosystem.config.js
```

### 3. Save PM2 process list (auto-start on reboot)
```bash
pm2 save
pm2 startup
```

## PM2 Configuration

The `ecosystem.config.js` file includes:

### ⏰ Automatic Daily Restart
```javascript
cron_restart: '0 3 * * *'  // Restarts every day at 3 AM
```

### Common Cron Patterns

| Pattern | Description |
|---------|-------------|
| `'0 3 * * *'` | Every day at 3 AM |
| `'0 */12 * * *'` | Every 12 hours |
| `'0 0 */2 * *'` | Every 2 days at midnight |
| `'0 0 */7 * *'` | Every 7 days at midnight |
| `'0 0 * * 0'` | Every Sunday at midnight |
| `'*/30 * * * *'` | Every 30 minutes |

### 🔄 Memory-Based Restart
```javascript
max_memory_restart: '500M'  // Restart if memory usage exceeds 500MB
```

### 📝 Logging
Logs are saved to:
- `./logs/error.log` - Error logs
- `./logs/out.log` - Standard output logs

## PM2 Commands

### View Running Processes
```bash
pm2 list
```

### View Logs (real-time)
```bash
pm2 logs polymarket-bot
```

### View Specific Log Types
```bash
pm2 logs polymarket-bot --err     # Error logs only
pm2 logs polymarket-bot --out     # Output logs only
pm2 logs polymarket-bot --lines 100  # Last 100 lines
```

### Restart Bot
```bash
pm2 restart polymarket-bot
```

### Stop Bot
```bash
pm2 stop polymarket-bot
```

### Delete from PM2
```bash
pm2 delete polymarket-bot
```

### Monitoring
```bash
pm2 monit  # Real-time monitoring dashboard
```

### Show Detailed Info
```bash
pm2 show polymarket-bot
```

### View Next Cron Restart
```bash
pm2 show polymarket-bot | grep "cron restart"
```

## Customizing Restart Schedule

Edit `ecosystem.config.js` and change the `cron_restart` value:

```javascript
// Restart every 3 days at 2 AM
cron_restart: '0 2 */3 * *'

// Restart every Sunday at 4 AM
cron_restart: '0 4 * * 0'

// Restart every 6 hours
cron_restart: '0 */6 * * *'
```

Then reload the configuration:
```bash
pm2 reload ecosystem.config.js
```

## Cron Expression Format

```
* * * * *
│ │ │ │ │
│ │ │ │ └─ Day of week (0-7, 0 and 7 are Sunday)
│ │ │ └─── Month (1-12)
│ │ └───── Day of month (1-31)
│ └─────── Hour (0-23)
└───────── Minute (0-59)
```

### Examples:

- `0 3 * * *` - At 03:00 every day
- `0 */6 * * *` - Every 6 hours
- `0 0 */2 * *` - Every 2 days at midnight
- `30 2 * * 0` - Every Sunday at 02:30
- `0 0 1 * *` - First day of every month at midnight

## Auto-Start on System Reboot

### macOS
```bash
pm2 startup
pm2 save
```

### Linux (systemd)
```bash
pm2 startup systemd
pm2 save
```

### Windows
```bash
pm2-startup install
pm2 save
```

## Advanced Configuration

### Multiple Instances (Cluster Mode)
```javascript
{
    instances: 2,  // Run 2 instances
    exec_mode: 'cluster'
}
```

### Custom Environment Variables
```javascript
{
    env_production: {
        NODE_ENV: 'production',
        FETCH_INTERVAL: '2',
        REQUEST_TIMEOUT_MS: '30000'
    }
}
```

Then start with specific environment:
```bash
pm2 start ecosystem.config.js --env production
```

## Troubleshooting

### Check if PM2 is running
```bash
pm2 status
```

### View error logs
```bash
pm2 logs polymarket-bot --err --lines 50
```

### Restart after code changes
```bash
npm run build
pm2 restart polymarket-bot
```

### Clear logs
```bash
pm2 flush polymarket-bot
```

### Reset restart count
```bash
pm2 reset polymarket-bot
```

## Monitoring & Alerts

### Install PM2 Plus (optional)
For advanced monitoring and alerts:
```bash
pm2 plus
```

This provides:
- Web dashboard
- Email/SMS alerts
- Performance metrics
- Exception tracking

## Production Checklist

- [ ] Build the project: `npm run build`
- [ ] Test locally first: `pm2 start ecosystem.config.js`
- [ ] Check logs: `pm2 logs polymarket-bot`
- [ ] Verify cron schedule: `pm2 show polymarket-bot`
- [ ] Save PM2 config: `pm2 save`
- [ ] Enable auto-startup: `pm2 startup`
- [ ] Create logs directory: `mkdir -p logs`
- [ ] Monitor for first 24 hours: `pm2 monit`

## Disabling Cron Restart

If you want to disable automatic restarts, edit `ecosystem.config.js`:

```javascript
{
    // Remove or comment out this line:
    // cron_restart: '0 3 * * *',

    autorestart: true  // Only restart on crash
}
```

Then reload:
```bash
pm2 reload ecosystem.config.js
```

## References

- [PM2 Documentation](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [PM2 Cron Restart](https://pm2.keymetrics.io/docs/usage/restart-strategies/#cron-restart)
- [Cron Expression Generator](https://crontab.guru/)
