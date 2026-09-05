# Interactive Telegram Bot — Design Spec

## Problem

`telegramNotifier.ts` currently supports two things: one-way push
notifications (startup/shutdown/trade/error alerts) and a small set of
trader-management commands (`/list`, `/pending`, `/add`, `/remove`, plus an
approve/reject inline-button flow) — all defined inline in a single 513-line
class. There is no way to check your own positions, recent trade activity,
a specific market's price/volume, or another trader's holdings from
Telegram; you have to SSH in and run a script. The existing commands also
aren't registered with Telegram's native command menu, so they only work if
you already know to type them from memory.

This spec covers extracting all command handling into its own module
structure, registering every command with Telegram's `/` menu via
`setMyCommands`, and adding four new read-only command groups: your live
positions, your recent activity, a market lookup, and any trader's live
positions.

## Goals

- Every command (existing and new) discoverable via Telegram's native `/`
  command menu — no memorization required.
- `/positions` — your current live positions (value, PnL, market title,
  link to polymarket.com), paginated.
- `/activity` — your recent trade history (side, size, price, market),
  paginated.
- `/market <slug-or-conditionId>` — a specific market's current state:
  question, yes/no prices, spread, volume (24h/total), liquidity, link.
- `/trader <address>` — any wallet's live positions, same shape as
  `/positions`, for scouting a trader before/after deciding to copy them.
- `/help` — lists every registered command with a one-line description.
- Existing `/list`, `/pending`, `/add`, `/remove` and the approve/reject
  inline-button flow keep their exact current behavior, just relocated.
- `telegramNotifier.ts` shrinks to connection setup + push-notification
  methods (`notifyStartup`, `notifyTrade`, etc.) only.

## Non-goals

- Multi-operator authorization — every command stays restricted to the
  single configured `TELEGRAM_CHAT_ID`, matching current usage.
- Write/trading actions from Telegram (manual buy/sell, closing a
  position) — this spec is read-only data commands plus the existing
  trader add/remove management; placing real orders from a chat command is
  meaningfully higher-risk and out of scope here.
- Persisting pagination state across a bot restart — an in-memory Map is
  sufficient (see Pagination below); a stale Next/Prev button after a
  restart simply won't respond, acceptable for a personal single-user bot.
- Fuzzy/partial market search (e.g. matching on question text) — `/market`
  requires an exact slug or condition ID, matching how `fetchMarket`/
  `listMarkets` already work.
- Combo/multi-outcome market support in `/market` or `/positions` — this
  bot has no combo-market support anywhere else (see
  `2026-09-02-polymarket-client-migration-design.md`'s handling of
  `ComboTradeActivity`); combo positions/markets are filtered out, not
  displayed with fabricated fields.

## Module structure

```
src/services/telegramCommands/
  index.ts        — registerAllCommands(ctx): wires every onText handler,
                     the single callback_query router, and setMyCommands
  types.ts         — CommandContext, PageState
  traders.ts       — /list, /pending, /add, /remove, approve/reject callback
                      (migrated from telegramNotifier.ts as-is)
  positions.ts     — /positions
  activity.ts      — /activity
  market.ts        — /market <query>
  trader.ts        — /trader <address>
  pagination.ts    — in-memory pager + Next/Prev callback_data helpers
  help.ts          — /help
```

`telegramNotifier.ts`'s `initialize()` builds one `CommandContext` and
calls `registerAllCommands(context)` once, instead of its current
`registerCommandHandlers()` defining every handler inline. Everything else
in `telegramNotifier.ts` (constructor, `sendMessage`, `notifyStartup`,
`notifyTrade`, `notifyShutdown`, etc.) is unchanged — no consumer of
`TelegramNotifier`'s public `notify*` methods (`postOrder.ts`,
`healthMonitor.ts`, `websocketTradeMonitor.ts`, `index.ts`,
`discoveryWorker.ts`, `newWalletWorker.ts`) is affected.

### `CommandContext`

```typescript
// telegramCommands/types.ts
export interface CommandContext {
  bot: TelegramBot;
  chatId: string;
  isAuthorized: (chatId: number | string) => boolean;
  sendMessage: (text: string) => Promise<TelegramBot.Message | void>;
}
```

`sendMessage` returns the sent `Message` (not `void`, unlike
`telegramNotifier.ts`'s private version) so paginated commands can capture
the message id to key pagination state by. `telegramCommands/index.ts`
builds this from `TelegramNotifier`'s existing private `bot`/`chatId`/
`isAuthorized`, passed in via a small constructor-time wiring change in
`telegramNotifier.ts` (`registerAllCommands({ bot, chatId, isAuthorized:
this.isAuthorized.bind(this), sendMessage: ... })`).

### Changes to existing code outside `telegramCommands/`

- `src/utils/publicClient.ts`'s `getTradeActivity` currently returns a bare
  `ApiActivity[]` with no cursor exposed (its signature as of the
  `createPublicClient` migration). `/activity`'s lazy pagination (see
  Pagination below) needs the cursor, so this spec changes its return type
  to `{ items: ApiActivity[]; nextCursor?: string; hasMore: boolean }` and
  adds a `cursor` input option. This is the only change to a file outside
  `telegramCommands/`; `getPositions`/`getAllPositions`/`getClosedPositions`
  are untouched since nothing in this spec needs their cursors.
- `telegramNotifier.ts`: `registerCommandHandlers()` and its five inline
  handler bodies (`/list`, `/pending`, `/add`, `/remove`,
  `callback_query`) are deleted and become
  `telegramCommands/traders.ts`/`index.ts`; `initialize()` calls
  `registerAllCommands(...)` in its place. No other method changes.

## Command reference (for `/help` and `setMyCommands`)

| Command | Description | Auth | Paginated |
|---|---|---|---|
| `/list` | Show active tracked traders | yes | no (existing behavior unchanged) |
| `/pending` | Show pending trader candidates | yes | no (existing behavior unchanged) |
| `/add <address>` | Add a trader to active tracking | yes | n/a |
| `/remove <address>` | Remove a trader from active tracking | yes | n/a |
| `/positions` | Show your current live positions | yes | yes |
| `/activity` | Show your recent trade activity | yes | yes |
| `/market <query>` | Look up a market's price/volume/odds | yes | no |
| `/trader <address>` | Show any trader's live positions | yes | yes |
| `/help` | List all commands | yes | no |

Every handler starts with the same `isAuthorized` guard already used today
(`if (!ctx.isAuthorized(msg.chat.id)) return;`) — unauthorized chats get no
response at all (unchanged from current behavior, not just for the
migrated commands).

## Data flow per command

### `/positions` and `/trader <address>`

Both use `publicClient.getAllPositions(address)` (per prior discussion:
live API, not the bot's self-tracked `my_positions` collection — richer
data with market titles/slugs for linking, at the cost of a network
round-trip per invocation). `getAllPositions` already exists (added during
the `createPublicClient` migration) and pages through the SDK's cursor
internally, so the full position count — not just one page's worth — is
what gets paginated 5-at-a-time in Telegram. `/positions` calls it with
`MY_EOA_ADDRESS` (matching the existing convention in
`positionHelpers.ts`/`checkMyStats.ts` that data-api endpoints are keyed by
EOA, not `PROXY_WALLET`); `/trader` takes the address from the command
argument, works for any address whether tracked or not. In practice this
bot holds at most a few dozen open positions at once, so `getAllPositions`
fetching everything up front (rather than fetching page-by-page as the
user clicks Next) is not a real cost concern.

Each position renders as:
```
<b>Trump meets with Putin by December 31?</b> — No
Size: 250 @ avg $0.42 | Current: $0.455
Value: $113.75 | PnL: +$8.75 (+8.3%)
🔗 https://polymarket.com/event/trump-meets-with-putin-by-december-31
```

Positions sorted by `currentValue` descending (largest first — matches the
live API's own default order). Empty list → `"No open positions."` /
`"No open positions for <address>."`, not an empty paginated view.

### `/activity`

Unlike `/positions`/`/trader`, trade history can be arbitrarily long for an
active trader, so `/activity` does NOT fetch everything up front — it
fetches one page directly from `publicClient.getTradeActivity(MY_EOA_ADDRESS,
{ pageSize: 5 })` per Next/Prev click, using the SDK's own cursor (this
requires `getTradeActivity` to accept and return a `cursor`, currently
stripped from its public options per the `createPublicClient` migration's
final implementation — this spec restores a `cursor` param/return to
`getTradeActivity` specifically for this use case, leaving `getPositions`/
`getAllPositions` as they are today since they don't need it). The pager
entry for `/activity` stores `{ cursor, address }` instead of a
pre-fetched `items` array — see Pagination below for how the two pager
"flavors" (eager list vs. lazy cursor) coexist.

Each entry renders as:
```
<b>BUY</b> 54.86 <a href="...">US x Iran Effective Ceasefire...</a> @ $0.66
$36.32 · 2026-09-04 19:39
```
Sorted by `timestamp` descending (most recent first — matches the live
API's own default order). Empty → `"No trade activity found."`.

### `/market <query>`

Detect condition ID vs. slug by a `/^0x[0-9a-f]+$/i` test on the trimmed
argument (this repo already uses this exact detection style — see
`manualBuy.ts`'s `--condition-id` flag handling):
- Matches → `client.listMarkets({ conditionIds: [query], pageSize: 1 })`,
  take `.items[0]`.
- Otherwise → `client.fetchMarket({ slug: query })` directly (throws if not
  found; caught and reported as "Market not found").

Reply renders from the real shape confirmed during design (`fetchMarket`'s
`prices`/`metrics`/`outcomes`/`state` fields):
```
<b>Trump meets with Putin by December 31?</b>
Yes: $0.545 | No: $0.455 | Spread: $0.01
24h Volume: $302.63 | Total Volume: $119,323.76
Liquidity: $44,751.66
Status: <code>active</code>
🔗 https://polymarket.com/event/trump-meets-with-putin-by-december-31
```
No results / invalid query → `"Market not found: <query>"` (from a caught
error, not a thrown one reaching the user as a stack trace — matching the
existing pattern of catching and formatting errors around every command
body in `telegramNotifier.ts` today).

### `/help`

Statically lists the table above (not dynamically introspected from
registered handlers — simpler, and the table above is the source of truth
kept in sync by hand when a command is added/removed, same as
`setMyCommands`' list is).

## Pagination

Per prior discussion: in-memory `Map`, keyed by a short pager id (see
below). Two "flavors" of pager entry, both handled by the same
`callback_query` router:

- **Eager** (`/positions`, `/trader`): `{ kind: 'eager', items: T[], page:
  number, render: (item: T) => string }` — the full list was already
  fetched once; Next/Prev just slices a different `PAGE_SIZE` window
  client-side, no further network call.
- **Lazy** (`/activity`): `{ kind: 'lazy', address: string, cursor:
  string | undefined, render: (item: T) => string }` — Next fetches one
  more page from `publicClient.getTradeActivity(address, { pageSize: 5,
  cursor })` on demand; there is no client-side "Prev" for a
  cursor-paginated source, so `/activity`'s buttons are Next-only (no Prev
  button rendered at all, simpler than a disabled one).

Flow:
1. Command handler fetches page 0 (eager: the full list up front, then
   slices; lazy: one `pageSize`-worth via the API directly), stores the
   corresponding pager entry in the Map under a fresh key, renders it as
   text, sends it with the appropriate inline button(s) (`◀️ Prev` /
   `▶️ Next` for eager, omitting whichever end has no more data; `▶️ Next`
   only for lazy, omitted once the API reports no more pages), using
   `callback_data: "page:<pagerKey>:next"` / `"page:<pagerKey>:prev"`.
2. `callback_query` router (in `telegramCommands/index.ts`) sees a
   `page:...` prefixed `callback_data`, looks up `pagerKey` in the Map, and:
   - if missing (bot restarted since, or the entry aged out — see below),
     calls `answerCallbackQuery` with `"This list has expired — run the
     command again."` and returns.
   - otherwise advances the entry (eager: `page += 1`/`-= 1`; lazy:
     fetches the next page via the stored `cursor` and replaces it with the
     API's returned next cursor), re-renders, and calls `editMessageText`
     on the same message (not a new `sendMessage`) plus
     `answerCallbackQuery` with no visible text (a silent ack, since the
     edited message itself is the feedback).
3. Pager entries are capped (evict oldest beyond, say, 50 concurrent
   entries) and TTL'd (e.g. 30 minutes) via a periodic sweep, since this is
   a long-lived process and unbounded Map growth from repeated command
   invocations would otherwise leak memory slowly. A single-user personal
   bot won't stress this, but it costs nothing to bound it.

`pagerKey` is a short random id (e.g. `crypto.randomUUID().slice(0, 8)`),
not the message id itself, so `callback_data`'s 64-byte Telegram limit
isn't a concern and the same helper works before the message id is known
(needed to build the buttons before the first `sendMessage` call — the
button payload is prepared, message sent, then the pager entry is keyed by
the id `sendMessage` returns).

## Error handling

Every command body wraps its data-fetching + rendering in try/catch,
exactly matching the existing pattern in `telegramNotifier.ts`'s current
handlers — catch, format via `error instanceof Error ? error.message :
String(error)`, send as `❌ <message>`. No command handler ever lets an
exception propagate to Telegram's own `onText`/`callback_query` dispatch
(which would just log-and-swallow via `node-telegram-bot-api` silently —
strictly worse than a visible in-chat error).

Network calls (`publicClient` methods) already carry their own retry
behavior via `fetchData`'s underlying `axios` config — no additional retry
wrapping needed at the command layer.

## Testing

- `pagination.ts`'s pager logic (add/get/paginate/evict/TTL) is pure enough
  to unit test directly — no Telegram/network involved.
- `market.ts`'s condition-ID-vs-slug detection is a pure function,
  unit-testable directly.
- Rendering functions (position/activity/market formatting) are pure
  string-building from typed input — unit-testable with fixture data,
  following this repo's existing convention of colocated `__tests__`
  directories (e.g. `src/services/telegramCommands/__tests__/`).
- Full command wiring (`registerAllCommands`, actual Telegram
  send/receive) is not unit-tested — matches this repo's existing
  precedent of not testing `telegramNotifier.ts`'s bot wiring itself, only
  pure logic extracted from it.
