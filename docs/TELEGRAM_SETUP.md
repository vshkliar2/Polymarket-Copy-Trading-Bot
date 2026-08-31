# 📱 Telegram Alerts Setup Guide

Get real-time notifications about your bot's trading activity directly on your phone!

## Features

### What You'll Receive

- 🟢 **Trade Alerts** - Instant notifications when bot copies a trade (BUY and SELL)
- ❌ **Error Alerts** - Critical errors and issues
- 📊 **Health Checks** - Periodic bot status updates (default: every 6 hours)
- 🤖 **Startup/Shutdown** - Bot lifecycle notifications
- 🚨 **Health Status Changes** - Alerts when bot becomes unhealthy or recovers

### Example Notifications

**Trade Alert:**
```
🟢 BUY Order ✅

Market: Trump wins 2024
Side: BUY
Amount: $45.23
Price: $0.780

Copied from: 0x7c3d...
Time: 2026-01-07 14:23:15
```

**Error Alert:**
```
❌ Critical Error

Severity: CRITICAL
Message: MongoDB connection lost

Time: 2026-01-07 14:25:30
```

**Health Check:**
```
📊 Health Check

Overall: ✅ HEALTHY

Services:
✅ MongoDB
✅ RPC Connection

Wallet:
💰 Balance: $421.50
📈 Open Positions: 3

Uptime: 12h 34m
Time: 2026-01-07 14:30:00
```

---

## Setup (5 Minutes)

### Step 1: Create Telegram Bot

1. **Open Telegram** and search for: `@BotFather`

2. **Start chat** and send: `/newbot`

3. **Choose name** for your bot (displayed in contact list):
   ```
   Polymarket Copy Bot
   ```

4. **Choose username** (must end in 'bot'):
   ```
   polymarket_copy_bot
   ```
   *If taken, try: `your_name_polymarket_bot`*

5. **Save the token** BotFather gives you:
   ```
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```

   ⚠️ **Keep this token secret!** It's like a password.

### Step 2: Get Your Chat ID

1. **Click the link** BotFather sent you to start chat with your bot

2. **Send any message** to your bot:
   ```
   Hello
   ```

3. **Open this URL** in your browser (replace `<YOUR_TOKEN>`):
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```

   Example:
   ```
   https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz/getUpdates
   ```

4. **Find your Chat ID** in the response:
   ```json
   {
     "ok": true,
     "result": [{
       "update_id": 123456789,
       "message": {
         "message_id": 1,
         "from": {...},
         "chat": {
           "id": 987654321,  ← This is your Chat ID
           "first_name": "Your Name",
           "type": "private"
         },
         "date": 1234567890,
         "text": "Hello"
       }
     }]
   }
   ```

   Your Chat ID: `987654321`

### Step 3: Add to Your .env File

Open your `.env` file and add these lines:

```bash
# Telegram Alerts
TELEGRAM_BOT_TOKEN='123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
TELEGRAM_CHAT_ID='987654321'
TELEGRAM_ALERTS_ENABLED='true'

# Optional: Health check frequency (default: 6 hours)
HEALTH_CHECK_INTERVAL_HOURS='6'
```

**Replace with your actual values!**

**Health Check Options:**
- `1` = Every hour (very frequent)
- `6` = Every 6 hours (recommended)
- `12` = Twice daily
- `24` = Once daily

### Step 4: Install Dependencies

**On your local machine:**

```bash
cd /path/to/polymarket-copy-trading-bot

# Install Telegram package
npm install node-telegram-bot-api
npm install --save-dev @types/node-telegram-bot-api

# Rebuild
npm run build
```

**On your server (if deployed):**

```bash
# Pull latest changes
cd ~/polymarket-bot
git pull

# Install dependencies
npm install

# Rebuild
npm run build

# Restart bot
pm2 restart polymarket-bot
```

### Step 5: Test It!

**Restart your bot:**

```bash
# Local
npm start

# Server
pm2 restart polymarket-bot
```

**You should receive a startup notification:**
```
🤖 Bot Started

Status: Online
Time: 2026-01-07 15:00:00
Wallet: 0x6242874...

The bot is now monitoring trades.
```

🎉 **Success!** You're now receiving alerts!

---

## Troubleshooting

### Not Receiving Messages?

**1. Check Bot Token**
```bash
# Test your token with curl
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"

# Should return bot info, not error
```

**2. Check Chat ID**
```bash
# Make sure you got the right Chat ID
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"

# Look for "chat":{"id":YOUR_CHAT_ID}
```

**3. Check .env File**
```bash
cat .env | grep TELEGRAM

# Should show:
# TELEGRAM_BOT_TOKEN='...'
# TELEGRAM_CHAT_ID='...'
# TELEGRAM_ALERTS_ENABLED='true'
```

**4. Check Bot Logs**
```bash
# Local
npm start

# Server
pm2 logs polymarket-bot

# Look for:
# ✅ Telegram notifier initialized
```

### Bot Says "Telegram alerts disabled"

Make sure `TELEGRAM_ALERTS_ENABLED='true'` (with quotes!)

```bash
# In .env file:
TELEGRAM_ALERTS_ENABLED='true'  # Correct
TELEGRAM_ALERTS_ENABLED=true    # Won't work!
```

### Bot Says "TOKEN or CHAT_ID missing"

Check your .env file has both:
```bash
TELEGRAM_BOT_TOKEN='123456789:ABC...'
TELEGRAM_CHAT_ID='987654321'
```

Both must be in quotes and not empty!

### Still Not Working?

1. **Rebuild the bot:**
   ```bash
   npm run build
   ```

2. **Check logs for errors:**
   ```bash
   pm2 logs polymarket-bot --err
   ```

3. **Test manually:**
   ```bash
   node
   ```
   Then in Node REPL:
   ```javascript
   const TelegramBot = require('node-telegram-bot-api');
   const bot = new TelegramBot('YOUR_TOKEN', {polling: false});
   bot.sendMessage('YOUR_CHAT_ID', 'Test message');
   ```

---

## Disable Alerts Temporarily

To temporarily disable alerts without removing configuration:

```bash
# In .env file:
TELEGRAM_ALERTS_ENABLED='false'
```

Then restart bot:
```bash
pm2 restart polymarket-bot
```

---

## Security Notes

⚠️ **Important Security Tips:**

1. **Never share your bot token** - It's like your password
2. **Don't commit .env file** - It's in `.gitignore` for a reason
3. **Rotate token if exposed** - Ask @BotFather to generate new token with `/revoke`
4. **Use private bot only** - Don't add to groups unless you trust all members

---

## Advanced: Customize Notifications

Want to customize what alerts you receive? Edit `src/services/telegramNotifier.ts`:

**Example: Only send trade alerts above $50:**

```typescript
// In notifyTrade function:
async notifyTrade(trade: {...}): Promise<void> {
    // Only notify for trades above $50
    if (trade.amount < 50) {
        return;
    }

    // ... rest of function
}
```

**Example: Add custom emoji:**

```typescript
const emoji = trade.side === 'BUY' ? '💰' : '💸';
```

---

## What's Next?

Future features (coming soon):

- 📊 Daily summary reports
- 📈 Performance analytics
- 💬 Interactive commands (`/status`, `/balance`, `/positions`)
- ⚙️ Configure alerts via Telegram
- 🔔 Custom alert rules

---

## Support

Having issues?

1. Check this guide thoroughly
2. Review logs: `pm2 logs polymarket-bot`
3. Test token and chat ID with curl commands above
4. Open GitHub issue with error details

---

**Happy Trading! 🚀**
