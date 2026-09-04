# Live Binary-Market Arbitrage Strategy — Design Spec

## Context and Motivation

While investigating a specific trader's activity (`0x2005d16a84ceefa912d4e380cd32e7ff827875ea`) on a live CS2 esports match (conditionId `0xf4f2d2a5aa3a3feb207003232694f19e00aee8a4233c418a0feb6ad9dace3be9`), we found they were buying BOTH outcome tokens of the same binary market over the course of the live match, as prices swung with in-game events. Reconstructing their actual fills:

- Bought "HOTU" heavily early, avg cost $0.4895/share, ending size ~18,560 shares
- Bought "Eternal Fire" opportunistically as its price fell during the match, avg cost $0.3090/share, ending size ~13,892 shares

The matched portion of this (13,892 shares of each side) cost `13,892 × (0.4895 + 0.3090) = $11,092.87` and guarantees a `$13,892.14` payout at resolution regardless of which side wins — a **$2,799.27 guaranteed profit, 25.2% margin**, locked in purely because the trader's blended average costs across both sides, accumulated at different moments during the match's volatility, summed to $0.7985 — well under $1.00. The remaining ~4,668 excess HOTU shares are an unhedged directional bet layered on top, not part of the guaranteed arb.

This spec designs a standalone bot that systematically looks for and executes this same opportunity — buying both sides of a live, two-outcome sports/esports market whenever the running combined average cost drops below a safety threshold, keeping share counts matched so the resulting position is a genuine, guaranteed-profit arbitrage.

**This is explicitly NOT the existing copy-trading strategy.** It shares no logic with `tradeMonitor.ts`/`tradeExecutor.ts` (which copy a specific trader's trades) beyond reusing already-hardened order-placement primitives (`submitOrder` from `postOrder.ts`). It is a new, independent strategy with its own market discovery, its own entry logic, and its own position tracking.

## Core Thesis (and why it's a REAL edge, not variance)

The arbitrage condition for a two-outcome market (side A, side B; exactly one resolves to $1/share, the other to $0) is:

```
avgCostA + avgCostB < $1.00
```

If this holds for `N` matched shares of each side, the position guarantees `N × (1 - (avgCostA + avgCostB))` profit at resolution, independent of which side wins. This is not a market view — it requires no opinion about the match outcome at all. It exists because live in-play markets are illiquid and volatile enough that BOTH sides can independently trade below their "fair" complementary price at different moments (a round loss crashes side B's price below its true conditional win probability; minutes later side A's price may separately dip on a different swing) — not because both sides are cheap simultaneously in one quote.

**This is fundamentally different from, and cannot be confused with:** buying the side you think is undervalued because you believe the market is wrong about who wins (a directional bet), or trying to time an early entry before a match starts (no live-swing volatility to exploit yet).

## Architecture

Five components, one new service (`src/services/liveArbEngine.ts`) plus supporting modules, wired into `src/index.ts` as an independently start/stoppable service alongside the existing trade monitor/executor — never coupled to their internals.

```
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│  Market Discovery    │────▶│  Price Feed Manager   │────▶│   Arb Engine       │
│  (polling, ~30s)     │     │  (WebSocket, push)    │     │  (per-market state)│
│  gamma-api /events   │     │  @polymarket/client   │     │  buy decision      │
│  ?live=true          │     │  subscribe()          │     │                    │
└─────────────────────┘     └──────────────────────┘     └─────────┬─────────┘
                                                                      │
                                                                      ▼
                                                          ┌───────────────────┐
                                                          │  submitOrder()     │
                                                          │  (postOrder.ts,    │
                                                          │  already hardened) │
                                                          └─────────┬─────────┘
                                                                      │
                                                                      ▼
                                                          ┌───────────────────┐
                                                          │ arb_positions      │
                                                          │ (new collection)   │
                                                          └───────────────────┘
                                                                      │
                                                       (after match resolves)
                                                                      ▼
                                                          ┌───────────────────┐
                                                          │ Redemption sweep   │
                                                          │ (extends existing  │
                                                          │ redeemResolved     │
                                                          │ Positions.ts)      │
                                                          └───────────────────┘
```

### 1. Market Discovery (`src/services/liveArbDiscovery.ts`)

Polls `https://gamma-api.polymarket.com/events?live=true&limit=<N>` on a fixed interval (proposed: 30s — live sports events don't start/end fast enough to need sub-second discovery; the price feed, not discovery, needs to be real-time). For each event returned:

- Skip if `event.live !== true`.
- For each `market` in `event.markets`:
  - Skip unless `market.active === true && market.closed === false`.
  - Skip unless `market.sportsMarketType` is in an allow-list: `['moneyline', 'child_moneyline']` — this excludes totals (over/under), handicaps, and tournament-field side-markets (e.g. individual "will X win the whole tournament" Yes/No markets), which either aren't genuinely two-sided in the same sense or have less predictable live-price behavior for this thesis.
  - Skip unless `JSON.parse(market.outcomes).length === 2` (defensive — moneyline markets should always be 2-outcome, but verify rather than assume, mirroring the existing `resolveOutcomeToken` pattern in `manualBuy.ts`).
  - Extract both `conditionId` and the two `clobTokenIds` (parsed from the JSON-encoded `outcomes`/`clobTokenIds` string fields, same parsing pattern as `manualBuy.ts`'s `resolveOutcomeToken`).

Maintains an in-memory `Map<conditionId, { assetIdA, assetIdB, outcomeA, outcomeB }>` of currently-eligible markets. Diffs against the previous poll:
- **Newly eligible market**: hand it to the Price Feed Manager to subscribe.
- **No longer eligible** (event ended, market closed): unsubscribe its price feed; the Arb Engine's existing position (if any) is left untouched — it holds to resolution regardless of discovery state, since discovery only controls whether NEW buying continues, not existing holdings.

### 2. Price Feed Manager (`src/services/liveArbPriceFeed.ts`)

Wraps `@polymarket/client`'s `subscribe()` (confirmed available and exported; NOT the same package as the existing `@polymarket/real-time-data-client` used by `websocketTradeMonitor.ts`, which only carries a trade-activity firehose, not price data):

```typescript
const handle = await subscribe(client, [
    { topic: 'market', assetIds: allWatchedAssetIds, customFeatureEnabled: true }
]);
```

Listens for `MarketBestBidAskEvent` (`{ topic: 'market', type: 'best_bid_ask', payload: { assetId, conditionId, bestBid, bestAsk, ... } }`) and forwards each event to the Arb Engine's per-market handler, keyed by `conditionId`.

As the Market Discovery component adds/removes eligible markets, the Price Feed Manager updates its subscription's `assetIds` list (re-subscribing with the new full set — confirm at implementation time whether the SDK supports incremental subscribe/unsubscribe or requires a full re-subscribe; either is acceptable, this is an implementation detail not a design constraint).

**No polling of price data anywhere in this design.** This directly answers the concern raised during design ("what about socket instead of polling") — discovery (which markets exist) is polled at a slow, appropriate cadence since new live matches don't appear that often; price ticks (which drive buy decisions) are pure push, zero added latency beyond the WebSocket's own network round-trip.

### 3. Arb Engine (`src/services/liveArbEngine.ts`)

Per watched market, maintains state:

```typescript
interface ArbMarketState {
    conditionId: string;
    assetIdA: string; assetIdB: string;
    outcomeA: string; outcomeB: string;
    sizeA: number; avgCostA: number;
    sizeB: number; avgCostB: number;
    deployedUsd: number; // running total spent in this market
}
```

On each `MarketBestBidAskEvent` for a watched asset (using `bestAsk` — the price we'd actually pay to buy):

1. Identify which side (A or B) the event is for.
2. Compute the **hypothetical** new average cost for that side if we bought a candidate order size at the current best ask (same size-weighted-average formula already used in `postOrder.ts`'s `recordBuyFill`: `(oldSize*oldAvgCost + buySize*fillPrice) / (oldSize+buySize)`).
3. Check: does `hypotheticalAvgCostX + avgCost(other side)` fall below `ARB_TARGET_SUM` (0.95)? [Note: if the OTHER side has zero size yet, its "avgCost" is undefined — treat as buying the first leg is never itself sufficient to trigger a buy; the engine requires at least a token position on both sides before the combined-sum check is meaningful. See Task-level detail in the implementation plan for the exact bootstrapping order: which side buys first, and under what condition, is a real design decision to make when writing the plan, informed by whichever side's price is currently lower.]
4. Check risk limits: `thisMarket.deployedUsd + candidateOrderUsd <= MAX_PER_MARKET_USD` AND `totalDeployedAcrossAllMarkets + candidateOrderUsd <= MAX_TOTAL_DEPLOYED_USD`.
5. Check the matched-sizing invariant: only buy side X if doing so keeps `|sizeA - sizeB|` from growing (i.e., prefer buying whichever side currently has the SMALLER share count; if both are equal, buying either is fine, but never buy the side that's already ahead in share count purely because it got cheaper — that would be a directional bet on top of the arb, explicitly out of scope per this spec's design decisions).
6. If all checks pass: call `submitOrder(client, { side: OrderSide.BUY, tokenID: assetIdX, amount: candidateOrderUsd, price: bestAsk })` — reusing the exact same hardened function `postBuyOrder`/`manualBuy.ts` already use, inheriting `maxSpend`, `BUY_PRICE_TOLERANCE`, and FOK semantics automatically.
7. On a successful fill, update `sizeX`/`avgCostX`/`deployedUsd` from the actual `resp.makingAmount`/`resp.takingAmount` (same fix already applied in `postBuyOrder` — never recompute from the pre-fill snapshot price).

**Candidate order sizing**: proposed as a small fixed increment per tick (e.g. $5–10) rather than one large order — since the edge depends on the price staying favorable only briefly, smaller frequent fills reduce the risk of a single large order pushing through multiple price levels and eating its own edge via slippage. Exact value is an implementation-plan detail, not a spec-level decision, but the principle (small incremental buys, not one large market order per opportunity) is a spec-level constraint.

### 4. Position Tracking (`src/models/arbPosition.ts`, new collection `arb_positions`)

**Not the same as `my_positions`** — `my_positions` (built earlier this session) is a per-conditionId single-position cache mirroring the copy-trading bot's own simple long/short holding. This strategy needs to track a MATCHED PAIR per market with its own lifecycle (open → holding → resolved → redeemed), which doesn't fit that schema. New collection, new model:

```typescript
{
    conditionId: string;       // unique key
    outcomeA: string; assetIdA: string; sizeA: number; avgCostA: number;
    outcomeB: string; assetIdB: string; sizeB: number; avgCostB: number;
    status: 'accumulating' | 'resolved_pending_redemption' | 'redeemed';
    openedAt: number;
    resolvedAt?: number;
    redeemedAt?: number;
}
```

This collection is the source of truth for "what arb positions do we currently hold" — read by the redemption sweep (below), and could later back a monitoring/reporting script (out of scope for this spec's first implementation).

### 5. Resolution and Redemption

Once a market resolves (detected by polling `active`/`closed`/a resolved-status field on the market, at the same cadence as Market Discovery — no need for a separate real-time signal here, since redemption is not time-sensitive the way entry is), mark the `arb_positions` doc `status: 'resolved_pending_redemption'`.

A periodic sweep (could be a new script following the `redeemResolvedPositions.ts` pattern already in this repo, or an extension of it) redeems both legs — the winning side pays out via `redeemPositions()` (the existing on-chain call already used by `redeemResolvedPositions.ts`), the losing side simply expires worthless with no action needed. Mark `status: 'redeemed'`.

**This spec does not require modifying the existing `redeemResolvedPositions.ts`** — whether to extend it or write a new, arb-specific redemption script is an implementation-plan decision, not a design constraint. The design constraint is: redemption is a distinct, periodic, resolution-triggered step — never conflated with the accumulation phase, and never blocking or delaying it.

## Global Constraints

- **Never mix with the existing copy-trading bot's state.** No shared collections with `my_positions`, `user_positions_{address}`, or `user_activities_{address}`. No shared config constants unless a value is genuinely identical in meaning (e.g. `RETRY_LIMIT` for order retries is fine to reuse; `MAX_POSITION_SIZE_USD` is copy-trading-specific and must NOT be reused for this strategy's own, separate risk limits).
- **Reuse `submitOrder` from `postOrder.ts` for all order placement.** Never construct a separate `client.placeMarketOrder(...)` call — this is exactly the duplication mistake identified and fixed earlier in `manualBuy.ts`/`manualSell.ts`; don't reintroduce it here.
- **Never buy a side that would grow the share-count mismatch between A and B.** This is what keeps the position a true arbitrage rather than a directional bet with an arb-shaped hedge — see Section 3, Step 5.
- **`ARB_TARGET_SUM = 0.95`, `MAX_PER_MARKET_USD`, `MAX_TOTAL_DEPLOYED_USD` are all new, dedicated environment variables** (e.g. `LIVE_ARB_TARGET_SUM`, `LIVE_ARB_MAX_PER_MARKET_USD`, `LIVE_ARB_MAX_TOTAL_DEPLOYED_USD`) — validated in `src/config/env.ts` following the existing pattern for other numeric env vars, with sensible defaults so the feature is opt-in/safe if unconfigured (e.g. default `MAX_TOTAL_DEPLOYED_USD` low enough that an operator must deliberately raise it before meaningful capital is at risk).
- **This service must be independently start/stoppable** from the copy-trading monitor/executor in `src/index.ts` — an operator should be able to run the copy-trading bot without this strategy active, and vice versa, controlled by its own enable/disable env flag (e.g. `LIVE_ARB_ENABLED`).
- **DRY_RUN must be respected** — `submitOrder`'s existing `DRY_RUN` branch already handles this transparently for any caller; no special-casing needed in the new service, but it must be verified to actually flow through correctly at implementation/testing time.
- **No copy-trading logic, `UserActivityInterface`, or trader-address concepts anywhere in this subsystem.** This strategy watches markets, not traders.

## Error Handling

- **Market Discovery poll failure** (network error, API down): log and retry on the next scheduled poll; never crash the service. The Price Feed Manager continues operating on its last-known eligible-market set until the next successful discovery poll updates it.
- **Price Feed WebSocket disconnect**: reconnect with backoff (mirror whatever pattern `websocketTradeMonitor.ts` or `websocketClient` already uses for `RealTimeDataClient` reconnection, if one exists — check at implementation time; otherwise a straightforward exponential backoff is acceptable). While disconnected, the Arb Engine simply receives no new price ticks for affected markets — it does not buy blindly, and does not need to treat a disconnect as an error requiring position changes.
- **`submitOrder` failure** (any rejection code, or a thrown error): log and skip this tick's buy attempt — never retry aggressively within the same price tick (a live-market opportunity that failed once may already be gone by the time of a retry; let the next independent price tick decide whether to try again, rather than looping like `postBuyOrder`'s own internal `RETRY_LIMIT` loop does for a single trader-copy trade). This is a deliberate difference from `postBuyOrder`'s retry behavior, justified by the different failure cost: a missed arb tick just means slightly less profit captured, not a botched trade that needs completing.
- **Mongo write failure** (recording the position): follow the exact pattern already established in `postOrder.ts`'s `recordBuyFill` — isolate in a try/catch, log a warning, never let a bookkeeping failure block or reverse a real fill that already happened.

## Testing Strategy

- **Unit tests** for the arb-condition math (given `sizeA/avgCostA/sizeB/avgCostB` and a candidate price/size, does the engine correctly decide buy-or-skip, correctly respect the matched-sizing invariant, correctly respect both risk caps) — pure functions, no network/DB, following this repo's existing Jest conventions.
- **Unit tests** for market-eligibility filtering (given a fixture event/market JSON shape like the real CS2 event pulled during this design's research, confirm the moneyline/2-outcome/active/closed filters behave correctly, including the observed edge case of a `live:true` event containing `closed:true` sub-markets).
- **No live-network integration test** for the WebSocket subscription itself is required for the first implementation — mock `subscribe()`'s event delivery in tests, the same way `postOrder.ts`'s tests already mock ESM-blocking dependencies (`@polymarket/client`, `@polymarket/bindings/clob`) per the established pattern in `postOrder.myPositionWrites.test.ts`.
- **Manual DRY_RUN smoke test** against a real live market (as was done for `manualBuy.ts`/`manualSell.ts` earlier this session) before this ever runs with `DRY_RUN=false`.

## Explicitly Out of Scope (for this spec / first implementation)

- Any directional/unhedged position building (the "excess" HOTU shares seen in the original trader's activity) — this spec is arbitrage-only.
- Early exit / unwinding a position before resolution — see the design decision above; holding to resolution is the chosen approach.
- Auto-discovery beyond moneyline markets (totals, handicaps, tournament-field markets) — explicitly excluded per the eligibility filter design decision.
- Multi-way (>2 outcome) markets — the arb math and matched-sizing invariant as designed only apply to strictly binary markets.
- Any UI/dashboard for monitoring open arb positions — `arb_positions` is designed to support one later, but building it is not part of this spec.

## Open Questions for the Implementation Plan (not blocking this spec's approval, but must be resolved before coding)

1. Exact bootstrapping rule for which side buys first when one side has zero position yet (Section 3, Step 3's bracketed note).
2. Exact candidate order size per tick (proposed $5–10, needs a concrete default).
3. Whether `@polymarket/client`'s `subscribe()` supports incremental add/remove of `assetIds` on a live subscription, or requires full re-subscription on every discovery-driven change — determines the Price Feed Manager's exact re-subscription logic.
4. Whether to extend `redeemResolvedPositions.ts` or write a new, arb-specific redemption script.
5. Exact reconnection/backoff strategy for the WebSocket subscription.
