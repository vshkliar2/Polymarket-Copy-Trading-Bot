# Migrate Order Placement to @polymarket/client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@polymarket/clob-client-v2` with `@polymarket/client`'s `SecureClient` for all order placement, order-book fetching, and balance/allowance checks, while leaving trade detection (`@polymarket/real-time-data-client`) untouched.

**Architecture:** A single new `createSecureClient` wrapper (in `src/utils/createClobClient.ts`, replacing its current contents) becomes the one place that knows how to authenticate. `postOrder.ts`'s `submitOrder()` — already the sole chokepoint for order placement — is rewritten to call `client.placeMarketOrder()` instead of `clobClient.createMarketOrder()` + `clobClient.postOrder()`. Order-book fetching moves from `clobClient.getOrderBook()` to the standalone `fetchOrderBook()` action. Three scripts with duplicated local `createClobClient` functions are consolidated onto the shared one. Two dead-weight files (`src/test/test.ts`, unused scratch code) are deleted rather than migrated.

**Tech Stack:** TypeScript, `@polymarket/client` (pinned exact version), Node.js `>=24`, existing Mongoose/MongoDB/PM2 infrastructure (unchanged).

**Spec:** `docs/superpowers/specs/2026-09-02-polymarket-client-migration-design.md`

## Global Constraints

- Pin `@polymarket/client` to an exact version in `package.json` (no `^`), mirroring the existing `@polymarket/clob-client-v2@1.0.1` exact pin — this package is pre-1.0 and under active development.
- `engines.node` becomes `>=24` in `package.json`.
- No live real-money order is placed as part of implementing or verifying this plan — validation stops at a dry-run (`DRY_RUN=true`) confirming the client initializes and can fetch real order-book/balance data. The real-order go/no-go decision belongs to the account owner, after this plan is complete.
- `@polymarket/real-time-data-client`, `websocketTradeMonitor.ts`, `newWalletWorker.ts`, and `tradeMonitor.ts` are out of scope — do not modify them in this plan.
- `getMyEOA.ts`/`positionHelpers.ts`'s EOA-vs-proxy-wallet query logic is out of scope — do not modify.
- Every task must leave `npm run build:strict` and `npm test` clean before moving to the next task.
- `@polymarket/clob-client-v2` is only uninstalled in the final task, after every other file has been migrated — this guarantees no task in between leaves the codebase in a state where some files still need the old package while it's already gone.

---

### Task 1: Confirm the exact runtime API shape with a standalone probe script

**Files:**
- Create: `src/scripts/probeSecureClient.ts` (temporary — deleted at the end of Task 1, not part of the final codebase)

**Interfaces:**
- Consumes: `@polymarket/client`'s `createSecureClient`, `privateKey` (from `@polymarket/client/viem`), `fetchOrderBook`, `fetchBalanceAllowance`, `AssetType` — all confirmed to exist via package inspection, but never called against this account's live API credentials yet.
- Produces: Confirmed, real (not just typed) knowledge of: what `createSecureClient({ wallet, signer })` actually returns and how long it takes; whether `fetchOrderBook`/`fetchBalanceAllowance` succeed against the real API; the exact shape of a real `AcceptedOrderResponse`/`RejectedOrderResponse` is NOT tested here (no order is placed) — only read-only calls.

This task exists because every subsequent task's code is written against `.d.ts` files inspected out-of-band, never executed against Polymarket's real API. A single read-only probe run surfaces any wrong assumption (auth failure, wrong parameter name, network/CORS issue) before it's baked into five files.

- [ ] **Step 1: Install the new package**

```bash
npm install @polymarket/client
```

Check what version was installed:

```bash
grep '"@polymarket/client"' package.json
```

- [ ] **Step 2: Write the probe script**

Create `src/scripts/probeSecureClient.ts`:

```typescript
import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { fetchOrderBook, fetchBalanceAllowance } from '@polymarket/client/actions';
import { AssetType } from '@polymarket/bindings/clob';
import { ENV } from '../config/env';

const main = async () => {
    console.log('🔍 Probing @polymarket/client SecureClient\n');
    console.log(`PROXY_WALLET: ${ENV.PROXY_WALLET}`);

    console.log('\n1. Creating SecureClient...');
    const client = await createSecureClient({
        wallet: ENV.PROXY_WALLET,
        signer: privateKey(ENV.PRIVATE_KEY),
    });
    console.log('   ✅ Client created');
    console.log('   Client keys:', Object.keys(client));

    console.log('\n2. Fetching balance/allowance (COLLATERAL)...');
    try {
        const balanceAllowance = await fetchBalanceAllowance(client, {
            assetType: AssetType.COLLATERAL,
        });
        console.log('   ✅ Balance/allowance response:', JSON.stringify(balanceAllowance, null, 2));
    } catch (error) {
        console.log('   ❌ Failed:', error);
    }

    console.log('\n3. Fetching order book for a known live token...');
    // Use any token ID currently visible in your MongoDB user_activity
    // collection, or a market you can see on polymarket.com right now.
    const KNOWN_TOKEN_ID = 'REPLACE_WITH_REAL_TOKEN_ID';
    try {
        const orderBook = await fetchOrderBook(client, { assetId: KNOWN_TOKEN_ID });
        console.log('   ✅ Order book bids:', orderBook.bids?.slice(0, 3));
        console.log('   ✅ Order book asks:', orderBook.asks?.slice(0, 3));
    } catch (error) {
        console.log('   ❌ Failed:', error);
    }

    console.log('\n4. Using client instance methods directly (if this shape exists)...');
    console.log('   Available on client:', Object.getOwnPropertyNames(Object.getPrototypeOf(client)));
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Probe failed:', error);
        process.exit(1);
    });
```

Before running, replace `KNOWN_TOKEN_ID` with a real token ID — find one by running `npm run check-stats` and copying an `asset` field from your current positions, or from a recent trade in MongoDB.

- [ ] **Step 3: Run the probe and record findings**

```bash
npx ts-node src/scripts/probeSecureClient.ts
```

Read the full output. Write down (in your task report, not in a committed file):
- Did `createSecureClient` succeed or throw? If it threw, capture the exact error.
- What top-level keys/methods does the returned `client` object expose? (This tells us whether `client.placeMarketOrder(...)` — the instance-method style shown in the docs — is real, or whether only the standalone action-function style (`placeOrder(client, ...)`) works.)
- Did `fetchBalanceAllowance` return real data matching what `npm run check-stats`/Polymarket's UI shows for this account?
- Did `fetchOrderBook` return real bid/ask data?

If `createSecureClient` throws an authentication or wallet-type error here, STOP and report back — this would mean the new SDK has its own issue with this specific deposit wallet, and the whole migration needs to be re-evaluated before continuing to Task 2.

- [ ] **Step 4: Delete the probe script**

```bash
rm src/scripts/probeSecureClient.ts
```

It was a throwaway diagnostic, not part of the final codebase — do not commit it.

- [ ] **Step 5: Commit the dependency addition**

```bash
git add package.json package-lock.json
git commit -m "add @polymarket/client dependency"
```

---

### Task 2: Rewrite `createClobClient.ts` as the shared SecureClient factory

**Files:**
- Modify: `src/utils/createClobClient.ts`

**Interfaces:**
- Consumes: `ENV.PROXY_WALLET`, `ENV.PRIVATE_KEY` (unchanged inputs); findings from Task 1 about the client's actual returned shape.
- Produces: `createClobClient(): Promise<SecureClient>` — same function name and same "no arguments, returns an authenticated client" contract as before, so every call site (`src/index.ts`, `closeResolvedPositions.ts`, `closeStalePositions.ts`) needs zero changes to *how* they call it, only to the imported type name if `ClobClient` is renamed.

This task deletes the entire `isGnosisSafe()` bytecode-detection function and both manual `ClobClient` construction calls (bootstrap + authenticated) — `createSecureClient` handles wallet-type detection and credential derivation internally in one call, per its own documented behavior: *"pass a supported Poly Deposit Wallet, Poly Safe, or Poly Proxy wallet address to use that wallet as the account/funder."*

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `src/utils/createClobClient.ts` with:

```typescript
import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;

/**
 * Creates an authenticated SecureClient for order placement.
 *
 * createSecureClient resolves the account's wallet type (EOA, Poly Proxy,
 * Poly Safe, or the newer Poly Deposit Wallet) internally from the `wallet`
 * address alone — unlike @polymarket/clob-client-v2, no manual bytecode
 * probing or SignatureTypeV2 selection is needed here.
 */
const createClobClient = async () => {
    return createSecureClient({
        wallet: PROXY_WALLET,
        signer: privateKey(PRIVATE_KEY),
    });
};

export default createClobClient;
```

**Note for the implementer:** the return type is intentionally left uninferred (no explicit `Promise<SecureClient<...>>` annotation) — let TypeScript infer it from `createSecureClient`'s actual return type, since the exact generic parameters (`SecureClient<PublicActions, SecureActions>`) are verbose and any mismatch will surface immediately as a type error in the files that consume it (Task 3+).

If Task 1's probe revealed the client shape is different from what the docs suggest (e.g., a different parameter name, or a need for `nonce`/`credentials`), adjust this to match what was actually observed, not what's written here — Task 1's findings are the source of truth, not this template.

- [ ] **Step 2: Build and check for immediate type errors**

```bash
npm run build:strict
```

This WILL fail right now — every file importing `ClobClient` as a type from `@polymarket/clob-client-v2` and consuming this function's return value needs updating (Tasks 3–9). Confirm the failures are ONLY in those expected downstream files, not in `createClobClient.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/utils/createClobClient.ts
git commit -m "rewrite createClobClient to use @polymarket/client's SecureClient"
```

---

### Task 3: Migrate `postOrder.ts`'s order submission and error handling

**Files:**
- Modify: `src/utils/postOrder.ts`
- Modify: `src/utils/errorHelpers.ts`

**Interfaces:**
- Consumes: the `SecureClient` return type from Task 2's `createClobClient.ts`; `AcceptedOrderResponse`/`RejectedOrderResponse`/`OrderResponseErrorCode` from `@polymarket/bindings/clob` (confirmed real, exported types — `OrderResponseErrorCode.INSUFFICIENT_BALANCE_OR_ALLOWANCE` is the exact enum member replacing today's string-matching).
- Produces: `submitOrder()`'s return type changes from `clob-client-v2`'s loosely-typed response to the real discriminated union `{ ok: true, ... } | { ok: false, code, message }`. Every call site in this same file that currently reads `resp.success`/`resp.transactionHash` must switch to `resp.ok`/`resp.transactionsHashes`.

This is the highest-risk task in the plan (per the spec's flagged risk: "error-response shape is unverified"). Task 1's probe did not place an order, so the exact shape of a REJECTED response for something like an insufficient-balance scenario is still not something we've seen live — only its documented type shape. Proceed carefully and re-verify after Task 1's dry-run-adjacent findings, but do not place a real order to test this (per Global Constraints).

- [ ] **Step 1: Update `errorHelpers.ts` to work with the new response shape**

Add a new helper alongside the existing ones (do not delete `extractErrorMessage`/`isInsufficientBalanceOrAllowanceError` yet — Task 9 removes them once nothing calls them):

```typescript
import { OrderResponseErrorCode } from '@polymarket/bindings/clob';

/**
 * @polymarket/client's OrderResponse is a discriminated union with a typed
 * `code: OrderResponseErrorCode` on rejection — an exact enum comparison
 * instead of clob-client-v2's fragile message string-matching.
 */
export const isInsufficientBalanceOrAllowanceCode = (
    code: OrderResponseErrorCode | undefined
): boolean => {
    return code === OrderResponseErrorCode.INSUFFICIENT_BALANCE_OR_ALLOWANCE;
};
```

- [ ] **Step 2: Rewrite `submitOrder()` in `postOrder.ts`**

Replace:

```typescript
const submitOrder = async (
    clobClient: ClobClient,
    orderArgs: { side: Side; tokenID: string; amount: number; price: number }
) => {
    if (DRY_RUN) {
        Logger.info(
            `🧪 [DRY_RUN] Would submit ${orderArgs.side} order: $${orderArgs.amount.toFixed(2)} @ $${orderArgs.price} (token ${orderArgs.tokenID})`
        );
        return { success: true, transactionHash: 'DRY_RUN_NO_TX' };
    }
    const signedOrder = await clobClient.createMarketOrder(orderArgs);
    return clobClient.postOrder(signedOrder, OrderType.FOK);
};
```

With:

```typescript
const submitOrder = async (
    client: SecureClientType,
    orderArgs: { side: 'BUY' | 'SELL'; tokenID: string; amount: number; price: number }
) => {
    if (DRY_RUN) {
        Logger.info(
            `🧪 [DRY_RUN] Would submit ${orderArgs.side} order: $${orderArgs.amount.toFixed(2)} @ $${orderArgs.price} (token ${orderArgs.tokenID})`
        );
        return {
            ok: true as const,
            orderId: 'DRY_RUN_NO_ID',
            status: 'matched',
            makingAmount: String(orderArgs.amount),
            takingAmount: String(orderArgs.amount / orderArgs.price),
            transactionsHashes: ['DRY_RUN_NO_TX'],
            tradeIds: [],
        };
    }

    if (orderArgs.side === 'BUY') {
        return client.placeMarketOrder({
            tokenId: orderArgs.tokenID,
            side: OrderSide.BUY,
            amount: orderArgs.amount,
            maxPrice: orderArgs.price,
        });
    }

    // SELL orders take `shares` (token quantity), not a dollar `amount` —
    // orderArgs.amount is already a token count for SELL call sites in this
    // file (see the merge/sell branches below), matching this distinction.
    return client.placeMarketOrder({
        tokenId: orderArgs.tokenID,
        side: OrderSide.SELL,
        shares: orderArgs.amount,
        minPrice: orderArgs.price,
    });
};
```

Add the needed imports at the top of the file:

```typescript
import { OrderSide } from '@polymarket/client';
import type { Awaited } from ...; // or inline: type SecureClientType = Awaited<ReturnType<typeof import('./createClobClient').default>>;
```

**Note for the implementer:** define `SecureClientType` by importing `createClobClient`'s return type directly rather than trying to import `SecureClient<...>`'s full generic signature from `@polymarket/client` — e.g.:

```typescript
import type createClobClient from './createClobClient';
type SecureClientType = Awaited<ReturnType<typeof createClobClient>>;
```

This avoids having to spell out the library's internal generic parameters, which are not meant to be constructed by hand.

**Critical: verify the `side` argument type.** Every call site in this file currently passes `side: Side.BUY`/`Side.SELL` from `clob-client-v2`'s `Side` enum. Check whether `OrderSide.BUY`/`OrderSide.SELL` from `@polymarket/client` is a compatible drop-in (same string/numeric values) or whether call sites need updating to pass `OrderSide` instead of `Side`. Grep for `Side\.` in this file to find every call site.

- [ ] **Step 3: Update every `resp.success`/`resp.transactionHash` read**

Search this file for `.success` and `.transactionHash` (there are three near-identical response-handling blocks: merge, buy, sell). Each currently does:

```typescript
if (resp.success === true) {
    // ... use resp.transactionHash
} else {
    const errorMessage = extractErrorMessage(resp);
    // ...
    if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
```

Change each occurrence to:

```typescript
if (resp.ok === true) {
    // ... use resp.transactionsHashes[0] (now an array; earlier code assumed a single hash)
} else {
    const errorMessage = resp.message;
    // ...
    if (isInsufficientBalanceOrAllowanceCode(resp.code)) {
```

**Note for the implementer:** `resp.transactionsHashes` is `TxHash[]`, not a single string — the old `transactionHash` field doesn't exist anymore. Every place that logs or passes `resp.transactionHash` (there are several, including into `TelegramNotifier.notifyTrade({ transactionHash: resp.transactionHash })`) needs `resp.transactionsHashes[0]` instead, with a fallback for the empty-array case documented in `AcceptedOrderResponse`'s own comment ("can be empty even when the order matched"). Use `resp.transactionsHashes[0] ?? undefined` and confirm `TelegramNotifier.notifyTrade`'s parameter accepts `undefined`.

- [ ] **Step 4: Update the order-book fetching calls**

This file calls `clobClient.getOrderBook(trade.asset)` (in the merge, buy, and sell branches) and reads `orderBook.bids`/`orderBook.asks`. Replace each with:

```typescript
import { fetchOrderBook } from '@polymarket/client/actions';
// ...
const orderBook = await fetchOrderBook(clobClient, { assetId: trade.asset });
```

The rest of each block's `.bids`/`.asks` handling (the `.reduce()` best-price walk) needs no change — confirmed identical shape per the SDK's own documented example (`orderBook.bids / orderBook.asks`).

- [ ] **Step 5: Update the function signature and all internal type references**

`postOrder()`'s own signature currently takes `clobClient: ClobClient` as its first parameter. Change this (and every internal reference) to the `SecureClientType` alias defined in Step 2. Update the `ClobClient`/`OrderType`/`Side` import at the top of the file — remove the `@polymarket/clob-client-v2` import entirely once nothing in this file references it.

- [ ] **Step 6: Build and fix remaining type errors**

```bash
npm run build:strict
```

Fix any remaining type mismatches in this file only — do not yet touch `tradeExecutor.ts` or the scripts (Tasks 4–8 handle those; expect their import of `postOrder` to still show errors until then).

- [ ] **Step 7: Run existing tests**

```bash
npm test
```

Confirm all 56 existing tests still pass (none currently exercise `postOrder.ts`'s CLOB-calling internals directly, so no test rewrites are expected — but if any test does mock `ClobClient`, update the mock to match the new client shape).

- [ ] **Step 8: Commit**

```bash
git add src/utils/postOrder.ts src/utils/errorHelpers.ts
git commit -m "migrate postOrder.ts to @polymarket/client's placeMarketOrder"
```

---

### Task 4: Migrate `tradeExecutor.ts`'s type references

**Files:**
- Modify: `src/services/tradeExecutor.ts`

**Interfaces:**
- Consumes: `SecureClientType` (defined in Task 3, or re-exported from `createClobClient.ts` for reuse — implementer's choice, prefer re-exporting to avoid two independent definitions of the same type alias drifting apart).
- Produces: no behavioral change — this file only imports `ClobClient` as a TypeScript type and passes a client instance through to `postOrder`/`doTrading`/`doAggregatedTrading`; it never calls CLOB methods directly.

- [ ] **Step 1: Replace the type import**

Change:

```typescript
import { ClobClient } from '@polymarket/clob-client-v2';
```

To import the same `SecureClientType` alias used in `postOrder.ts` (prefer exporting it from `postOrder.ts` or `createClobClient.ts` rather than redefining it here — pick one canonical location and import it everywhere else that needs it, to avoid three independent `Awaited<ReturnType<...>>` definitions across the codebase that could silently diverge if `createClobClient`'s signature ever changes).

- [ ] **Step 2: Replace every `ClobClient` type annotation in this file**

Grep for `ClobClient` in `tradeExecutor.ts` — every occurrence (function parameters like `processTradeBatch(clobClient: ClobClient, ...)`, `doTrading`, `doAggregatedTrading`, `executeSingleTrade`, `prepareTradeData` if applicable) needs the type swapped to the new alias. The parameter name `clobClient` can stay as-is — only the type annotation changes.

- [ ] **Step 3: Build**

```bash
npm run build:strict
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/services/tradeExecutor.ts
git commit -m "update tradeExecutor.ts's ClobClient type references"
```

---

### Task 5: Consolidate `manualSell.ts`, `checkTraderAndSell.ts`, `sellLargePositions.ts` onto the shared client

**Files:**
- Modify: `src/scripts/manualSell.ts`
- Modify: `src/scripts/checkTraderAndSell.ts`
- Modify: `src/scripts/sellLargePositions.ts`

**Interfaces:**
- Consumes: `createClobClient` from `../utils/createClobClient` (Task 2's rewritten version).
- Produces: no change to these scripts' actual sell logic — only their client-creation path changes from a duplicated local `isGnosisSafe`/`createClobClient` pair to importing the shared function.

All three scripts currently contain an identical ~40-line local `isGnosisSafe` + `createClobClient` pair (confirmed byte-for-byte identical across all three during planning). This task deletes all three local copies and imports the shared, already-migrated function instead — reducing three places needing the new SDK's logic to one (already done in Task 2).

- [ ] **Step 1: In each of the three files, delete the local `isGnosisSafe` and `createClobClient` functions**

Each file has a block shaped like:

```typescript
const isGnosisSafe = async (
    address: string,
    provider: ethers.providers.JsonRpcProvider
): Promise<boolean> => { ... };

const createClobClient = async (
    provider: ethers.providers.JsonRpcProvider
): Promise<ClobClient> => { ... };
```

Delete both functions entirely from all three files.

- [ ] **Step 2: Replace the import and call sites**

Add to each file's imports:

```typescript
import createClobClient from '../utils/createClobClient';
```

Remove the now-unused `ClobClient`, `SignatureTypeV2` (and `AssetType`/`OrderType`/`Side` if no longer used elsewhere in that specific file — check each file individually, since e.g. `AssetType` may still be needed for other calls in the same script) imports from `@polymarket/clob-client-v2`.

Each file currently calls its local function as `await createClobClient(provider)`, passing an `ethers.providers.JsonRpcProvider`. The shared `createClobClient()` (Task 2) takes **no arguments** — update each call site from:

```typescript
const clobClient = await createClobClient(provider);
```

to:

```typescript
const clobClient = await createClobClient();
```

Check whether `provider` is still used elsewhere in that file after this change (e.g., for other on-chain calls) — if not, and the removal leaves it unused, remove the now-dead `provider` variable/parameter too; if it's still used, leave it.

- [ ] **Step 3: Update each file's own order-placement/order-book calls**

Each of these three scripts likely has its own `clobClient.createMarketOrder()`/`clobClient.postOrder()`/`clobClient.getOrderBook()` calls (separate from `postOrder.ts`'s, since these are standalone scripts with their own trading logic, e.g. `manualSell.ts`'s `sellEntirePosition`-style logic). Read each file's remaining CLOB-calling code and apply the same pattern from Task 3, Steps 2 and 4 (swap `createMarketOrder`+`postOrder` for `placeMarketOrder`; swap `getOrderBook` for `fetchOrderBook`; swap `resp.success`/`resp.transactionHash` for `resp.ok`/`resp.transactionsHashes`).

- [ ] **Step 4: Build each file**

```bash
npm run build:strict
```

- [ ] **Step 5: Commit**

```bash
git add src/scripts/manualSell.ts src/scripts/checkTraderAndSell.ts src/scripts/sellLargePositions.ts
git commit -m "consolidate manualSell/checkTraderAndSell/sellLargePositions onto shared SecureClient"
```

---

### Task 6: Migrate `closeResolvedPositions.ts` and `closeStalePositions.ts`

**Files:**
- Modify: `src/scripts/closeResolvedPositions.ts`
- Modify: `src/scripts/closeStalePositions.ts`

**Interfaces:**
- Consumes: `createClobClient` from `../utils/createClobClient` (already imported and called with no arguments in both files today — these already use the shared function, so this task is purely about their own order-placement calls, not client creation).

These two files already call the shared `createClobClient()` correctly (confirmed during planning — they're not part of the duplication problem Task 5 fixes). This task only touches their own `clobClient.createMarketOrder`/`postOrder`/`getOrderBook` calls, following the same pattern as Task 3.

- [ ] **Step 1: Read each file's CLOB-calling code and identify every `createMarketOrder`, `postOrder`, `getOrderBook`, `Side`, `OrderType` usage**

- [ ] **Step 2: Apply the same substitutions as Task 3** (placeMarketOrder instead of createMarketOrder+postOrder; fetchOrderBook instead of getOrderBook; resp.ok/resp.transactionsHashes instead of resp.success/resp.transactionHash; OrderSide instead of Side)

- [ ] **Step 3: Build**

```bash
npm run build:strict
```

- [ ] **Step 4: Commit**

```bash
git add src/scripts/closeResolvedPositions.ts src/scripts/closeStalePositions.ts
git commit -m "migrate closeResolvedPositions.ts and closeStalePositions.ts to @polymarket/client"
```

---

### Task 7: Migrate `checkAllowance.ts`

**Files:**
- Modify: `src/scripts/checkAllowance.ts`

**Interfaces:**
- Consumes: `createClobClient` from `../utils/createClobClient`; `fetchBalanceAllowance`/`AssetType` from `@polymarket/client`/`@polymarket/bindings`.

This file's `buildClobClient()` function is the same bootstrap-then-authenticate duplication pattern as Task 5's three scripts, but with slightly different error handling around API key derivation (a try/catch around `createOrDeriveApiKey()` that produces a warning instead of throwing). Since `createSecureClient` handles credential derivation internally and doesn't expose this two-step process, this special-casing is no longer meaningful in the same way — but preserve the *intent* (don't let API-key-derivation failure silently produce a broken client) by wrapping the single `createSecureClient()` call in a try/catch instead.

- [ ] **Step 1: Delete `buildClobClient()` entirely**

- [ ] **Step 2: Replace its call site**

Find where `buildClobClient(provider)` is called (likely in `main()`), and replace with:

```typescript
import createClobClient from '../utils/createClobClient';
// ...
let clobClient;
try {
    clobClient = await createClobClient();
} catch (error) {
    console.log(`⚠️  Unable to create authenticated client: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
}
```

- [ ] **Step 3: Read the rest of the file for allowance-checking logic that calls `clobClient` methods directly**

This script's core purpose is checking/displaying USDC allowance status — read what it does after client creation (balance/allowance queries, possibly `clobClient.updateBalanceAllowance` or similar cache-sync calls per the pattern seen in `closeResolvedPositions.ts`'s `updatePolymarketCache`). Map each to the `@polymarket/client` equivalent: `fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL })` for reads; check whether an `updateBalanceAllowance` action exists in `@polymarket/client` for any cache-sync calls (confirmed present: `updateBalanceAllowance` was seen in the export list during planning — verify its exact signature when implementing).

- [ ] **Step 4: Build**

```bash
npm run build:strict
```

- [ ] **Step 5: Commit**

```bash
git add src/scripts/checkAllowance.ts
git commit -m "migrate checkAllowance.ts to @polymarket/client"
```

---

### Task 8: Handle `setTokenAllowance.ts` and delete dead code

**Files:**
- Modify: `src/scripts/setTokenAllowance.ts`
- Delete: `src/test/test.ts`

**Interfaces:**
- Consumes: nothing new — `setTokenAllowance.ts` only needs its single `getContractConfig` import replaced with a hardcoded constant, since it does all its real work via raw `ethers.Contract` calls unrelated to either CLOB library.

`setTokenAllowance.ts` imports `getContractConfig` from `@polymarket/clob-client-v2` solely to read `.conditionalTokens` (the CTF contract address). It performs no order placement and needs no `SecureClient`. Since Global Constraints require fully removing `@polymarket/clob-client-v2` at the end of this plan, this one import must be replaced with a hardcoded value — the same CTF contract address is already hardcoded elsewhere in the codebase (`src/scripts/redeemResolvedPositions.ts`'s `CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'`), confirming it's a stable, safe-to-hardcode constant.

`src/test/test.ts` is unreferenced by any `package.json` script (confirmed during planning), contains only commented-out experiments plus one untested code path, and is not part of the automated trading pipeline. It is deleted rather than migrated.

- [ ] **Step 1: Update `setTokenAllowance.ts`**

Replace:

```typescript
import { getContractConfig } from '@polymarket/clob-client-v2';
// ...
const CTF_CONTRACT = getContractConfig(POLYGON_CHAIN_ID).conditionalTokens;
```

With:

```typescript
// Polymarket's Conditional Token Framework contract on Polygon — stable,
// chain-level constant (same value already hardcoded in
// redeemResolvedPositions.ts's CTF_CONTRACT_ADDRESS).
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
```

Remove the now-unused `POLYGON_CHAIN_ID` constant if nothing else in the file uses it after this change (check first).

- [ ] **Step 2: Delete `src/test/test.ts`**

```bash
rm src/test/test.ts
```

Check whether the now-empty `src/test/` directory should also be removed (only if nothing else lives there):

```bash
ls src/test/
```

If empty, remove the directory too.

- [ ] **Step 3: Build**

```bash
npm run build:strict
```

- [ ] **Step 4: Commit**

```bash
git add src/scripts/setTokenAllowance.ts
git add -u src/test/
git commit -m "remove clob-client-v2 dependency from setTokenAllowance.ts; delete unused test.ts scratch file"
```

---

### Task 9: Remove dead error-handling code, bump Node engine, uninstall clob-client-v2

**Files:**
- Modify: `src/utils/errorHelpers.ts`
- Modify: `package.json`
- Modify: `docs/GCP_DEPLOYMENT.md`

**Interfaces:**
- Consumes: confirmation from every prior task that no file still imports `@polymarket/clob-client-v2` or calls `extractErrorMessage`/`isInsufficientBalanceOrAllowanceError`.
- Produces: a fully clean removal — `npm ls @polymarket/clob-client-v2` reports nothing installed, `grep -r "clob-client-v2" src/` reports nothing.

- [ ] **Step 1: Confirm nothing still imports the old package**

```bash
grep -rn "clob-client-v2" src/
```

This MUST return no results. If it does, STOP and go back to whichever earlier task's file still has the import — do not proceed to uninstalling with references still in place.

- [ ] **Step 2: Confirm nothing still calls the old error helpers**

```bash
grep -rn "extractErrorMessage\|isInsufficientBalanceOrAllowanceError\b" src/
```

If any call sites remain (outside their own definitions in `errorHelpers.ts`), they were missed in Task 3/5/6/7 — go back and fix them first.

- [ ] **Step 3: Remove the now-unused old helpers from `errorHelpers.ts`**

Delete `extractErrorMessage` and `isInsufficientBalanceOrAllowanceError` (keep `isInsufficientBalanceOrAllowanceCode`, `formatError`, `getErrorStack` — those remain in use).

- [ ] **Step 4: Update `package.json`**

```bash
npm uninstall @polymarket/clob-client-v2
```

Then edit `engines.node`:

```diff
     "engines": {
-        "node": ">=18.0.0",
+        "node": ">=24.0.0",
         "npm": ">=9.0.0"
     },
```

- [ ] **Step 5: Update `docs/GCP_DEPLOYMENT.md`'s Node install step**

Find the nodesource setup line (step 6, per the doc's own numbering) and bump the version:

```diff
-curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
+curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```

Add a note nearby that this bot now requires Node >=24 specifically because of `@polymarket/client`, so a future reader doesn't assume this is an arbitrary version choice.

- [ ] **Step 6: Full clean build and test**

```bash
rm -rf node_modules dist
npm install
npm run build:strict
npm test
```

All 56 tests must pass; build must be clean with zero references to the removed package.

- [ ] **Step 7: Commit**

```bash
git add src/utils/errorHelpers.ts package.json package-lock.json docs/GCP_DEPLOYMENT.md
git commit -m "remove @polymarket/clob-client-v2; bump Node engine requirement to >=24"
```

---

### Task 10: Local dry-run verification

**Files:** none modified — verification only.

**Interfaces:** none — this task exercises the full running system end-to-end in dry-run mode.

- [ ] **Step 1: Confirm `.env` has `DRY_RUN=true`**

```bash
grep "^DRY_RUN" .env
```

If not set to `true`, temporarily set it for this verification step (revert after, or leave it — the account owner controls when to flip it for real trading, per Global Constraints).

- [ ] **Step 2: Run the bot locally**

```bash
npm run dev
```

Watch the startup logs for:
- `createClobClient()` succeeding without error (no thrown `CreateSecureClientError`)
- The health check / initial balance fetch showing a real, non-zero, non-error pUSD balance matching what Polymarket's UI shows for this account
- The trade monitor and executor starting normally (this part is unaffected by this migration, but confirms nothing else broke)

Let it run for a few minutes if any tracked trader is actively trading, to observe a dry-run "would submit" log line fire — this exercises `postOrder.ts`'s new `submitOrder()` path (including the DRY_RUN branch) without placing a real order.

- [ ] **Step 3: Run each migrated script's `--help`-equivalent or safe read path**

For scripts that are safe to run read-only (`checkAllowance.ts` reads before it ever writes; `manualSell.ts`/`checkTraderAndSell.ts`/`sellLargePositions.ts` fetch positions before attempting any sell), run each and confirm it reaches the client-creation and data-fetching stage without error:

```bash
npm run check-allowance
```

Stop before any script reaches an actual order-placement confirmation prompt (if one exists) or a real transaction step — the goal here is confirming client creation and read-path calls work, not exercising the write path.

- [ ] **Step 4: Stop and hand off**

Report the dry-run results. Per Global Constraints, this plan's work is complete once dry-run verification passes — deploying to the VM and placing any real order is the account owner's decision and action, not part of this plan's scope.

---

## Final Verification Checklist

- [ ] `grep -rn "clob-client-v2" src/` returns nothing
- [ ] `npm ls @polymarket/clob-client-v2` reports "not installed" or similar
- [ ] `npm run build:strict` is clean
- [ ] `npm test` — all 56+ tests pass
- [ ] `npm run dev` with `DRY_RUN=true` starts cleanly and shows a real balance
- [ ] `docs/GCP_DEPLOYMENT.md` reflects Node >=24
- [ ] `package.json`'s `engines.node` reflects >=24
- [ ] No real order was placed at any point during this plan's execution
