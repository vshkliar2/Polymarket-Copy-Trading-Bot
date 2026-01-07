#!/bin/bash

# Polymarket Bot - Safe Update Script
# Usage: ./update.sh

echo "🔄 Starting safe bot update..."

# Stop the bot
echo "⏹️  Stopping bot..."
pm2 stop polymarket-bot 2>/dev/null || echo "Bot not running with PM2"

# Pull latest changes (if using git)
if [ -d .git ]; then
    echo "📥 Pulling latest changes..."
    git pull
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Run tests (if any)
# echo "🧪 Running tests..."
# npm test

# Restart the bot
echo "▶️  Restarting bot..."
pm2 restart polymarket-bot || pm2 start npm --name "polymarket-bot" -- start

# Show status
echo ""
echo "✅ Update complete!"
pm2 status polymarket-bot
echo ""
echo "📊 View logs: pm2 logs polymarket-bot"
