# Self-Tracked My-Positions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live, per-trade `fetchPositionForMarket(MY_EOA_ADDRESS, conditionId)` API call in `tradeExecutor.ts` with a Mongo read against a new, self-maintained `my_positions` collection — since the bot itself is the only actor that can change its own position, that collection can be kept accurate by writing to it at the exact moment each of our own fills is confirmed, with no polling needed for the steady-state case.

**Architecture:** A new single (non-per-address) Mongoose collection `my_positions`, keyed by `conditionId`. `postOrder.ts` upserts it on every successful BUY/SELL fill inside the existing retry loops. `tradeExecutor.ts` reads from it instead of calling the live API. A one-time seed script backfills it from the live API before this ships (the collection starts empty otherwise). A periodic reconciliation tick — folded into `tradeMonitor.ts`'s existing `FETCH_INTERVAL` loop, the same pattern that already keeps trader position caches fresh — re-syncs the whole collection from the live (already-paginated) API, bounding drift introduced by the CLI scripts (`manualSell.ts`, `sellLargePositions.ts`, `closeStalePositions.ts`, `closeResolvedPositions.ts`, `redeemResolvedPositions.ts`) that can change our on-chain position outside `postOrder.ts`.

**Tech Stack:** TypeScript, Mongoose, existing `data-api.polymarket.com/positions` REST client (`fetchData`), Jest.

**Spec:** No separate spec doc — this plan was scoped directly through conversation (see plan history). Binding decisions made during scoping, treated as this plan's spec:
- `avgPrice` recomputes as a size-weighted average of cost, mirroring the live API's own definition: `newAvgPrice = (oldSize*oldAvgPrice + tokensBought*fillPrice) / (oldSize+tokensBought)` on BUY; unchanged on SELL (standard cost-basis accounting).
- CLI scripts that can change on-chain position outside `postOrder.ts` are explicitly NOT modified to write to `my_positions` in this plan — reconciliation is the chosen mitigation for their drift, not per-script cache writes.
- Bootstrap is a one-time manual seed script, not a live-API fallback baked into the read path.

## Global Constraints

- Only two fields of a position are ever read anywhere in the trading/sizing path: `size` and `avgPrice` (confirmed via grep across `postOrder.ts` — no other `UserPositionInterface` field is read for sizing decisions there). The new collection's schema must supply at least these two, keyed by `conditionId`.
- Reuse `UserPositionInterface` (`src/interfaces/User.ts`) as the shape for `my_positions` documents — do not invent a new interface. Fields not tracked by this system (e.g. `curPrice`, `percentPnl`) are acceptable to leave absent/zeroed on self-tracked docs; nothing in the trading path reads them for our own position.
- `postOrder.ts`'s existing retry-loop control flow, sizing math, Telegram notification calls, and `UserActivity.updateOne(...)` bookkeeping must not change — only add a new DB write immediately after each confirmed fill (`resp.ok === true`).
- `tradeExecutor.ts`'s `myPosition` fetch for BUY and SELL must both switch to the DB read. Do not touch the trader-side `userPosition` read (already DB-backed from the prior plan) or `myBalance` (via `getMyBalance`, unrelated to positions).
- The reconciliation tick lives inside `tradeMonitor.ts`'s existing `while (isRunning) { ... }` loop in `tradeMonitor()`, as a sibling call alongside the existing `fetchTradeData()` — not inside `fetchTradeData()` itself (that function is per-trader; this reconciliation is single-wallet, not per-trader).
- `websocketTradeMonitor.ts` is experimental and not wired into `src/index.ts` (confirmed via CLAUDE.md and grep) — out of scope for this plan. Do not modify it.
- All new/changed files must pass `npm run build:strict`, `npx eslint <changed files>` (0 new errors; pre-existing warnings elsewhere are not this plan's concern), and `npm test` (56/56 passing baseline, from `main` at commit `29061b2`).
- Dispatch the `trading-safety-reviewer` subagent (Tools: Read, Grep, Glob, Bash) against the full diff before this plan's final integration step — this touches order execution and position sizing with real funds on the line.

---

## Task 1: Add `my_positions` Mongoose model

**Files:**
- Create: `src/models/myPosition.ts`
- Test: `src/models/__tests__/myPosition.test.ts`

**Interfaces:**
- Produces: `getMyPositionModel(): mongoose.Model<...>` — a singleton model (NOT parameterized by address, unlike `getUserPositionModel`/`getUserActivityModel` in `userHistory.ts`, since there is exactly one bot wallet). Collection name: `my_positions`.
- Produces: schema fields `conditionId: string` (unique), `asset: string`, `size: number`, `avgPrice: number`, `totalBought: number`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

```typescript
// src/models/__tests__/myPosition.test.ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getMyPositionModel } from '../myPosition';

describe('MyPositionModel schema', () => {
    let mongoServer: MongoMemoryServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoServer.stop();
    });

    afterEach(async () => {
        await mongoose.connection.collection('my_positions').deleteMany({});
    });

    it('should build a valid document with required fields', async () => {
        const MyPosition = getMyPositionModel();
        const doc = await MyPosition.create({
            conditionId: '0xabc',
            asset: '123',
            size: 10.5,
            avgPrice: 0.42,
            totalBought: 10.5,
        });
        expect(doc.conditionId).toBe('0xabc');
        expect(doc.size).toBe(10.5);
        expect(doc.avgPrice).toBe(0.42);
    });

    it('should enforce conditionId uniqueness', async () => {
        const MyPosition = getMyPositionModel();
        await MyPosition.create({ conditionId: '0xdup', asset: '1', size: 1, avgPrice: 1, totalBought: 1 });
        await expect(
            MyPosition.create({ conditionId: '0xdup', asset: '2', size: 2, avgPrice: 2, totalBought: 2 })
        ).rejects.toThrow();
    });

    it('should return the same collection name across calls', () => {
        const a = getMyPositionModel();
        const b = getMyPositionModel();
        expect(a.collection.name).toBe('my_positions');
        expect(b.collection.name).toBe('my_positions');
    });
});
```

Check whether `mongodb-memory-server` is already a devDependency before assuming it's available:

```bash
grep -n "mongodb-memory-server" package.json
```

If absent, check how the existing `src/models/__tests__/seenWallet.test.ts` and `src/models/__tests__/trackedTrader.test.ts` set up Mongoose for tests instead (read those two files first) and mirror their exact setup pattern rather than introducing a new test dependency.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/myPosition.test.ts`
Expected: FAIL with "Cannot find module '../myPosition'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/models/myPosition.ts
import mongoose, { Schema } from 'mongoose';

const myPositionSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    conditionId: { type: String, required: true, unique: true },
    asset: { type: String, required: false },
    size: { type: Number, required: true, default: 0 },
    avgPrice: { type: Number, required: true, default: 0 },
    totalBought: { type: Number, required: false, default: 0 },
});

let cachedModel: mongoose.Model<mongoose.Document> | null = null;

/**
 * Single collection for the bot's own wallet's positions — unlike
 * getUserPositionModel/getUserActivityModel (one collection per tracked
 * trader address), there is exactly one bot wallet, so this is not
 * parameterized. Cached across calls so repeated calls return the same
 * compiled model (mongoose throws OverwriteModelError otherwise).
 */
export const getMyPositionModel = () => {
    if (cachedModel) {
        return cachedModel;
    }
    cachedModel = mongoose.model('my_positions', myPositionSchema, 'my_positions');
    return cachedModel;
};
```

Match this model's structure/style to `src/models/userHistory.ts`'s existing `positionSchema` — reuse the same field types, just without the per-address parameterization. If `userHistory.ts` does NOT cache its models the same way (recheck it — mongoose collection names there are dynamic per address, so the OverwriteModelError risk may not apply the same way there), match whatever pattern it actually uses rather than inventing a different one, and note the discrepancy in your task report.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/models/__tests__/myPosition.test.ts`
Expected: PASS, all 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/models/myPosition.ts src/models/__tests__/myPosition.test.ts
git commit -m "Add my_positions Mongoose model for self-tracked bot position"
```

---

## Task 2: Write to `my_positions` on every confirmed fill in `postOrder.ts`

**Files:**
- Modify: `src/utils/postOrder.ts` (two call sites — the BUY fill-success branch and the SELL fill-success branch)
- Test: `src/utils/__tests__/postOrder.myPositionWrites.test.ts` (new)

**Interfaces:**
- Consumes: `getMyPositionModel()` from Task 1 (`src/models/myPosition.ts`).
- Produces: two internal helper functions in `postOrder.ts` — `recordBuyFill(conditionId: string, asset: string, tokensBought: number, fillPrice: number): Promise<void>` and `recordSellFill(conditionId: string, tokensSold: number): Promise<void>`. These are internal (not exported) — Task 3 does not call them directly, it reads `my_positions` via the model directly.

Read the current `postBuyOrder` and `postSellOrder` functions in full before editing — their retry loops, Telegram notification calls, and `UserActivity.updateOne` bookkeeping must be preserved exactly; you are only inserting one new call per fill-success branch.

- [ ] **Step 1: Write the failing test**

This is best tested as an integration-style test against the retry loop's fill-success branches, using a mocked `client.placeMarketOrder`/`submitOrder` the way any existing `postOrder.ts` tests do (check `src/utils/__tests__/` for an existing `postOrder` test file first — if one already exists, follow its exact mocking setup rather than introducing a new approach).

```bash
ls src/utils/__tests__/ | grep -i postorder
```

If no existing test file mocks `postOrder.ts`'s dependencies, write a narrower unit test directly against the two new helper functions instead (exporting them for testability is acceptable — prefix with an underscore or add a comment marking them test-only exports if the codebase has a convention for that; check `postOrder.ts`'s existing exports for a precedent first):

```typescript
// src/utils/__tests__/postOrder.myPositionWrites.test.ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server'; // or match Task 1's chosen test setup
import { getMyPositionModel } from '../../models/myPosition';
import { __test_recordBuyFill, __test_recordSellFill } from '../postOrder';

describe('my_positions writes on fill', () => {
    let mongoServer: MongoMemoryServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoServer.stop();
    });

    afterEach(async () => {
        await mongoose.connection.collection('my_positions').deleteMany({});
    });

    it('creates a new position doc on first BUY fill', async () => {
        await __test_recordBuyFill('0xcond1', 'asset1', 10, 0.5);
        const doc = await getMyPositionModel().findOne({ conditionId: '0xcond1' }).lean();
        expect(doc?.size).toBe(10);
        expect(doc?.avgPrice).toBe(0.5);
        expect(doc?.totalBought).toBe(10);
    });

    it('weighted-averages avgPrice across two BUY fills', async () => {
        await __test_recordBuyFill('0xcond2', 'asset2', 10, 0.5); // cost 5
        await __test_recordBuyFill('0xcond2', 'asset2', 10, 0.7); // cost 7
        const doc = await getMyPositionModel().findOne({ conditionId: '0xcond2' }).lean();
        expect(doc?.size).toBe(20);
        expect(doc?.avgPrice).toBeCloseTo(0.6, 5); // (5+7)/20
        expect(doc?.totalBought).toBe(20);
    });

    it('decrements size on SELL fill without changing avgPrice', async () => {
        await __test_recordBuyFill('0xcond3', 'asset3', 10, 0.5);
        await __test_recordSellFill('0xcond3', 4);
        const doc = await getMyPositionModel().findOne({ conditionId: '0xcond3' }).lean();
        expect(doc?.size).toBeCloseTo(6, 5);
        expect(doc?.avgPrice).toBe(0.5);
    });

    it('removes the doc when a SELL fill brings size to ~0', async () => {
        await __test_recordBuyFill('0xcond4', 'asset4', 10, 0.5);
        await __test_recordSellFill('0xcond4', 10);
        const doc = await getMyPositionModel().findOne({ conditionId: '0xcond4' }).lean();
        expect(doc).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/utils/__tests__/postOrder.myPositionWrites.test.ts`
Expected: FAIL with "__test_recordBuyFill is not exported" (or similar)

- [ ] **Step 3: Write minimal implementation**

Add near the top of `postOrder.ts`, after existing imports:

```typescript
import { getMyPositionModel } from '../models/myPosition';
```

Add these two functions (placed after `submitOrder`, before `postBuyOrder` — same general area as `MIN_ORDER_SIZE_USD`/`MIN_ORDER_SIZE_TOKENS`):

```typescript
// Positions rounding at or below this are treated as fully closed — avoids
// leaving a stray doc with a near-zero float remainder after a full sell.
const POSITION_DUST_THRESHOLD = 1e-6;

/**
 * Records a confirmed BUY fill against our own self-tracked position.
 * avgPrice is recomputed as a size-weighted average of cost — the same
 * definition the live /positions API itself uses — so this stays
 * consistent with what fetchMyPositionsAndBalance would have reported for
 * a position built from just these fills.
 */
const recordBuyFill = async (
    conditionId: string,
    asset: string,
    tokensBought: number,
    fillPrice: number
): Promise<void> => {
    const MyPosition = getMyPositionModel();
    const existing = await MyPosition.findOne({ conditionId }).lean();
    const oldSize = (existing as { size?: number } | null)?.size ?? 0;
    const oldAvgPrice = (existing as { avgPrice?: number } | null)?.avgPrice ?? 0;
    const oldTotalBought = (existing as { totalBought?: number } | null)?.totalBought ?? 0;

    const newSize = oldSize + tokensBought;
    const newAvgPrice = (oldSize * oldAvgPrice + tokensBought * fillPrice) / newSize;

    await MyPosition.findOneAndUpdate(
        { conditionId },
        {
            $set: {
                conditionId,
                asset,
                size: newSize,
                avgPrice: newAvgPrice,
                totalBought: oldTotalBought + tokensBought,
            },
        },
        { upsert: true }
    );
};

/**
 * Records a confirmed SELL fill against our own self-tracked position.
 * avgPrice is left unchanged — standard cost-basis accounting: selling
 * some shares doesn't change the average cost of the shares that remain.
 * Deletes the doc once size rounds to ~0 so a stale zero-size record can't
 * be misread later as "still holding a dust amount."
 */
const recordSellFill = async (conditionId: string, tokensSold: number): Promise<void> => {
    const MyPosition = getMyPositionModel();
    const existing = await MyPosition.findOne({ conditionId }).lean();
    if (!existing) {
        // Nothing to reconcile against — this can only happen if my_positions
        // was never seeded/reconciled for a position we somehow hold. Leave
        // it absent rather than fabricate a negative-size document.
        return;
    }
    const oldSize = (existing as { size?: number }).size ?? 0;
    const newSize = oldSize - tokensSold;

    if (newSize <= POSITION_DUST_THRESHOLD) {
        await MyPosition.deleteOne({ conditionId });
        return;
    }

    await MyPosition.updateOne({ conditionId }, { $set: { size: newSize } });
};

// Test-only exports — not part of the module's public surface for
// production callers, which never need to write my_positions directly.
export const __test_recordBuyFill = recordBuyFill;
export const __test_recordSellFill = recordSellFill;
```

Before adding the `__test_recordBuyFill`/`__test_recordSellFill` exports, grep `postOrder.ts` and the wider codebase for an existing test-export convention:

```bash
grep -rn "__test_\|VisibleForTesting\|@internal" src/ --include="*.ts" | grep -v __tests__
```

If a different convention already exists, use that one instead and note the substitution in your task report.

Now wire the two calls into the existing fill-success branches. In `postBuyOrder`, inside the `while (remaining > 0 && retry < RETRY_LIMIT)` loop, in the `if (resp.ok === true) { ... }` branch — immediately after the existing line `totalBoughtTokens += tokensBought;` and before the `Logger.orderResult(...)` call — add:

```typescript
await recordBuyFill(trade.conditionId, trade.asset, tokensBought, order_arges.price);
```

In `postSellOrder`, inside its own `while (remaining > 0 && retry < RETRY_LIMIT)` loop, in the `if (resp.ok === true) { ... }` branch — immediately after the existing line `totalSoldTokens += order_arges.amount;` and before the `Logger.orderResult(...)` call — add:

```typescript
await recordSellFill(trade.conditionId, order_arges.amount);
```

Confirm `trade.conditionId` and `trade.asset` are in scope at both call sites (they are — `trade: UserActivityInterface` is a parameter of both `postBuyOrder` and `postSellOrder`, and `UserActivityInterface` has both fields per `src/interfaces/User.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/utils/__tests__/postOrder.myPositionWrites.test.ts`
Expected: PASS, all 4 tests

Then run the full suite to confirm nothing else broke:

Run: `npm test`
Expected: all previously-passing tests still pass, plus the new ones

- [ ] **Step 5: Commit**

```bash
git add src/utils/postOrder.ts src/utils/__tests__/postOrder.myPositionWrites.test.ts
git commit -m "Write to my_positions on every confirmed BUY/SELL fill"
```

---

## Task 3: Read `myPosition` from `my_positions` in `tradeExecutor.ts`

**Files:**
- Modify: `src/services/tradeExecutor.ts`

**Interfaces:**
- Consumes: `getMyPositionModel()` from Task 1.
- Consumes: `UserPositionInterface` from `src/interfaces/User.ts` (already imported in this file per the prior plan's changes — confirm before re-importing).
- Produces: nothing new for later tasks — this is a leaf change in `prepareTradeData`.

Read the current `prepareTradeData` function (and its surrounding doc comment) in full before editing — it currently calls `fetchPositionForMarket(MY_EOA_ADDRESS, trade.conditionId)` for `myPosition` on both the BUY and SELL branches. Replace both call sites with a DB read; leave `userPosition` (already DB-backed), `myBalance` (via `getMyBalance`), and `userBalance` (`undefined`, unchanged) exactly as they are.

- [ ] **Step 1: Write the failing test**

Check whether `tradeExecutor.ts` has any existing unit tests for `prepareTradeData` specifically:

```bash
grep -rln "prepareTradeData" src/**/__tests__/*.ts 2>/dev/null
```

`prepareTradeData` is not currently exported (confirm with `grep -n "^const prepareTradeData\|^export.*prepareTradeData" src/services/tradeExecutor.ts`). If it needs to stay unexported, this task's verification is build + lint + the full existing suite (56 tests) rather than a new unit test — do not export a previously-internal function purely to satisfy a test if that changes the module's public surface beyond what this plan calls for. If you judge a test meaningfully de-risks this change, add one exercising `prepareTradeData` via a temporary local export and note that decision in your task report; otherwise proceed straight to Step 3 and rely on the build/lint/full-suite verification in Step 4.

- [ ] **Step 2: Run test to verify it fails**

Skip if Step 1 concluded no new test is being added — proceed to Step 3.

- [ ] **Step 3: Write minimal implementation**

Add the import (alongside the existing `getUserActivityModel` import, or wherever `src/models/userHistory.ts` imports currently sit):

```typescript
import { getMyPositionModel } from '../models/myPosition';
```

Add a small helper near `prepareTradeData` (mirror the existing `fetchTraderPositionFromDb` helper already in this file — read it first for the exact pattern to match):

```typescript
/**
 * Fetch our own position for one market from Mongo instead of the live API.
 * postOrder.ts writes to my_positions on every one of our own confirmed
 * fills (see recordBuyFill/recordSellFill), and tradeMonitor.ts's
 * reconciliation tick keeps it in sync with the live API on a fixed
 * interval to bound drift from anything that changes our position outside
 * postOrder.ts (the manual CLI scripts) — so there is no live API call
 * needed here at all.
 */
const fetchMyPositionFromDb = async (
    conditionId: string
): Promise<UserPositionInterface | undefined> => {
    const MyPosition = getMyPositionModel();
    const position = await MyPosition.findOne({ conditionId }).lean().exec();
    return (position as UserPositionInterface | null) ?? undefined;
};
```

In `prepareTradeData`, replace both occurrences of `fetchPositionForMarket(MY_EOA_ADDRESS, trade.conditionId)` with `fetchMyPositionFromDb(trade.conditionId)`. Update the function's doc comment to describe the new source (mirror the existing `fetchTraderPositionFromDb` comment's structure — state what changed and why, not what the code does line-by-line).

After this change, check whether `fetchPositionForMarket` (from `positionHelpers.ts`) and the `MY_EOA_ADDRESS` import are still used anywhere else in `tradeExecutor.ts`:

```bash
grep -n "fetchPositionForMarket\|MY_EOA_ADDRESS" src/services/tradeExecutor.ts
```

If either becomes unused in this file, remove the now-dead import — do not leave an unused import behind. Do NOT remove `fetchPositionForMarket` from `positionHelpers.ts` itself; it may still be a reasonable utility to keep even if this file no longer calls it (check no other file uses it before deciding either way, and if truly orphaned repo-wide, note that as an observation in your task report rather than deleting it unprompted — that's a separate cleanup decision).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:strict`
Expected: no errors

Run: `npx eslint src/services/tradeExecutor.ts`
Expected: no new errors (pre-existing warnings elsewhere in the codebase are not this task's concern)

Run: `npm test`
Expected: 56/56 (or however many exist after Task 1/2 additions) passing

- [ ] **Step 5: Commit**

```bash
git add src/services/tradeExecutor.ts
git commit -m "Read myPosition from my_positions DB cache instead of live API"
```

---

## Task 4: One-time seed script

**Files:**
- Create: `src/scripts/seedMyPositions.ts`
- Modify: `package.json` (add one npm script entry)

**Interfaces:**
- Consumes: `fetchMyPositionsAndBalance()` from `src/utils/positionHelpers.ts` (already paginated, per the prior plan).
- Consumes: `getMyPositionModel()` from Task 1.
- Produces: nothing consumed by later tasks — this is a standalone CLI entry point, run manually.

Read one existing simple CLI script first (e.g. `src/scripts/checkProxyWallet.ts` or `src/scripts/checkRecentActivity.ts` — pick whichever is shortest) to match this repo's script conventions: how it connects to Mongo, how it reads `ENV`, how it exits, and its top-of-file structure/shebang-equivalent.

- [ ] **Step 1: Write the failing test**

CLI scripts in this repo (per `CLAUDE.md`'s "Scripts Directory" section) are not unit-tested — they're run manually. Skip automated test steps for this task. Verification is a manual dry run against a real (or `DRY_RUN`-safe) environment in Step 4.

- [ ] **Step 2: Run test to verify it fails**

Skip (see Step 1).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/scripts/seedMyPositions.ts
import mongoose from 'mongoose';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { fetchMyPositionsAndBalance } from '../utils/positionHelpers';
import { getMyPositionModel } from '../models/myPosition';

/**
 * One-time backfill: my_positions starts empty, so any position the bot
 * already held before this feature shipped would otherwise be invisible
 * to postSellOrder's `if (!myPosition)` bailout — wrongly treated as "no
 * position to sell" for a market we're actually holding. Run this once,
 * manually, right before/after deploying the self-tracked position
 * feature. Safe to re-run: it fully overwrites my_positions from the live
 * API each time, same as the periodic reconciliation tick does.
 */
const seedMyPositions = async (): Promise<void> => {
    await mongoose.connect(ENV.MONGO_URI);
    Logger.info('Connected to MongoDB');

    const { positions } = await fetchMyPositionsAndBalance();
    Logger.info(`Fetched ${positions.length} live position(s) from the API`);

    const MyPosition = getMyPositionModel();

    for (const position of positions) {
        await MyPosition.findOneAndUpdate(
            { conditionId: position.conditionId },
            {
                $set: {
                    conditionId: position.conditionId,
                    asset: position.asset,
                    size: position.size,
                    avgPrice: position.avgPrice,
                    totalBought: position.totalBought,
                },
            },
            { upsert: true }
        );
    }

    Logger.success(`Seeded ${positions.length} position(s) into my_positions`);
    await mongoose.disconnect();
};

seedMyPositions()
    .then(() => process.exit(0))
    .catch((error) => {
        Logger.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
```

Adjust the Mongo connection lines to match whatever pattern the script you read in the pre-step actually uses (e.g. it may use a shared `connectDB()` helper instead of calling `mongoose.connect` directly — check `src/config/` or `src/utils/` for a `db.ts`/`database.ts` helper before assuming direct connection is correct):

```bash
grep -rln "mongoose.connect" src/ --include="*.ts" | grep -v __tests__
```

Add to `package.json`'s `scripts` block, alongside the other `check-*`/one-off scripts:

```json
"seed-my-positions": "ts-node src/scripts/seedMyPositions.ts"
```

- [ ] **Step 4: Verify manually**

Run: `npm run build:strict` (must compile)
Run: `npx eslint src/scripts/seedMyPositions.ts` (no new errors)

Do NOT run `npm run seed-my-positions` against production data as part of this task's automated verification — this writes to the real `my_positions` collection using real credentials. Report this script as implemented-but-unexecuted, and let the human operator run it manually once, at the point in the rollout where they're ready to seed the collection (see the Final Integration section below).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/seedMyPositions.ts package.json
git commit -m "Add one-time seed script for my_positions backfill"
```

---

## Task 5: Periodic reconciliation tick in `tradeMonitor.ts`

**Files:**
- Modify: `src/services/tradeMonitor.ts`

**Interfaces:**
- Consumes: `fetchMyPositionsAndBalance()` from `src/utils/positionHelpers.ts`.
- Consumes: `getMyPositionModel()` from Task 1.
- Produces: nothing consumed by later tasks.

Read the full current `tradeMonitor.ts` file before editing, specifically the `tradeMonitor()` function's `while (isRunning) { ... }` loop and the existing `updateTraderPositions` function (this task's new function should closely mirror `updateTraderPositions`'s upsert-per-item pattern, but for a single non-per-address collection, and it additionally needs to delete stale docs — positions the API no longer reports at all, e.g. fully closed via a CLI script — which `updateTraderPositions` does not currently do for trader collections; do not fix that pre-existing gap in `updateTraderPositions` as part of this task, it's out of this plan's scope).

- [ ] **Step 1: Write the failing test**

This function is best covered by a focused unit test against a real (in-memory) Mongo instance, matching Task 1/2's test setup approach:

```typescript
// src/services/__tests__/reconcileMyPositions.test.ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server'; // or match the established setup
import { getMyPositionModel } from '../../models/myPosition';

// Mock the live API call so the test controls exactly what "live" data looks like
jest.mock('../../utils/positionHelpers', () => ({
    fetchMyPositionsAndBalance: jest.fn(),
}));

import { fetchMyPositionsAndBalance } from '../../utils/positionHelpers';
import { reconcileMyPositions } from '../tradeMonitor';

describe('reconcileMyPositions', () => {
    let mongoServer: MongoMemoryServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoServer.stop();
    });

    afterEach(async () => {
        await mongoose.connection.collection('my_positions').deleteMany({});
        jest.clearAllMocks();
    });

    it('upserts positions from the live API', async () => {
        (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
            positions: [
                { conditionId: '0xa', asset: '1', size: 5, avgPrice: 0.3, totalBought: 5 },
            ],
            usdcBalance: 100,
            totalBalance: 100,
        });

        await reconcileMyPositions();

        const doc = await getMyPositionModel().findOne({ conditionId: '0xa' }).lean();
        expect(doc?.size).toBe(5);
    });

    it('removes a position the DB has but the live API no longer reports', async () => {
        await getMyPositionModel().create({
            conditionId: '0xstale',
            asset: '9',
            size: 3,
            avgPrice: 0.1,
            totalBought: 3,
        });
        (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
            positions: [],
            usdcBalance: 100,
            totalBalance: 100,
        });

        await reconcileMyPositions();

        const doc = await getMyPositionModel().findOne({ conditionId: '0xstale' }).lean();
        expect(doc).toBeNull();
    });
});
```

`reconcileMyPositions` must be exported from `tradeMonitor.ts` for this test to import it — check whether `tradeMonitor.ts` currently has a default-export-only pattern (`export default tradeMonitor;`) and add a named export alongside it if so; do not change the existing default export.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/reconcileMyPositions.test.ts`
Expected: FAIL with "reconcileMyPositions is not exported" (or module resolution error)

- [ ] **Step 3: Write minimal implementation**

Add near `updateTraderPositions` in `tradeMonitor.ts`:

```typescript
import { getMyPositionModel } from '../models/myPosition';

/**
 * Re-syncs my_positions against the live API on every tick of the main
 * monitor loop (same FETCH_INTERVAL cadence updateTraderPositions already
 * uses for trader collections). postOrder.ts keeps my_positions accurate
 * for the bot's own BUY/SELL fills already, so in the common case this is
 * a no-op confirmation; it exists to bound drift from the CLI scripts
 * (manualSell.ts, sellLargePositions.ts, closeStalePositions.ts,
 * closeResolvedPositions.ts, redeemResolvedPositions.ts) that can change
 * our on-chain position outside postOrder.ts's control, without requiring
 * each of those scripts to know about my_positions individually.
 *
 * Unlike updateTraderPositions (upsert-only), this also DELETES any
 * my_positions doc whose conditionId the live API no longer reports at
 * all — the only signal available that a position was fully closed by one
 * of those out-of-band scripts.
 */
export const reconcileMyPositions = async (): Promise<void> => {
    const { positions } = await fetchMyPositionsAndBalance();
    const MyPosition = getMyPositionModel();

    const liveConditionIds = positions.map((p) => p.conditionId).filter(Boolean);

    if (positions.length > 0) {
        for (const position of positions) {
            await MyPosition.findOneAndUpdate(
                { conditionId: position.conditionId },
                {
                    $set: {
                        conditionId: position.conditionId,
                        asset: position.asset,
                        size: position.size,
                        avgPrice: position.avgPrice,
                        totalBought: position.totalBought,
                    },
                },
                { upsert: true }
            );
        }
    }

    await MyPosition.deleteMany({ conditionId: { $nin: liveConditionIds } });
};
```

Wire it into the loop. In `tradeMonitor()`'s `while (isRunning) { ... }` block:

```typescript
while (isRunning) {
    await fetchTradeData();
    if (!isRunning) break;
    try {
        await reconcileMyPositions();
    } catch (error) {
        Logger.error(`Error reconciling my_positions: ${formatError(error)}`);
    }
    if (!isRunning) break;
    await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
}
```

Wrap the call in try/catch exactly as shown — a reconciliation failure (e.g. a transient API error) must never crash the monitor loop or block trade detection, matching how `fetchTradeDataForTrader`'s own try/catch already isolates per-trader failures from the rest of the loop.

Note: this makes the reconciliation tick run at `FETCH_INTERVAL` (default 1s) — matching the "Recommended" choice made during planning to fold it into the existing loop rather than run it on its own slower interval. If, after implementing, this looks too chatty against the live API (it is one additional HTTP call per tick, same cost class as one trader's `fetchUserPositionsAndBalance` call), flag this in your task report rather than unilaterally changing the interval — the human operator may want to revisit the cadence once they see it running.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/reconcileMyPositions.test.ts`
Expected: PASS, both tests

Run: `npm test`
Expected: full suite passing

Run: `npm run build:strict` and `npx eslint src/services/tradeMonitor.ts`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/services/tradeMonitor.ts src/services/__tests__/reconcileMyPositions.test.ts
git commit -m "Add periodic my_positions reconciliation tick to trade monitor"
```

---

## Final Integration

After Task 5's task-review passes:

1. Dispatch the `trading-safety-reviewer` subagent against the full branch diff (all 5 tasks' commits combined) before this touches `main` — this plan changes order-fill bookkeeping and position sizing inputs with real funds on the line. Provide it the diff via the same review-package pattern used for per-task reviews.
2. Run the full verification suite one more time on the combined diff: `npm run build:strict`, `npx eslint` on every changed file, `npm test`.
3. Report to the human operator, explicitly, that `npm run seed-my-positions` has NOT been run and must be run manually once, at a moment of their choosing, before (or immediately after) this ships to production — ideally right before restarting the bot, to minimize the window where `my_positions` is empty while the monitor's reconciliation tick is the only thing populating it.
4. Use `superpowers:finishing-a-development-branch` to decide how this reaches `main` (merge locally / push+PR / keep as-is) — do not assume; ask.
