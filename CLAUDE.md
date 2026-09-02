# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Polymarket copy trading bot that monitors successful traders and automatically replicates their trades in real-time. The bot uses MongoDB for persistent storage, polls the Polymarket Data API for trader activity, and executes trades via the Polymarket CLOB Client.

## Core Architecture

### Two-Service Model

The bot runs two concurrent services orchestrated from `src/index.ts`:

1. **Trade Monitor** (`src/services/tradeMonitor.ts`)
   - Polls Polymarket Data API every `FETCH_INTERVAL` seconds (default: 1s)
   - Fetches trade activity from `https://data-api.polymarket.com/activity?user={address}&type=TRADE`
   - Stores new trades in MongoDB with `bot: false, botExcutedTime: 0`
   - Updates trader positions by fetching from Polymarket positions API
   - On first run, marks all historical trades as processed (`bot: true, botExcutedTime: 999`)

2. **Trade Executor** (`src/services/tradeExecutor.ts`)
   - Continuously queries MongoDB for unprocessed trades (`bot: false AND botExcutedTime: 0`)
   - Supports trade aggregation (combines small trades over time window)
   - Immediately marks trades as processing (`botExcutedTime: 1`)
   - Calculates position sizing using copy strategy configuration
   - Executes trades via CLOB client
   - Final marking happens in `postOrder` after successful execution

### MongoDB Collections

Per-trader dynamic collections are created at runtime:
- `user_activity_{address}` - Stores all trader TRADE activities
- `user_position_{address}` - Tracks current positions for each trader

Key fields for trade processing:
- `bot: boolean` - Whether trade has been fully processed
- `botExcutedTime: number` - 0=not started, 1=in progress, 999=historical/skipped

### Position Sizing System

The bot uses a sophisticated copy strategy system defined in `src/config/copyStrategy.ts`:

**Three Strategies:**
1. **PERCENTAGE** - Copy X% of trader's order size (e.g., `COPY_SIZE=10.0` = 10%)
2. **FIXED** - Copy fixed dollar amount per trade (e.g., `COPY_SIZE=50.0` = $50/trade)
3. **ADAPTIVE** - Dynamically adjust percentage based on trade size

**Multipliers:**
- **Tiered Multipliers** - Different multipliers for different trader order sizes
  - Format: `TIERED_MULTIPLIERS="1-10:2.0,10-100:1.0,100-500:0.2,500+:0.1"`
  - Applied based on trader's order size, NOT your calculated size
- **Single Multiplier** - Legacy `TRADE_MULTIPLIER` for uniform scaling

**Calculation Flow** (see `calculateOrderSize` in `src/config/copyStrategy.ts`):
1. Calculate base amount from strategy (PERCENTAGE/FIXED/ADAPTIVE)
2. Apply multiplier (tiered or single) based on trader's order size
3. Cap at `MAX_ORDER_SIZE_USD`
4. Check position limit `MAX_POSITION_SIZE_USD` if configured
5. Reduce to available balance (with 1% safety buffer)
6. Reject if below `MIN_ORDER_SIZE_USD`

### Trade Aggregation

When `TRADE_AGGREGATION_ENABLED=true`:
- Small BUY trades (< $1 minimum) are buffered
- Trades aggregated by user+market+side using key: `{userAddress}:{conditionId}:{asset}:{side}`
- After `TRADE_AGGREGATION_WINDOW_SECONDS` (default: 300s), buffered trades either:
  - Execute as single aggregated order if total >= $1 minimum
  - Skipped entirely if total still < minimum
- Large trades execute immediately without buffering

### Supporting Services (`src/index.ts`)

Beyond the monitor/executor pair, startup also wires up:
- **Health Monitor** (`src/services/healthMonitor.ts`) - periodic health check every `HEALTH_CHECK_INTERVAL_HOURS` (default: 6)
- **Telegram Notifier** (`src/services/telegramNotifier.ts`) - sends startup/shutdown/error alerts when `TELEGRAM_ALERTS_ENABLED=true` (see `docs/TELEGRAM_SETUP.md`)

**Experimental:** `src/services/websocketTradeMonitor.ts` and `src/utils/websocketClient.ts` implement a WebSocket-based alternative to polling (`docs/WEBSOCKET_MODE.md`), but as of this writing are **not imported/wired into `src/index.ts`** — the bot always runs on the polling `tradeMonitor.ts`. Confirm with a grep before assuming WebSocket mode is active.

## Common Development Commands

```bash
# Setup and build
npm run setup              # Interactive setup wizard (creates .env)
npm run build             # TypeScript compilation (lenient)
npm run build:strict      # TypeScript compilation (strict)

# Run the bot
npm start                 # Production (requires build first)
npm run dev              # Development mode (ts-node)

# Testing and validation
npm run test             # Run Jest tests
npm run test:watch       # Jest watch mode
npm run test:coverage    # Coverage report
npm run health-check     # Verify configuration and connectivity

# Code quality
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix ESLint issues
npm run format           # Format with Prettier

# Wallet and position management
npm run check-proxy      # Check your wallet balance
npm run check-stats      # View trading statistics
npm run check-activity   # Recent trading activity
npm run check-allowance  # Check USDC token allowance
npm run set-token-allowance  # Set USDC allowance for trading

# Position management
npm run manual-sell      # Manually sell positions
npm run sell-large       # Sell large positions
npm run close-stale      # Close stale positions
npm run close-resolved   # Close resolved market positions
npm run redeem-resolved  # Redeem winnings from resolved markets

# Trader research and simulation
npm run find-traders     # Find profitable traders to copy
npm run find-low-risk    # Find low-risk traders
npm run scan-traders     # Scan for best traders
npm run scan-markets     # Scan traders from specific markets
npm run discover-traders # Discover new trader candidates
npm run simulate         # Backtest profitability simulation
npm run simulate-old     # Backtest using prior sizing logic (for comparison)
npm run sim              # Run multiple simulations
npm run compare          # Compare simulation results
npm run aggregate        # Aggregate simulation/result data
npm run audit            # Audit copy-trading algorithm (current logic)
npm run audit-old        # Audit copy-trading algorithm (prior logic)

# Additional wallet/position inspection
npm run verify-allowance # Verify USDC allowance is set correctly
npm run set-ctf-allowance # Set CTF (conditional token) allowance
npm run check-trader     # Check a specific trader, optionally sell
npm run check-pnl        # Check for PnL discrepancies
npm run calculate-pnl    # Calculate realized/unrealized PnL
npm run analyze-slippage # Analyze slippage on executed trades
npm run view-trader      # View a trader's trade history
npm run fetch-history    # Fetch historical trades for a trader
npm run transfer-to-gnosis # Transfer positions to a Gnosis Safe
```

## Deployment (PM2)

Production deployment uses PM2 via `ecosystem.config.js`. See `docs/PM2_SETUP.md` and `START_HERE.md` for the full runbook:

```bash
npm run build
pm2 start npm --name "polymarket-bot" -- start
pm2 logs polymarket-bot
pm2 restart polymarket-bot
```

## Important Configuration Details

### Required Environment Variables
- `USER_ADDRESSES` - Comma-separated or JSON array of trader addresses to copy
- `PROXY_WALLET` - Your Polygon wallet address (0x...)
- `PRIVATE_KEY` - Wallet private key (WITHOUT 0x prefix)
- `MONGO_URI` - MongoDB connection string (mongodb:// or mongodb+srv://)
- `RPC_URL` - Polygon RPC endpoint (Infura/Alchemy/Ankr)
- `CLOB_HTTP_URL` - Default: `https://clob.polymarket.com/`
- `CLOB_WS_URL` - Default: `wss://ws-subscriptions-clob.polymarket.com/ws`
- `USDC_CONTRACT_ADDRESS` - Default: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (Polygon USDC)

### Copy Strategy Configuration
- `COPY_STRATEGY` - PERCENTAGE | FIXED | ADAPTIVE (default: PERCENTAGE)
- `COPY_SIZE` - Meaning depends on strategy (default: 10.0)
- `MAX_ORDER_SIZE_USD` - Never exceed this per order (default: 100.0)
- `MIN_ORDER_SIZE_USD` - Skip orders below this (default: 1.0)
- `MAX_POSITION_SIZE_USD` - Optional total position limit
- `TIERED_MULTIPLIERS` - Optional tiered multiplier configuration

### Legacy Configuration (backward compatible)
- `COPY_PERCENTAGE` - Old way to set percentage (use COPY_STRATEGY instead)
- `TRADE_MULTIPLIER` - Old single multiplier (use TIERED_MULTIPLIERS for more control)

### Telegram & Health Monitoring
- `TELEGRAM_ALERTS_ENABLED` - Enable startup/shutdown/error notifications (default: false)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` - Required if alerts enabled (see `docs/TELEGRAM_SETUP.md`)
- `HEALTH_CHECK_INTERVAL_HOURS` - How often `HealthMonitor` re-checks system health (default: 6)

## Key Implementation Details

### First Run Behavior
On initial startup, all historical trades are marked as processed to prevent the bot from attempting to replicate old trades. Only new trades detected after startup will be executed.

### Error Handling and Retries
- Network requests retry up to `NETWORK_RETRY_LIMIT` times (default: 3)
- Request timeout: `REQUEST_TIMEOUT_MS` (default: 10000ms)
- Failed orders retry up to `RETRY_LIMIT` times (default: 3)

### Position Tracking
The bot maintains historical context to accurately track positions even after balance changes. See `src/utils/positionHelpers.ts` for position calculation logic.

### Price Protection
- 1% safety buffer on available balance to prevent insufficient funds errors
- Slippage checks built into order execution
- Price validation before order submission

### Graceful Shutdown
The bot handles SIGTERM/SIGINT signals gracefully:
1. Stops monitor and executor services
2. Waits 2 seconds for operations to finish
3. Closes MongoDB connection
4. Exits cleanly

## Database Schema Notes

When modifying user activity or position models (`src/models/userHistory.ts`):
- Models are created dynamically per trader address
- Collection names include the full address in lowercase
- Changes require careful migration planning as collections exist per trader

## Testing

Run tests with `npm test`. Test files are colocated in `__tests__` directories:
- `src/config/__tests__/` - Configuration tests
- Add new tests alongside source files in `__tests__/` subdirectories

## Scripts Directory

The `src/scripts/` directory contains many utility scripts for:
- Wallet/position inspection (check*, find*, verify*)
- Trading operations (manual-sell, close*, redeem*, sell*)
- Analysis and simulation (simulate*, audit*, aggregate*)
- Setup and health checks (setup, health-check, help)

All scripts can be run via npm scripts defined in package.json.

## When Adding New Features

1. **New copy strategies** - Extend `CopyStrategy` enum and add logic to `calculateOrderSize()`
2. **New trade filters** - Modify trade detection in `tradeMonitor.ts` or execution logic in `tradeExecutor.ts`
3. **New position calculations** - Update `src/utils/positionHelpers.ts`
4. **New environment variables** - Add validation in `src/config/env.ts`
5. **New database fields** - Update interfaces in `src/interfaces/User.ts` and models in `src/models/userHistory.ts`

## Common Pitfalls

1. **Private key format** - Must be without 0x prefix in .env
2. **Address case sensitivity** - All addresses stored in lowercase internally
3. **Minimum order size** - Polymarket requires $1 minimum, trades below this are rejected
4. **First run confusion** - Historical trades are intentionally skipped, not a bug
5. **MongoDB connection string** - Must include database name and proper authentication
6. **Trade aggregation timing** - Buffered trades won't execute until time window expires
7. **`.env.backup` and similar copies** - Any file holding `PRIVATE_KEY` must be gitignored (`.env.backup` is); never `git add -A`/`git add .` without checking `git status` first
8. **`USDC_CONTRACT_ADDRESS` must be USDC.e, not native USDC** - Polymarket's collateral token on Polygon is USDC.e (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`), not native/bridged USDC (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`). Getting this wrong makes `getMyBalance()` and any on-chain `redeemPositions()` call silently/incorrectly report a $0 balance or revert, even when the account is genuinely funded.
9. **EOA vs. proxy wallet: two different addresses, two different query keys** - `PROXY_WALLET` is your CLOB `funderAddress`/on-chain funds custody address; your signing key (`PRIVATE_KEY`) derives a separate EOA address. These may be the *same* address (if trading directly as an EOA with no proxy) or *different* (if Polymarket deployed a proxy contract for you) - both are valid Polymarket account configurations. Critically, **`data-api.polymarket.com`'s `/positions`, `/activity`, and `/closed-positions` endpoints are keyed by the EOA address, not `PROXY_WALLET`** - querying them with `PROXY_WALLET` when the two addresses differ silently returns empty results. Use `MY_EOA_ADDRESS` from `src/utils/getMyEOA.ts` (derived from `PRIVATE_KEY`) for these endpoints; keep using `PROXY_WALLET` for CLOB balance/allowance checks and `funderAddress` in order signing, where it's correct.
