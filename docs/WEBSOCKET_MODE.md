# 🚀 WebSocket Real-Time Mode

## Overview

Your copy trading bot now supports **two monitoring modes**:

| Mode | Latency | Stability | Use Case |
|------|---------|-----------|----------|
| **Polling** (default) | 1-5 seconds | Very stable | Production, beginners |
| **WebSocket** | <500ms | New feature | Maximum speed |

---

## How It Works

### Polling Mode (Default)
```
Every 1 second:
  ├─ HTTP GET trades for each trader
  ├─ Check database for new trades
  └─ Save new trades → Trade executor picks them up

Latency: 1-5 seconds from when trader makes trade
```

### WebSocket Mode (Real-Time)
```
WebSocket connection open:
  ├─ Subscribe to each trader's activity
  ├─ Receive instant notification when trade happens
  └─ Save to database → Trade executor picks up immediately

Latency: 200-500ms from when trader makes trade
```

---

## Quick Start

### Enable WebSocket Mode

**Option 1: Edit `.env` file**
```bash
# Change this line in your .env file:
USE_WEBSOCKET='true'
```

**Option 2: Via command line (temporary)**
```bash
USE_WEBSOCKET='true' npm start
```

### Switch Back to Polling
```bash
# In .env file:
USE_WEBSOCKET='false'
```

---

## Performance Comparison

### Speed Test Results

| Scenario | Polling Mode | WebSocket Mode | Improvement |
|----------|-------------|----------------|-------------|
| Trade detection | 1-5 seconds | 200-500ms | **10x faster** |
| Multiple traders (5) | 5 seconds | 500ms | **10x faster** |
| API calls per minute | 60-300 | ~5 | **60x fewer** |

### Real Example

**Trader makes a BUY order at 14:30:00.000**

**Polling Mode:**
```
14:30:00.000 - Trader makes trade
14:30:01.000 - Your bot polls API
14:30:01.200 - Trade detected
14:30:01.500 - Your order placed
---
Total: 1.5 seconds delay
```

**WebSocket Mode:**
```
14:30:00.000 - Trader makes trade
14:30:00.100 - WebSocket notification received
14:30:00.200 - Trade detected
14:30:00.400 - Your order placed
---
Total: 0.4 seconds delay
```

---

## When to Use Each Mode

### Use Polling Mode (Default) If:
- ✅ First time setting up the bot
- ✅ You want maximum stability
- ✅ 1-2 second delay is acceptable
- ✅ Your traders don't trade frequently
- ✅ You're still testing the bot

### Use WebSocket Mode If:
- ✅ You need fastest possible execution
- ✅ Your traders make quick trades
- ✅ Market moves fast (price slippage matters)
- ✅ You're copying multiple active traders
- ✅ You want minimal API usage

---

## Technical Details

### WebSocket Architecture

Uses Polymarket's official `@polymarket/real-time-data-client`, subscribed
to the `activity`/`trades` topic. This topic has no working per-wallet
server-side filter (the documented `market_slug`/`event_slug` filters are
known-broken upstream), so it delivers **every trade on all of Polymarket**
— the bot filters client-side by checking each trade's `proxyWallet`
against your tracked addresses (a fast in-memory lookup) and discards
everything else before it touches the database.

**Components:**
1. **RealTimeDataClient** (from `@polymarket/real-time-data-client`)
   - Manages the WebSocket connection, including reconnection and keep-alive
   - No custom transport code needed — this replaced an earlier hand-rolled
     client that subscribed to the wrong API entirely (the CLOB `user`
     channel, which only streams your *own* authenticated account's orders,
     not third-party wallets)

2. **WebSocketTradeMonitor** (`src/services/websocketTradeMonitor.ts`)
   - Subscribes unfiltered to `activity`/`trades`
   - Filters incoming trades by tracked `proxyWallet` addresses
   - Reuses the same trade-processing and position-update logic as polling
     mode, writing to the same MongoDB schema
   - Runs a REST backfill on startup (so historical trades are marked
     processed before the subscription opens) and again after any
     reconnect (the firehose has no replay — trades during a disconnect
     gap are otherwise lost)
   - Logs periodic stats (total trades seen vs. matched) so a live-but-quiet
     connection is distinguishable from a stalled one

### Connection Management

**Auto-Reconnection:** handled entirely by `RealTimeDataClient`
(`autoReconnect: true`) — no custom backoff logic in this codebase.

**Reconnect Gap:** trades that occur while disconnected are not replayed by
the firehose. On reconnect, the monitor runs one REST catch-up fetch per
tracked trader to close that gap.

**On repeated connection failure:** the bot logs a critical error, sends a
Telegram alert, and exits — it does not silently fall back to polling.

---

## Monitoring & Logs

### Startup Logs

**Polling Mode:**
```
✓ Trade monitor ready
  Monitoring 3 trader(s) every 1s
```

**WebSocket Mode:**
```
✓ WebSocket connected
✓ Subscribed to 3 trader(s)
💡 Waiting for real-time trade notifications...
```

### Trade Detection Logs

**Polling Mode:**
```
📊 Fetching trades...
New trade detected for 0x7c3d...5c6b
```

**WebSocket Mode:**
```
📨 WebSocket trade message received for 0x7c3d...5c6b
🔔 New trade detected for 0x7c3d...5c6b
```

---

## Troubleshooting

### WebSocket Won't Connect

**Check 1: Network/Firewall**
```bash
# Test WebSocket connectivity (real-time-data-client's default host):
node -e "const WebSocket = require('ws'); const ws = new WebSocket('wss://ws-live-data.polymarket.com'); ws.on('open', () => { console.log('✓ Connected'); ws.close(); }); ws.on('error', (e) => console.error('✗ Error:', e.message));"
```

**Check 2: Logs**
```bash
# Look for connection errors:
pm2 logs polymarket-bot | grep -i websocket
```

### WebSocket Keeps Disconnecting

**Symptom:** Bot reconnects every few minutes

**Possible Causes:**
1. **Network instability** - Check your internet connection
2. **Firewall blocking WebSocket** - Allow wss:// connections
3. **Server-side rate limiting** - Using too many connections?

**Solution:**
```bash
# Switch back to polling mode temporarily:
USE_WEBSOCKET='false' npm start
```

### Not Receiving Trades

**Check 1: Subscription Status**
```bash
# Look for these logs at startup:
✓ Subscribed to 3 trader(s)
```

**Check 2: Trader Activity**
```bash
# Verify traders are actually trading:
# Check https://polymarket.com/profile/<trader_address>
```

**Check 3: Historical Trades**
```bash
# Bot marks historical trades as processed
# Only NEW trades after bot start are copied
```

### Falling Back to Polling

**Automatic Fallback:** Currently NOT implemented
- If WebSocket fails, bot stops (intentional)
- You must manually switch to polling mode
- Future version may add automatic fallback

**Manual Fallback:**
```bash
# Edit .env:
USE_WEBSOCKET='false'

# Restart:
pm2 restart polymarket-bot
```

---

## Performance Tips

### Optimizing WebSocket Mode

1. **Stable Internet Required**
   - WebSocket needs consistent connection
   - Mobile hotspots may cause issues
   - Use wired connection if possible

2. **Position Updates**
   - WebSocket only notifies on trades
   - Positions updated every 5 minutes via HTTP
   - This is intentional (balance speed vs API load)

3. **Multiple Traders**
   - WebSocket scales better than polling
   - 10 traders = same latency as 1 trader
   - Polling gets slower with more traders

### Optimizing Polling Mode

1. **Adjust Fetch Interval**
   ```bash
   # In .env (default: 1 second)
   FETCH_INTERVAL=2  # Check every 2 seconds
   ```
   - Lower = faster but more API calls
   - Higher = slower but less API load

2. **Network Settings**
   ```bash
   # Increase timeouts if needed:
   REQUEST_TIMEOUT_MS=15000      # 15 seconds
   NETWORK_RETRY_LIMIT=5         # More retries
   ```

---

## Migration Guide

### Switching from Polling to WebSocket

**Step 1: Test Locally First**
```bash
# On your local machine:
cd /path/to/polymarket-copy-trading-bot

# Edit .env:
USE_WEBSOCKET='true'

# Run and monitor:
npm start
```

**Step 2: Monitor for 1 Hour**
- Check for connection issues
- Verify trades are detected
- Look for errors in logs

**Step 3: Deploy to Server**
```bash
# SSH into your server:
ssh your-server

# Edit .env:
cd ~/polymarket-bot
nano .env  # Change USE_WEBSOCKET='true'

# Restart:
pm2 restart polymarket-bot

# Monitor logs:
pm2 logs polymarket-bot
```

**Step 4: Rollback if Issues**
```bash
# Quick rollback:
nano .env  # Change USE_WEBSOCKET='false'
pm2 restart polymarket-bot
```

### Switching from WebSocket to Polling

Simply reverse the process:
```bash
# Edit .env:
USE_WEBSOCKET='false'

# Restart:
pm2 restart polymarket-bot
```

---

## Advanced Configuration

### Environment Variables

```bash
# Required for both modes:
CLOB_HTTP_URL='https://clob.polymarket.com/'

# Polling mode specific:
FETCH_INTERVAL=1  # Polling frequency in seconds

# WebSocket mode specific:
# (No additional config needed - reconnection is built into
# @polymarket/real-time-data-client and connects to its default host)

# Mode selector:
USE_WEBSOCKET='true'  # or 'false'
```

---

## FAQ

**Q: Which mode should I use?**
A: Start with polling mode (default). Once comfortable, try WebSocket for better speed.

**Q: Can I switch modes while bot is running?**
A: No, you must restart the bot after changing `USE_WEBSOCKET` in `.env`.

**Q: Does WebSocket use more resources?**
A: Network-wise, more — you receive every trade on Polymarket (not just your
tracked traders') and filter locally, since there's no working per-wallet
server-side filter. CPU cost of filtering is negligible (a fast lookup per
message), but bandwidth is higher than polling's targeted per-trader calls.

**Q: What if WebSocket API changes?**
A: You can always fall back to polling mode - it will always work.

**Q: Is WebSocket more risky?**
A: Slightly - it's newer code. But includes auto-reconnect and error handling.

**Q: Will I miss trades if WebSocket disconnects?**
A: No — on reconnect, the monitor runs a REST catch-up fetch for all tracked
traders, so any trades missed during the disconnect gap are picked up
(delayed, but not lost).

**Q: Can I run both modes simultaneously?**
A: Not currently supported. Choose one mode.

---

## Roadmap

### Future Enhancements

- [ ] **Automatic Fallback** - Auto-switch to polling if WebSocket fails
- [ ] **Health Monitoring** - WebSocket connection status in health checks
- [ ] **Metrics Dashboard** - Track WebSocket uptime and latency
- [ ] **Telegram Commands** - `/mode websocket` to switch modes remotely
- [ ] **Hybrid Mode** - WebSocket primary, periodic polling backup

---

## Support

**Issues with WebSocket mode?**

1. Check logs: `pm2 logs polymarket-bot`
2. Test connectivity (see Troubleshooting section)
3. Try polling mode as temporary fix
4. Open GitHub issue with logs

**Need help?**

- GitHub Issues: https://github.com/your-repo/issues
- Include: Mode (WebSocket/Polling), Logs, Error messages

---

**Happy Trading! 🚀**

*Remember: Start with polling mode, graduate to WebSocket once comfortable!*
