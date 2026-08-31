# 📱 Telegram Alerts - Quick Start

Get Telegram notifications in **5 minutes**!

## Quick Setup

### 1. Create Bot (2 minutes)

1. Open Telegram, search: `@BotFather`
2. Send: `/newbot`
3. Name: `Polymarket Copy Bot`
4. Username: `your_name_polymarket_bot`
5. **Save the token**: `123456789:ABCdef...`

### 2. Get Chat ID (1 minute)

1. Start chat with your bot (click link from BotFather)
2. Send: `Hello`
3. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Find `"chat":{"id":987654321}` - that's your Chat ID

### 3. Configure (1 minute)

Add to `.env`:
```bash
TELEGRAM_BOT_TOKEN='123456789:ABCdef...'
TELEGRAM_CHAT_ID='987654321'
TELEGRAM_ALERTS_ENABLED='true'
```

### 4. Install & Run (1 minute)

```bash
npm install node-telegram-bot-api @types/node-telegram-bot-api
npm run build
npm start  # or pm2 restart polymarket-bot
```

### 5. Done! ✅

You'll receive:
- Trade alerts
- Error notifications
- Health checks
- Startup/shutdown messages

---

## Example Alert

```
🟢 BUY Order ✅

Market: Trump wins 2024
Side: BUY
Amount: $45.23
Price: $0.780

Copied from: 0x7c3d...
Time: 2026-01-07 14:23:15
```

---

## Troubleshooting

**Not receiving messages?**

Check logs:
```bash
pm2 logs polymarket-bot | grep Telegram
```

Should see:
```
✅ Telegram notifier initialized
```

**Still issues?** See [TELEGRAM_SETUP.md](./TELEGRAM_SETUP.md) for detailed troubleshooting.

---

🎉 **You're all set!**
