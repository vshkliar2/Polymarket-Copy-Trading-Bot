#!/bin/bash

# Auto-deploy script for Polymarket Copy Trading Bot
# Pulls latest changes from GitHub and restarts bot ONLY if changes detected

# Configuration
BOT_DIR="$HOME/polymarket-bot"
LOG_FILE="$HOME/deploy.log"
BRANCH="main"

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 24 > /dev/null 2>&1

# Timestamp for logging
timestamp() {
    date "+%Y-%m-%d %H:%M:%S"
}

# Log function
log() {
    echo "[$(timestamp)] $1" | tee -a "$LOG_FILE"
}

# Navigate to bot directory
cd "$BOT_DIR" || {
    log "ERROR: Bot directory not found: $BOT_DIR"
    exit 1
}

log "=== Starting auto-deploy check ==="

# Fetch latest changes from remote
git fetch origin "$BRANCH" > /dev/null 2>&1

# Check if there are changes
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})

if [ "$LOCAL" = "$REMOTE" ]; then
    log "No changes detected. Bot is up to date."
    exit 0
fi

log "📥 Changes detected! Starting deployment..."
log "Commits to pull:"
git log --oneline $LOCAL..$REMOTE | tee -a "$LOG_FILE"

# Stash any local changes (like .env modifications)
log "Stashing local changes..."
git stash > /dev/null 2>&1

# Pull latest changes and capture output
log "Pulling latest changes..."
PULL_OUTPUT=$(git pull origin "$BRANCH" 2>&1)
PULL_EXIT_CODE=$?

echo "$PULL_OUTPUT" | tee -a "$LOG_FILE"

if [ $PULL_EXIT_CODE -ne 0 ]; then
    log "❌ ERROR: Git pull failed!"
    git stash pop > /dev/null 2>&1
    exit 1
fi

# Check if pull actually brought changes (not just "Already up to date")
if echo "$PULL_OUTPUT" | grep -q "Already up to date"; then
    log "No new changes after pull. Skipping restart."
    git stash pop > /dev/null 2>&1
    exit 0
fi

# Restore local changes (like .env)
log "Restoring local changes..."
git stash pop > /dev/null 2>&1

# Check if package.json changed (need to reinstall dependencies)
if echo "$PULL_OUTPUT" | grep -q "package.json"; then
    log "📦 package.json changed. Installing dependencies..."
    npm install 2>&1 | tee -a "$LOG_FILE"

    if [ $? -ne 0 ]; then
        log "❌ ERROR: npm install failed!"
        exit 1
    fi
else
    log "⏭️  No dependency changes. Skipping npm install."
fi

# Build the project
log "🔨 Building project..."
npm run build 2>&1 | tee -a "$LOG_FILE"

if [ $? -ne 0 ]; then
    log "❌ ERROR: Build failed!"
    exit 1
fi

# Restart bot with PM2
log "🔄 Restarting bot..."
pm2 restart polymarket-bot 2>&1 | tee -a "$LOG_FILE"

if [ $? -ne 0 ]; then
    log "❌ ERROR: PM2 restart failed!"
    exit 1
fi

log "✅ Deployment successful!"
log "🤖 Bot restarted with latest changes"
log "=== Auto-deploy completed ==="

# Keep last 1000 lines of log
tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

exit 0
