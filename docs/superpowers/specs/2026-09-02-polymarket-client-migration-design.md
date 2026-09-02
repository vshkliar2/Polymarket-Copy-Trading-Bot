# Migrate order placement from @polymarket/clob-client-v2 to @polymarket/client

## Background

Polymarket recently migrated user accounts to a new "deposit wallet" contract
architecture (an EIP-1167 minimal-proxy pattern, distinct from both a plain
EOA and a Gnosis Safe). This account's `PROXY_WALLET` was migrated to
`0x848123AceC0Bafc3b1066B87A9a5f44c9CE219Cb` as part of that rollout.

Since the migration, every live BUY order fails at `clobClient.postOrder()`
with:

```json
{ "error": "maker address not allowed, please use the deposit wallet flow", "status": 400 }
```

Investigation traced this to a genuine gap in `@polymarket/clob-client-v2`
(confirmed still present in the latest published version, 1.1.0): its
`SignatureTypeV2` enum (`EOA`, `POLY_PROXY`, `POLY_GNOSIS_SAFE`, `POLY_1271`)
has no representation for the new deposit-wallet type, and
`createClobClient.ts`'s bytecode-presence check (`code !== '0x'`) cannot
distinguish a real Gnosis Safe from the new proxy-clone contract — both have
bytecode, but only the former was ever validated against
`SignatureTypeV2.POLY_GNOSIS_SAFE`.

This is corroborated by two independent, still-open GitHub issues against the
same client family (`py-clob-client-v2#53`, filed 2026-05-08, and
`py-clob-client-v2#64`, filed 2026-05-14) reporting the identical symptom with
no confirmed working signature-type workaround as of this writing.
`@polymarket/clob-client` (v1) is independently confirmed archived
(2026-05-25) and explicitly documented as non-functional for this purpose —
not a viable fallback.

Polymarket's own current documentation
(`docs.polymarket.com/trading/quickstart`, `place-orders.md`) shows the
sanctioned path for this account type is a different, newer package:
`@polymarket/client`, via `createSecureClient()` /
`SecureClient.placeMarketOrder()`. This package is genuinely new (v0.8.1,
published 2026-08-28) and part of the `Polymarket/ts-sdk` monorepo, which
`clob-client-v2`'s own README now points to as the recommended SDK.

A separately reported community workaround (pinning `clob-client-v2` to
`1.0.1`, confirming `PROXY_WALLET` matches the address Polymarket's Settings
page shows, placing one order via the web UI first, and requesting account
whitelisting from Polymarket support) has already been applied as an
interim mitigation: `package.json` now pins
`"@polymarket/clob-client-v2": "1.0.1"` exactly. This spec covers the
**longer-term replacement** of `clob-client-v2` entirely, in case the interim
pin proves insufficient or Polymarket deprecates `clob-client-v2` for
deposit-wallet accounts outright.

## Goal

Replace `@polymarket/clob-client-v2` with `@polymarket/client`'s
`SecureClient` across every file that places orders, checks balance/
allowance, or fetches an order book for trading purposes — while leaving
trade *detection* (`@polymarket/real-time-data-client`,
`websocketTradeMonitor.ts`, `newWalletWorker.ts`, `tradeMonitor.ts`)
completely untouched, since the new SDK has no equivalent to the
unfiltered `activity`/`trades` firehose those depend on (confirmed: its
`subscribe()` API only supports per-asset `MarketSubscription` and
per-account `UserSubscription`, neither of which can watch arbitrary
third-party wallets platform-wide).

## Non-goals

- No change to trade detection/monitoring (WebSocket firehose or HTTP
  polling paths).
- No change to the EOA-vs-proxy-wallet query-key logic
  (`getMyEOA.ts`/`positionHelpers.ts`) — orthogonal, already fixed this
  session.
- No change to copy-sizing strategy logic (`copyStrategy.ts`).
- Not attempting to keep `clob-client-v2` installed as a fallback — full
  removal once migration is verified, per prior decision.

## Affected files

**Core trading path:**
- `src/utils/createClobClient.ts` — sole shared client-creation function;
  used by `src/index.ts`, `closeResolvedPositions.ts`, `closeStalePositions.ts`
- `src/utils/postOrder.ts` — order placement, order book fetch, retry/error
  handling for BUY/SELL/MERGE
- `src/services/tradeExecutor.ts` — imports `ClobClient` as a type only,
  threads the client instance through; expected to need only a type-level
  change here

**Scripts with their own local `createClobClient` (duplicated logic,
consolidate onto the shared one while migrating):**
- `src/scripts/manualSell.ts`
- `src/scripts/checkTraderAndSell.ts`
- `src/scripts/sellLargePositions.ts`

**Scripts using `clob-client-v2` directly for allowance/config:**
- `src/scripts/checkAllowance.ts` — builds two `ClobClient` instances inline
  (bootstrap credentials, then authenticated client) — investigate whether
  `createSecureClient` collapses this to one step
- `src/scripts/setTokenAllowance.ts` — uses `getContractConfig` only

**Test/reference file:**
- `src/test/test.ts` — imports `ClobClient`, `OrderType`, `Side`; scope of
  what this file actually does needs a read before migrating it

## Design

### Client creation

Replace `createClobClient.ts`'s bytecode-detection + `SignatureTypeV2`
selection with:

```ts
import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';

const client = await createSecureClient({
  wallet: PROXY_WALLET,
  signer: privateKey(PRIVATE_KEY),
});
```

Open question for implementation: does `createSecureClient` need any
wallet-type hint, or does it resolve wallet type automatically/server-side?
None of the official examples reviewed show a signature-type parameter.
Resolve by reading `SecureClientOptions`'s full shape and/or testing against
a real dry-run.

### Order placement

Replace the two-step `clobClient.createMarketOrder()` +
`clobClient.postOrder(signed, OrderType.FOK)` with the single call:

```ts
const response = await client.placeMarketOrder({ tokenId, side, amount });
if (response.ok) {
  // success path
} else {
  // failure path — exact shape of a non-ok response is unverified;
  // resolve hands-on during implementation
}
```

Per the docs, `placeMarketOrder` can also throw a `PlaceMarketOrderError` on
certain failures. `postOrder.ts`'s current retry loop branches on
`resp.success === true` and calls `extractErrorMessage`/
`isInsufficientBalanceOrAllowanceError` (`errorHelpers.ts`) against the
response shape. Both helpers need to be re-verified/rewritten against the
new response and thrown-error shapes — **this is the single biggest
uncertainty in this migration** and must be resolved with real API calls
(dry-run first), not guessed from type signatures alone.

### Order book / price discovery

`clobClient.getOrderBook(asset)` → `orderBook.bids`/`orderBook.asks` maps
directly to:

```ts
const orderBook = await fetchOrderBook(client, { assetId: asset });
// orderBook.bids / orderBook.asks — same shape per SDK's own example
```

Low risk — the new SDK's documented example uses the identical
`.bids`/`.asks` access pattern already used throughout `postOrder.ts`.

### Balance / allowance

`fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL })`
replaces whatever `clob-client-v2`-specific allowance calls
`checkAllowance.ts`/`setTokenAllowance.ts` currently make. `getMyBalance.ts`
(a raw on-chain ERC-20 `balanceOf` call against the pUSD contract) is
**out of scope** — it has zero dependency on either CLOB library and
continues to work unchanged.

### Consolidation while migrating

`manualSell.ts`, `checkTraderAndSell.ts`, and `sellLargePositions.ts` each
currently duplicate their own local `createClobClient` function instead of
importing the shared `src/utils/createClobClient.ts`. Since all three need
their client-creation logic rewritten anyway, this migration should also
delete the duplicated local functions and switch these three scripts to
import the shared (now-migrated) `createClobClient.ts` — reducing three
copies of new-SDK logic to one.

## Environment / runtime changes

- `package.json`: bump `engines.node` to `>=24` (required by
  `@polymarket/client`); remove `@polymarket/clob-client-v2` dependency;
  add `@polymarket/client` (pin exact version, mirroring the
  `clob-client-v2@1.0.1` pin already applied, given this package is
  pre-1.0 and under active development).
- VM: Node 20 → 24 upgrade (nodesource setup script, matching the pattern
  already used in `docs/GCP_DEPLOYMENT.md` step 6).
- `docs/GCP_DEPLOYMENT.md`: update Node version references.
- `package-lock.json`: regenerate.

## Validation plan

Per explicit decision: **build and dry-run only — no live real-money order
as part of this migration's validation.** The real-order go/no-go decision
is made separately by the account owner afterward.

1. `npm run build:strict` — must be clean against the new SDK's types.
2. `npm test` — all existing tests must continue passing (none currently
   mock `ClobClient` directly, so no test rewrites expected, but verify).
3. Local dry-run: `DRY_RUN=true npm run dev` — confirm `createSecureClient`
   initializes without error, `fetchOrderBook`/`fetchBalanceAllowance`
   return real data for a live market/the real account.
4. Deploy to VM (after the Node 24 upgrade) and repeat the dry-run there.
5. Hand back to the account owner for the real-order verification step.

## Risks

- **Error-response shape is unverified.** `postOrder.ts`'s
  insufficient-balance detection, slippage guard, and partial-fill
  retry logic all depend on precisely parsing a failure response. Getting
  this wrong could silently misclassify errors (e.g., treating a
  slippage rejection as an insufficient-balance abort, or vice versa).
  Must be resolved with real dry-run/testnet-style calls, not
  types-only inference.
- **`@polymarket/client` is pre-1.0** (0.8.1) and its own bundled README
  has no order-placement documentation yet — behavior could change in a
  future patch. Mitigate by pinning an exact version.
- **Node 24 is a substantial runtime bump** (from 18/20) — affects the VM
  system-wide, not just this bot; verify PM2 and other tooling remain
  compatible.
- **Three duplicated `createClobClient` functions being consolidated**
  changes more surface area than a pure like-for-like swap — slightly
  larger diff, but reduces long-term duplication risk.

## Out of scope for this spec (explicitly deferred)

- Whether the `clob-client-v2@1.0.1` interim pin alone resolves the issue
  without this migration — if it does, this migration may become
  unnecessary and can be shelved.
- Polymarket support's account whitelisting step — a manual, human action
  outside this codebase's control.
