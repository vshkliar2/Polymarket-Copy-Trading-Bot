# Dynamic Trader Management — Design Spec

## Problem

`USER_ADDRESSES` is a static `.env` value read once at process boot. Adding
or removing a tracked trader today requires editing `.env` and restarting
the bot (`pm2 restart`). There is also no way to discover new traders and
act on that discovery without manually copying an address into `.env`.

This spec covers moving the tracked-trader list into MongoDB so it can be
managed dynamically, adding two background discovery jobs that propose new
candidates, and extending the existing Telegram bot into an interactive
interface for reviewing and managing the list — all without restarting the
bot.

## Goals

- Add/remove tracked traders at runtime, picked up by the running bot
  without a restart.
- Discover new trader candidates automatically via two independent signals:
  a periodic leaderboard scan, and a real-time "new wallet made an outsized
  first trade" detector.
- Review and approve/reject discovered candidates via Telegram, including
  manual add/remove/list commands.
- No discovered candidate is ever auto-followed — every addition to the
  active list requires explicit human approval.

## Non-goals

- Automatically closing or adjusting positions when a trader is removed
  from tracking (existing positions are left as-is; managed via existing
  scripts like `manual-sell`/`close-stale`).
- Multi-operator authorization — Telegram commands are restricted to the
  single configured `TELEGRAM_CHAT_ID`, matching current usage (one
  operator).
- Real-time (sub-minute) propagation of trader-list changes — a
  ~60-second polling refresh is fine, since additions/removals are
  human-driven, not latency-sensitive.
- Replacing or deprecating the existing `USER_ADDRESSES` env var validation
  in `env.ts` — it remains as a one-time migration seed only.

## Data model

### `tracked_traders` collection

```typescript
interface TrackedTrader {
  address: string; // lowercase, unique index
  status: 'active' | 'pending' | 'rejected';
  source: 'manual' | 'discovered_leaderboard' | 'discovered_new_wallet';
  addedAt: Date;
  addedBy?: string; // Telegram user id, for manual adds/approvals
  discoveryMeta?: {
    score?: number; // discoverTraders.ts's 0-100 weighted score
    firstTradeSize?: number; // USD, for discovered_new_wallet only
    reason: string; // human-readable summary shown in the Telegram alert
  };
}
```

Only `status: 'active'` rows are monitored/copied. `pending` rows are
awaiting human review. `rejected` rows are kept (not deleted) so the same
address isn't re-alerted after a manual rejection.

### `seen_wallets` collection (new-wallet detector only)

```typescript
interface SeenWallet {
  address: string; // lowercase, unique index
  firstSeenAt: Date; // TTL-indexed: expireAfterSeconds bounds the rolling window
}
```

A wallet absent from this collection is treated as "new." The TTL window
(30-90 days, configurable) bounds storage growth; a wallet silent for
longer than the window and then trading again is treated as new once more
— an accepted tradeoff for bounded storage over perfect precision.

### One-time migration

On first boot after this change, if `tracked_traders` is empty and
`USER_ADDRESSES` is set, seed the collection from it
(`source: 'manual'`, `status: 'active'`, `addedAt: now`). This runs once;
`.env`'s `USER_ADDRESSES` is not read again after the seed completes.

`env.ts`'s `validateRequiredEnv()` currently throws at startup if
`USER_ADDRESSES` is missing. This spec changes that requirement:
`USER_ADDRESSES` becomes optional (used only for the one-time seed if
present); a genuinely fresh install with an empty `tracked_traders`
collection and no `USER_ADDRESSES` set should start successfully with zero
tracked traders, not fail at boot — traders are then added via `/add` or
approved discoveries.

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│ discoveryWorker.ts   │     │ newWalletWorker.ts    │
│ (PM2 process)        │     │ (PM2 process)         │
│ - leaderboard scan   │     │ - WS firehose         │
│ - every 6-24h        │     │ - checks seen_wallets │
│ writes: pending rows │     │ writes: pending rows  │
└──────────┬───────────┘     └───────────┬───────────┘
           │                             │
           ▼                             ▼
   ┌──────────────────────────────────────────┐
   │         tracked_traders (MongoDB)          │
   │  status: active | pending | rejected       │
   └──────────────────┬─────────────────────────┘
                       │ polled every ~60s
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
  tradeMonitor.ts  websocketTradeMonitor.ts  tradeExecutor.ts
  (reads active traders, adds/removes Mongoose models live)

   ┌──────────────────────────────────────────┐
   │       telegramNotifier.ts (extended)       │
   │  polling: true                             │
   │  /list /add /remove /pending               │
   │  inline Approve/Reject buttons             │
   │  reads/writes tracked_traders directly      │
   └──────────────────────────────────────────┘
```

## Components

### `src/services/trackedTraders.ts` (new, shared)

- `getActiveTraderAddresses(): Promise<string[]>` — queries
  `tracked_traders` for `status: 'active'`.
- `refreshTrackedModels(currentModels: Map<string, ModelConfig>): Promise<Map<string, ModelConfig>>`
  — diffs the current in-memory model map against the latest active list;
  builds new Mongoose models (via existing `getUserActivityModel`/
  `getUserPositionModel`) for newly-active addresses, drops entries for
  addresses no longer active.
- Used by `tradeMonitor.ts`, `websocketTradeMonitor.ts`, and
  `tradeExecutor.ts`, each adding a `setInterval` (default 60s, configurable
  via a new `TRACKED_TRADERS_REFRESH_SECONDS` env var) that calls
  `refreshTrackedModels` and replaces its local model map/list.

### `telegramNotifier.ts` (extended)

- Constructed with `polling: true` (was `false`) when
  `TELEGRAM_ALERTS_ENABLED` is true.
- New message handler restricted to `msg.chat.id === TELEGRAM_CHAT_ID`;
  anything else is ignored (no reply, no error leak).
- Commands: `/list`, `/add <address>`, `/remove <address>`, `/pending`.
- `callback_query` handler for inline Approve/Reject buttons on discovery
  alerts, updating the corresponding `tracked_traders` row.
- All DB reads/writes go through `trackedTraders.ts` helper functions, not
  ad-hoc queries in the bot handler.

### `src/discoveryWorker.ts` (new, standalone PM2 process)

- Wraps the existing scoring logic from `discoverTraders.ts` (leaderboard
  fetch + weighted 100-point scoring).
- Runs on an interval (default 12h, configurable).
- For each candidate scoring above a configurable threshold that isn't
  already in `tracked_traders` (any status), inserts a `pending` row with
  `source: 'discovered_leaderboard'` and sends a Telegram alert with score
  + reasons + Approve/Reject buttons.

### `src/newWalletWorker.ts` (new, standalone PM2 process)

- Opens its own `RealTimeDataClient` subscription to `activity`/`trades`
  (independent of the main bot's WS connection — a second client against
  the same public firehose).
- For each trade: if `proxyWallet` isn't in `seen_wallets`, insert it
  there and check if this trade's `usdcSize` exceeds a configurable
  threshold (default $500). If so, and the address isn't already in
  `tracked_traders`, insert a `pending` row with
  `source: 'discovered_new_wallet'` and alert via Telegram.
- If the wallet IS in `seen_wallets` already, no action (not a first
  trade).

### `ecosystem.config.js` (extended)

Add `discoveryWorker` and `newWalletWorker` as additional PM2 apps
alongside the existing bot app.

## Error handling

- **Telegram bot polling failures** (network drop, API error): the
  `node-telegram-bot-api` library has its own polling-retry behavior;
  no custom reconnect logic needed, but log polling errors via `Logger`.
- **Unauthorized chat ID**: silently ignored (no reply), logged at debug
  level only — avoids leaking bot behavior to unauthorized senders.
- **Malformed `/add` address**: reply with a validation error in-chat
  (reuse the existing Ethereum-address regex from `env.ts`), do not write
  to the DB.
- **Discovery workers crash**: PM2 auto-restarts them per its default
  policy (same as the main bot); a crash does not affect the main bot
  process since they're separate PM2 apps.
- **Duplicate discovery**: both `INSERT` paths must check for an existing
  `tracked_traders` row (any status) before inserting, to avoid re-alerting
  on the same address repeatedly.

## Testing approach

No automated test can safely exercise live Telegram polling or the live
Polymarket firehose. Verification is staged and manual, matching the
pattern used for the WebSocket migration:

1. **Stage 1** (`tracked_traders` collection + Telegram commands, monitors
   still reading `USER_ADDRESSES` unchanged): verify `/list`, `/add`,
   `/remove`, `/pending` against a test MongoDB, confirm the one-time
   migration seeds correctly from `USER_ADDRESSES`. Note: in this stage,
   `/add`/`/remove` change the DB but have **no effect on live monitoring**
   yet (that wiring is Stage 2) — this is an expected, temporary gap between
   the two stages, not a bug, but worth knowing if testing Stage 1 in
   isolation.
2. **Stage 2** (live-reload wiring into the three services): with
   `DRY_RUN=true npm run dev` running, add/remove a trader via Telegram and
   confirm monitoring starts/stops within the refresh interval, with no
   restart.
3. **Stage 3** (discovery workers): run each worker standalone against
   `DRY_RUN`-equivalent conditions (workers never place trades, so this is
   about confirming correct `pending` inserts and Telegram alerts, not
   trade safety), verify the Approve button correctly flips status.

Each stage ships as its own commit(s).

## Open questions for implementation time

- Exact scoring/size thresholds for `discoveryWorker`/`newWalletWorker`
  (what score triggers an alert, what USD size counts as "outsized") should
  be tunable via env vars with sensible defaults, not hardcoded — exact
  default values to be decided during implementation, informed by
  `discoverTraders.ts`'s existing threshold conventions.
