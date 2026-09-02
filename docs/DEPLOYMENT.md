# Deployment Guide

This guide covers deploying the Polymarket Copy Trading Bot to production environments.

## Prerequisites

- Node.js 18+ or Docker
- MongoDB database (local or MongoDB Atlas)
- Polygon wallet with USDC and POL
- RPC endpoint (Infura, Alchemy, or custom)

> **Deploying on a cloud VM?** Region choice matters for this bot beyond the
> usual latency/cost tradeoffs — Polymarket geoblocks by request IP, and
> several EU regions are "close-only" (can't place new orders) at the API
> level, not just the frontend. See [`docs/GCP_DEPLOYMENT.md`](./GCP_DEPLOYMENT.md)
> for a full GCP walkthrough including which regions actually work.

## Deployment Options

### Option 1: Docker (Recommended)

#### Using Docker Compose

1. **Clone and configure:**

```bash
git clone <repository-url>
cd polymarket-copy-trading-bot
cp .env.example .env
# Edit .env with your configuration
```

2. **Update MongoDB URI in .env:**

```bash
# For local MongoDB (docker-compose)
MONGO_URI=mongodb://mongodb:27017/polymarket_copytrading

# For MongoDB Atlas
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/database
```

3. **Start services:**

```bash
docker-compose up -d
```

4. **View logs:**

```bash
docker-compose logs -f bot
```

5. **Stop services:**

```bash
docker-compose down
```

#### Using Docker Only

```bash
# Build image
docker build -t polymarket-bot .

# Run container
docker run -d \
  --name polymarket-bot \
  --restart unless-stopped \
  --env-file .env \
  polymarket-bot
```

### Option 2: Direct Node.js Deployment

#### On Linux Server (systemd)

1. **Install dependencies:**

```bash
npm ci --production
npm run build
```

2. **Create systemd service** (`/etc/systemd/system/polymarket-bot.service`):

```ini
[Unit]
Description=Polymarket Copy Trading Bot
After=network.target mongod.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/polymarket-copy-trading-bot
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

3. **Enable and start:**

```bash
sudo systemctl enable polymarket-bot
sudo systemctl start polymarket-bot
sudo systemctl status polymarket-bot
```

4. **View logs:**

```bash
sudo journalctl -u polymarket-bot -f
```

#### On VPS (PM2)

1. **Install PM2:**

```bash
npm install -g pm2
```

2. **Start application:**

```bash
npm run build
pm2 start dist/index.js --name polymarket-bot
pm2 save
pm2 startup
```

3. **Monitor:**

```bash
pm2 status
pm2 logs polymarket-bot
pm2 monit
```

### Discovery Workers (Optional)

Two additional PM2 processes propose new trader candidates for review —
neither ever trades or auto-adds anyone; both send a Telegram alert with
Approve/Reject buttons for you to act on.

```bash
# Start all three processes (bot + both workers) at once:
pm2 start ecosystem.config.js

# Or start workers individually:
pm2 start ecosystem.config.js --only discovery-worker
pm2 start ecosystem.config.js --only new-wallet-worker

# View worker logs:
pm2 logs discovery-worker
pm2 logs new-wallet-worker
```

#### Approval is manual — nothing is auto-followed

Both workers **only propose candidates**. A discovered address is written to
`tracked_traders` with status `pending` and never starts being copied on its
own. To actually follow one, an operator must act in Telegram:

- `/pending` — list candidates awaiting review
- Tap **✅ Approve** on the alert (or run `/add <address>`) — this is the only
  path that sets a trader to `active`
- Tap **❌ Reject** (or run `/remove <address>`) — marks it `rejected` and
  drains any trades already queued for that address

If nobody reviews them, candidates sit in `pending` indefinitely. Check
`/pending` regularly, or the workers do nothing useful for you.

#### Known issue: `discovery-worker` currently finds nothing

Polymarket's leaderboard API (`https://data-api.polymarket.com/leaderboard`)
returns **HTTP 404** as of this writing. `discovery-worker` runs correctly but
will report zero candidates until Polymarket restores that endpoint. This is a
known upstream issue, not a bug in this bot, and needs no action here.

`new-wallet-worker` is **unaffected** — it uses a different, working endpoint
and will keep proposing candidates normally.

#### Telegram command listener

`TELEGRAM_COMMAND_LISTENER_ENABLED` must be `true` for the main
`polymarket-bot` app **only** — never for `discovery-worker` or
`new-wallet-worker`. Telegram permits exactly one `getUpdates` long-poll
consumer per bot token; if more than one process polls, they collide with HTTP
409 Conflict errors and your `/add`, `/remove` and Approve/Reject taps are
delivered to a random process or lost outright.

`ecosystem.config.js` already sets it for `polymarket-bot` only, so under PM2
this is handled. If you run the processes some other way (systemd, Docker,
plain `node`), make sure only the main bot process gets the variable — the
workers are send-only and never need to receive commands.

See `docs/superpowers/specs/2026-08-31-dynamic-trader-management-design.md`
for the full design.

## Environment Configuration

### Required Variables

Ensure all required variables are set in `.env`:

- `USER_ADDRESSES` - Traders to copy
- `PROXY_WALLET` - Your trading wallet
- `PRIVATE_KEY` - Wallet private key
- `MONGO_URI` - MongoDB connection string
- `RPC_URL` - Polygon RPC endpoint
- `CLOB_HTTP_URL` - Polymarket CLOB HTTP endpoint
- `CLOB_WS_URL` - Polymarket CLOB WebSocket endpoint
- `USDC_CONTRACT_ADDRESS` - USDC contract on Polygon

### Security Best Practices

1. **Never commit `.env` file** - It's already in `.gitignore`
2. **Use environment variables in production** - Don't store secrets in files
3. **Restrict file permissions:**

```bash
chmod 600 .env
```

4. **Use secrets management** - Consider using:
    - AWS Secrets Manager
    - HashiCorp Vault
    - Kubernetes Secrets
    - Docker Secrets

## Health Checks

### Manual Health Check

```bash
npm run health-check
```

### Automated Monitoring

Set up monitoring to check:

1. **Process status** - Is the bot running?
2. **Health check endpoint** - (if implemented)
3. **MongoDB connection** - Database connectivity
4. **RPC endpoint** - Blockchain connectivity
5. **USDC balance** - Sufficient funds

### Example Monitoring Script

```bash
#!/bin/bash
# health-monitor.sh

if ! pgrep -f "node.*dist/index.js" > /dev/null; then
    echo "Bot process not running!"
    # Restart or alert
fi

npm run health-check || echo "Health check failed!"
```

## Logging

### Log Locations

- **Docker:** `docker-compose logs bot`
- **systemd:** `journalctl -u polymarket-bot`
- **PM2:** `pm2 logs polymarket-bot`

### Log Rotation

Configure log rotation to prevent disk space issues:

```bash
# /etc/logrotate.d/polymarket-bot
/path/to/polymarket-bot/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

## Backup and Recovery

### MongoDB Backup

```bash
# Backup
mongodump --uri="mongodb://localhost:27017/polymarket_copytrading" --out=/backup/$(date +%Y%m%d)

# Restore
mongorestore --uri="mongodb://localhost:27017/polymarket_copytrading" /backup/20240101
```

### Docker Volume Backup

```bash
# Backup MongoDB volume
docker run --rm -v polymarket-copy-trading-bot_mongodb-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/mongodb-backup.tar.gz /data

# Restore
docker run --rm -v polymarket-copy-trading-bot_mongodb-data:/data -v $(pwd):/backup \
  alpine tar xzf /backup/mongodb-backup.tar.gz -C /
```

## Scaling Considerations

### Single Instance

- Suitable for personal use
- Handles multiple traders
- Simple deployment

### Multiple Instances (Advanced)

⚠️ **Warning:** Running multiple instances requires careful coordination:

- Use distributed locking (Redis)
- Ensure only one instance processes trades
- Coordinate MongoDB access
- Consider message queue (RabbitMQ, Redis)

## Troubleshooting

### Bot Not Starting

1. Check environment variables:

```bash
npm run health-check
```

2. Verify MongoDB connection:

```bash
mongosh "mongodb://your-connection-string"
```

3. Check RPC endpoint:

```bash
curl -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  $RPC_URL
```

### Trades Not Executing

1. Check USDC balance:

```bash
npm run check-allowance
```

2. Verify trader addresses are active
3. Check logs for errors
4. Ensure sufficient POL for gas

### High Memory Usage

- Reduce `FETCH_INTERVAL` if too low
- Limit number of traders
- Monitor MongoDB connection pool
- Consider increasing Node.js memory limit:

```bash
NODE_OPTIONS="--max-old-space-size=2048" node dist/index.js
```

## Auto-Deploy Setup (Recommended for PM2)

Set up automatic deployment that pulls changes from GitHub and restarts the bot when updates are detected.

### Step 1: Copy Auto-Deploy Script

```bash
# Copy script to home directory
cp scripts/auto-deploy.sh ~/auto-deploy.sh
chmod +x ~/auto-deploy.sh
```

### Step 2: Test Script

```bash
# Test manually
~/auto-deploy.sh

# Should show:
# No changes detected. Bot is up to date.
```

### Step 3: Set Up Cron Job

```bash
crontab -e
```

Add this line to run every 5 minutes:

```bash
*/5 * * * * /home/ubuntu/auto-deploy.sh >> /home/ubuntu/deploy.log 2>&1
```

**Schedule options:**
- `*/1 * * * *` - Every 1 minute (aggressive)
- `*/5 * * * *` - Every 5 minutes (recommended)
- `*/15 * * * *` - Every 15 minutes (conservative)

### Step 4: Verify Setup

```bash
# Check cron job
crontab -l

# Wait 5 minutes or trigger manually
~/auto-deploy.sh

# View deployment log
tail -f ~/deploy.log
```

### Auto-Deploy Features

The script automatically:
- ✅ Detects changes from GitHub
- ✅ Pulls latest code
- ✅ Only rebuilds if `package.json` changed
- ✅ Restarts bot only when changes detected
- ✅ Preserves `.env` file (uses git stash)
- ✅ Logs all deployment activity

### Monitor Deployments

```bash
# View real-time deployment log
tail -f ~/deploy.log

# View last deployment
tail -n 50 ~/deploy.log

# Check bot status after deploy
pm2 status
pm2 logs polymarket-bot --lines 20
```

### Workflow with Auto-Deploy

```bash
# 1. On local machine: make changes
git add .
git commit -m "your changes"
git push origin main

# 2. On server: changes auto-deploy within 5 minutes
# No manual intervention needed!

# 3. Monitor deployment
ssh your-server "tail -f ~/deploy.log"
```

## Updates and Maintenance

### Manual Updates (Without Auto-Deploy)

1. **Pull latest changes:**

```bash
git pull origin main
```

2. **Rebuild:**

```bash
npm ci
npm run build
```

3. **Restart:**

```bash
# Docker
docker-compose restart bot

# systemd
sudo systemctl restart polymarket-bot

# PM2
pm2 restart polymarket-bot
```

### Updating from Upstream (If Forked)

If you forked the repository and want to pull updates from the original:

```bash
# Add upstream remote (one-time)
git remote add upstream https://github.com/earthskyorg/polymarket-copy-trading-bot.git

# Fetch and merge updates
git fetch upstream
git merge upstream/main

# Push to your fork
git push origin main

# Auto-deploy will handle deployment (if set up)
```

### Zero-Downtime Updates

For production, use rolling updates:

1. Deploy new version alongside old
2. Verify health
3. Switch traffic
4. Stop old version

## Performance Tuning

### Recommended Settings

- **FETCH_INTERVAL:** 1-3 seconds (balance speed vs API load)
- **RETRY_LIMIT:** 3 (sufficient for transient errors)
- **REQUEST_TIMEOUT_MS:** 10000 (10 seconds)

### Resource Requirements

- **CPU:** 1-2 cores
- **RAM:** 512MB - 1GB
- **Disk:** 10GB (for MongoDB data)
- **Network:** Stable connection to Polygon RPC

## Security Checklist

- [ ] `.env` file has restricted permissions (600)
- [ ] Private keys are not logged
- [ ] MongoDB is not exposed to public internet
- [ ] RPC endpoint uses HTTPS
- [ ] Regular security updates applied
- [ ] Firewall configured (if applicable)
- [ ] Monitoring and alerting set up

## Support

For issues or questions:

1. Check [Troubleshooting](#troubleshooting) section
2. Review logs for error messages
3. Run health check: `npm run health-check`
4. Open GitHub issue with:
    - Error logs
    - Configuration (redacted)
    - Steps to reproduce
