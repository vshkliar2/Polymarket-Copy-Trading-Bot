# Dynamic Trader Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the tracked-trader list from a static `.env` value into a MongoDB collection that can be managed dynamically at runtime (no restart), and add two background discovery workers plus interactive Telegram commands for reviewing and approving new trader candidates.

**Architecture:** A new `tracked_traders` MongoDB collection is the single source of truth for which traders are actively copied. A shared `trackedTraders.ts` module exposes pure diff logic (unit-testable without a DB) plus thin Mongoose I/O wrappers; `tradeMonitor.ts`, `websocketTradeMonitor.ts`, and `tradeExecutor.ts` each poll it every 60s to add/remove in-memory trader models live. Two new standalone PM2 processes (`discoveryWorker.ts`, `newWalletWorker.ts`) write `pending` rows for human review; nothing is ever auto-activated. `telegramNotifier.ts` gains polling-mode inbound commands and inline approve/reject buttons, restricted to the configured `TELEGRAM_CHAT_ID`.

**Tech Stack:** TypeScript, Mongoose 8.x, `node-telegram-bot-api`, `@polymarket/real-time-data-client`, Jest + ts-jest (existing), PM2.

**Spec:** `docs/superpowers/specs/2026-08-31-dynamic-trader-management-design.md`

## Global Constraints

- Discovered candidates (from either worker) are NEVER written with `status: 'active'` directly — only a human approval (Telegram button or `/add`) may set `status: 'active'`.
- `USER_ADDRESSES` in `.env` becomes optional; it is read only once, to seed `tracked_traders` if that collection is empty on first boot. `env.ts`'s `validateRequiredEnv()` must no longer throw when `USER_ADDRESSES` is absent.
- All Telegram inbound message/callback handling must reject (silently, no reply) anything not from `chat.id === TELEGRAM_CHAT_ID`.
- Removing a trader from `tracked_traders` must never touch existing open positions or in-flight trades — it only stops future monitoring of that address.
- The diffing logic that decides which trader models to add/remove must be a pure function (plain data in, plain data out) so it is unit-testable without a live MongoDB connection, matching this repo's existing pattern of testing pure logic (`copyStrategy.ts`) separately from I/O (`postOrder.ts`).
- New env vars get defaults and validation in `src/config/env.ts`, following the existing pattern (see `TELEGRAM_ALERTS_ENABLED`, `HEALTH_CHECK_INTERVAL_HOURS`).

---

## Task 1: Export shared validation helper and discovery types

Small prerequisite task: two existing modules have private declarations that later tasks need to import. Exporting them now avoids duplicating an Ethereum-address regex and duplicating discovery-scoring types.

**Files:**
- Modify: `src/config/env.ts:8` (the `isValidEthereumAddress` function)
- Modify: `src/scripts/discoverTraders.ts:52` and `:76` (the `TraderScore` and `DiscoveryOptions` interfaces)
- Test: `src/config/__tests__/env.test.ts`

**Interfaces:**
- Produces: `isValidEthereumAddress(address: string): boolean` (exported from `src/config/env.ts`)
- Produces: `TraderScore` and `DiscoveryOptions` interfaces (exported from `src/scripts/discoverTraders.ts`)

- [ ] **Step 1: Write the failing test**

Add to `src/config/__tests__/env.test.ts` (append to the existing `describe('Environment variable parsing', ...)` block or add a new top-level `describe`):

```typescript
import { isValidEthereumAddress } from '../env';

describe('isValidEthereumAddress', () => {
    it('should accept a valid 40-hex-character address with 0x prefix', () => {
        expect(isValidEthereumAddress('0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b')).toBe(true);
    });

    it('should reject an address without 0x prefix', () => {
        expect(isValidEthereumAddress('7c3db723f1d4d8cb9c550095203b686cb11e5c6b')).toBe(false);
    });

    it('should reject an address with wrong length', () => {
        expect(isValidEthereumAddress('0x7c3db723f1d4d8cb9c550095203b686cb11e5c')).toBe(false);
    });

    it('should reject a non-hex address', () => {
        expect(isValidEthereumAddress('0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- env.test.ts`
Expected: FAIL with `Module '"../env"' has no exported member 'isValidEthereumAddress'` (a TypeScript compile error surfaced as a test failure, since `isValidEthereumAddress` is currently unexported).

- [ ] **Step 3: Export the function and interfaces**

In `src/config/env.ts`, change:
```typescript
const isValidEthereumAddress = (address: string): boolean => {
```
to:
```typescript
export const isValidEthereumAddress = (address: string): boolean => {
```

In `src/scripts/discoverTraders.ts`, change:
```typescript
interface TraderScore {
```
to:
```typescript
export interface TraderScore {
```
and change:
```typescript
interface DiscoveryOptions {
```
to:
```typescript
export interface DiscoveryOptions {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- env.test.ts`
Expected: PASS, all 4 new tests plus the existing 4 in that file green.

- [ ] **Step 5: Verify the full build and test suite still pass**

Run: `npm run build:strict && npm test`
Expected: both clean — exporting a previously-unexported symbol should not break any existing import.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/scripts/discoverTraders.ts src/config/__tests__/env.test.ts
git commit -m "Export isValidEthereumAddress and discovery types for reuse

Needed by the upcoming tracked-trader management module and discovery
worker, which validate addresses and consume TraderScore/DiscoveryOptions
without duplicating logic."
```

---

## Task 2: `TrackedTrader` Mongoose model

**Files:**
- Create: `src/models/trackedTrader.ts`
- Test: `src/models/__tests__/trackedTrader.test.ts`

**Interfaces:**
- Produces: `TrackedTraderStatus = 'active' | 'pending' | 'rejected'` (type)
- Produces: `TrackedTraderSource = 'manual' | 'discovered_leaderboard' | 'discovered_new_wallet'` (type)
- Produces: `TrackedTraderInterface` interface with fields `{ address: string; status: TrackedTraderStatus; source: TrackedTraderSource; addedAt: Date; addedBy?: string; discoveryMeta?: { score?: number; firstTradeSize?: number; reason: string } }`
- Produces: `TrackedTraderModel` (the Mongoose model, default export)

- [ ] **Step 1: Write the failing test**

Create `src/models/__tests__/trackedTrader.test.ts`:

```typescript
import mongoose from 'mongoose';
import TrackedTraderModel from '../trackedTrader';

describe('TrackedTraderModel schema', () => {
    it('should build a valid document with required fields only', () => {
        const doc = new TrackedTraderModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            status: 'active',
            source: 'manual',
            addedAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeUndefined();
    });

    it('should fail validation without a required field', () => {
        const doc = new TrackedTraderModel({
            status: 'active',
            source: 'manual',
            addedAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.address).toBeDefined();
    });

    it('should reject an invalid status enum value', () => {
        const doc = new TrackedTraderModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            status: 'not-a-real-status',
            source: 'manual',
            addedAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.status).toBeDefined();
    });

    it('should accept an optional discoveryMeta subdocument', () => {
        const doc = new TrackedTraderModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            status: 'pending',
            source: 'discovered_leaderboard',
            addedAt: new Date(),
            discoveryMeta: { score: 87, reason: 'High win rate, low drawdown' },
        });
        const err = doc.validateSync();
        expect(err).toBeUndefined();
        expect(doc.discoveryMeta?.score).toBe(87);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- trackedTrader.test.ts`
Expected: FAIL — `Cannot find module '../trackedTrader'`.

- [ ] **Step 3: Write the model**

Create `src/models/trackedTrader.ts`:

```typescript
import mongoose, { Schema, Document } from 'mongoose';

export type TrackedTraderStatus = 'active' | 'pending' | 'rejected';
export type TrackedTraderSource = 'manual' | 'discovered_leaderboard' | 'discovered_new_wallet';

export interface TrackedTraderInterface extends Document {
    address: string;
    status: TrackedTraderStatus;
    source: TrackedTraderSource;
    addedAt: Date;
    addedBy?: string;
    discoveryMeta?: {
        score?: number;
        firstTradeSize?: number;
        reason: string;
    };
}

const trackedTraderSchema = new Schema<TrackedTraderInterface>({
    address: { type: String, required: true, unique: true, lowercase: true },
    status: { type: String, required: true, enum: ['active', 'pending', 'rejected'] },
    source: {
        type: String,
        required: true,
        enum: ['manual', 'discovered_leaderboard', 'discovered_new_wallet'],
    },
    addedAt: { type: Date, required: true },
    addedBy: { type: String, required: false },
    discoveryMeta: {
        type: new Schema(
            {
                score: { type: Number, required: false },
                firstTradeSize: { type: Number, required: false },
                reason: { type: String, required: true },
            },
            { _id: false }
        ),
        required: false,
    },
});

const TrackedTraderModel = mongoose.model<TrackedTraderInterface>(
    'tracked_traders',
    trackedTraderSchema,
    'tracked_traders'
);

export default TrackedTraderModel;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- trackedTrader.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Run the full test suite and strict build**

Run: `npm run build:strict && npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/models/trackedTrader.ts src/models/__tests__/trackedTrader.test.ts
git commit -m "Add TrackedTrader model for dynamic trader management

New tracked_traders collection: status (active/pending/rejected), source
(manual/discovered_leaderboard/discovered_new_wallet), and optional
discoveryMeta for score/reason shown in Telegram alerts."
```

---

## Task 3: `trackedTraders.ts` — pure diff logic + DB wrappers

This is the core shared module. Its diffing logic must be pure (no I/O) so it can be unit-tested without MongoDB; the DB-touching functions are thin wrappers with no test coverage requirement (matches this repo's existing test-the-pure-logic pattern from `copyStrategy.ts`).

**Files:**
- Create: `src/services/trackedTraders.ts`
- Test: `src/services/__tests__/trackedTraders.test.ts`

**Interfaces:**
- Consumes: `TrackedTraderModel` from `src/models/trackedTrader.ts` (Task 2)
- Consumes: `getUserActivityModel(walletAddress: string)`, `getUserPositionModel(walletAddress: string)` from `src/models/userHistory.ts` (existing)
- Produces: `diffTraderAddresses(currentAddresses: string[], activeAddresses: string[]): { toAdd: string[]; toRemove: string[] }` (pure function)
- Produces: `getActiveTraderAddresses(): Promise<string[]>` (DB wrapper — queries `tracked_traders` for `status: 'active'`, returns lowercase addresses)
- Produces: `seedFromEnvIfEmpty(envAddresses: string[]): Promise<void>` (DB wrapper — the one-time migration)
- Produces: interface `TraderModelConfig { address: string; UserActivity: ReturnType<typeof getUserActivityModel>; UserPosition: ReturnType<typeof getUserPositionModel> }`
- Produces: `buildTraderModelMap(addresses: string[]): Map<string, TraderModelConfig>` (pure w.r.t. no DB query, but calls the model-factory functions which internally call `mongoose.model()` — no test coverage needed for this one, covered by the calling services' existing behavior)

- [ ] **Step 1: Write the failing test for the pure diff function**

Create `src/services/__tests__/trackedTraders.test.ts`:

```typescript
import { diffTraderAddresses } from '../trackedTraders';

describe('diffTraderAddresses', () => {
    it('should return empty toAdd/toRemove when lists are identical', () => {
        const result = diffTraderAddresses(['0xaaa', '0xbbb'], ['0xaaa', '0xbbb']);
        expect(result.toAdd).toEqual([]);
        expect(result.toRemove).toEqual([]);
    });

    it('should detect a newly active address', () => {
        const result = diffTraderAddresses(['0xaaa'], ['0xaaa', '0xbbb']);
        expect(result.toAdd).toEqual(['0xbbb']);
        expect(result.toRemove).toEqual([]);
    });

    it('should detect a removed address', () => {
        const result = diffTraderAddresses(['0xaaa', '0xbbb'], ['0xaaa']);
        expect(result.toAdd).toEqual([]);
        expect(result.toRemove).toEqual(['0xbbb']);
    });

    it('should detect both additions and removals in the same diff', () => {
        const result = diffTraderAddresses(['0xaaa', '0xbbb'], ['0xaaa', '0xccc']);
        expect(result.toAdd).toEqual(['0xccc']);
        expect(result.toRemove).toEqual(['0xbbb']);
    });

    it('should handle an empty current list (initial boot)', () => {
        const result = diffTraderAddresses([], ['0xaaa', '0xbbb']);
        expect(result.toAdd.sort()).toEqual(['0xaaa', '0xbbb']);
        expect(result.toRemove).toEqual([]);
    });

    it('should handle an empty active list (all traders removed)', () => {
        const result = diffTraderAddresses(['0xaaa', '0xbbb'], []);
        expect(result.toAdd).toEqual([]);
        expect(result.toRemove.sort()).toEqual(['0xaaa', '0xbbb']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- trackedTraders.test.ts`
Expected: FAIL — `Cannot find module '../trackedTraders'`.

- [ ] **Step 3: Write the module**

Create `src/services/trackedTraders.ts`:

```typescript
import TrackedTraderModel from '../models/trackedTrader';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import { isValidEthereumAddress } from '../config/env';
import Logger from '../utils/logger';

export interface TraderModelConfig {
    address: string;
    UserActivity: ReturnType<typeof getUserActivityModel>;
    UserPosition: ReturnType<typeof getUserPositionModel>;
}

/**
 * Pure diff between the addresses a service currently has models for and
 * the latest active list from the DB. No I/O — safe to unit test directly.
 */
export const diffTraderAddresses = (
    currentAddresses: string[],
    activeAddresses: string[]
): { toAdd: string[]; toRemove: string[] } => {
    const currentSet = new Set(currentAddresses);
    const activeSet = new Set(activeAddresses);

    const toAdd = activeAddresses.filter((addr) => !currentSet.has(addr));
    const toRemove = currentAddresses.filter((addr) => !activeSet.has(addr));

    return { toAdd, toRemove };
};

/**
 * Query tracked_traders for all active addresses (lowercase).
 */
export const getActiveTraderAddresses = async (): Promise<string[]> => {
    const rows = await TrackedTraderModel.find({ status: 'active' }).exec();
    return rows.map((row) => row.address);
};

/**
 * One-time migration: if tracked_traders is empty and envAddresses is
 * non-empty, seed the collection from it (source: 'manual', status: 'active').
 * No-op if tracked_traders already has any documents.
 */
export const seedFromEnvIfEmpty = async (envAddresses: string[]): Promise<void> => {
    const existingCount = await TrackedTraderModel.countDocuments();
    if (existingCount > 0) {
        return;
    }
    if (!envAddresses || envAddresses.length === 0) {
        return;
    }

    const now = new Date();
    await TrackedTraderModel.insertMany(
        envAddresses.map((address) => ({
            address: address.toLowerCase(),
            status: 'active' as const,
            source: 'manual' as const,
            addedAt: now,
        }))
    );
    Logger.success(
        `Seeded tracked_traders with ${envAddresses.length} address(es) from USER_ADDRESSES`
    );
};

/**
 * Build a fresh model-config map for the given addresses. Called with the
 * result of diffTraderAddresses().toAdd to create models only for newly
 * active addresses.
 */
export const buildTraderModelMap = (addresses: string[]): Map<string, TraderModelConfig> => {
    const map = new Map<string, TraderModelConfig>();
    for (const address of addresses) {
        map.set(address, {
            address,
            UserActivity: getUserActivityModel(address),
            UserPosition: getUserPositionModel(address),
        });
    }
    return map;
};

/**
 * Manually add a trader (e.g. via a Telegram /add command). Validates the
 * address format; throws if invalid or if the address is already tracked
 * with any status.
 */
export const addManualTrader = async (address: string, addedBy?: string): Promise<void> => {
    const normalized = address.toLowerCase();
    if (!isValidEthereumAddress(normalized)) {
        throw new Error(`Invalid Ethereum address: ${address}`);
    }

    const existing = await TrackedTraderModel.findOne({ address: normalized }).exec();
    if (existing) {
        if (existing.status === 'active') {
            throw new Error(`${address} is already actively tracked`);
        }
        existing.status = 'active';
        existing.addedBy = addedBy;
        existing.addedAt = new Date();
        await existing.save();
        return;
    }

    await TrackedTraderModel.create({
        address: normalized,
        status: 'active',
        source: 'manual',
        addedAt: new Date(),
        addedBy,
    });
};

/**
 * Remove (reject) a trader by address. No-op if not found.
 */
export const removeTrader = async (address: string): Promise<boolean> => {
    const normalized = address.toLowerCase();
    const result = await TrackedTraderModel.updateOne(
        { address: normalized },
        { $set: { status: 'rejected' } }
    );
    return result.modifiedCount > 0;
};

/**
 * List all traders with a given status (default: active).
 */
export const listTraders = async (status: 'active' | 'pending' | 'rejected' = 'active') => {
    return TrackedTraderModel.find({ status }).sort({ addedAt: -1 }).exec();
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- trackedTraders.test.ts`
Expected: PASS, all 6 diff tests green.

- [ ] **Step 5: Run the full test suite and strict build**

Run: `npm run build:strict && npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/trackedTraders.ts src/services/__tests__/trackedTraders.test.ts
git commit -m "Add trackedTraders module with pure diff logic and DB helpers

diffTraderAddresses is pure and unit-tested without a live MongoDB
connection. getActiveTraderAddresses, seedFromEnvIfEmpty, addManualTrader,
removeTrader, and listTraders are thin Mongoose wrappers used by the
monitors and the upcoming Telegram commands."
```

---

## Task 4: Wire live-reload into `tradeMonitor.ts`, `websocketTradeMonitor.ts`, `tradeExecutor.ts`

Replaces each service's fixed, module-load-time `userModels`/`userActivityModels` array with a mutable map refreshed on an interval.

**Files:**
- Modify: `src/services/tradeMonitor.ts`
- Modify: `src/services/websocketTradeMonitor.ts`
- Modify: `src/services/tradeExecutor.ts`
- Modify: `src/config/env.ts` (add `TRACKED_TRADERS_REFRESH_SECONDS`, remove `USER_ADDRESSES` from `validateRequiredEnv`'s required list)
- Modify: `.env.example` (document the new var, mark `USER_ADDRESSES` optional)

**Interfaces:**
- Consumes: `diffTraderAddresses`, `getActiveTraderAddresses`, `seedFromEnvIfEmpty`, `buildTraderModelMap`, `TraderModelConfig` from `src/services/trackedTraders.ts` (Task 3)

- [ ] **Step 1: Add the new env var and relax the required-vars check**

In `src/config/env.ts`, find `validateRequiredEnv`'s `required` array:
```typescript
const required = [
    'USER_ADDRESSES',
    'PROXY_WALLET',
    ...
```
Remove `'USER_ADDRESSES'` from that array — it is no longer a hard requirement.

In the `ENV` export object, after the `USE_WEBSOCKET` line, add:
```typescript
    // How often (seconds) the running monitors/executor re-check
    // tracked_traders for additions/removals. Default: 60s.
    TRACKED_TRADERS_REFRESH_SECONDS: parseInt(
        process.env.TRACKED_TRADERS_REFRESH_SECONDS || '60',
        10
    ),
```

Also change the `USER_ADDRESSES` line itself so a missing env var doesn't throw inside `parseUserAddresses` — find:
```typescript
USER_ADDRESSES: parseUserAddresses(process.env.USER_ADDRESSES as string),
```
and change to:
```typescript
USER_ADDRESSES: process.env.USER_ADDRESSES ? parseUserAddresses(process.env.USER_ADDRESSES) : [],
```

- [ ] **Step 2: Run the existing env test suite to confirm nothing broke**

Run: `npm test -- env.test.ts`
Expected: PASS — the existing tests construct `USER_ADDRESSES` explicitly in each test case, so relaxing the requirement should not affect them. If a test relies on `USER_ADDRESSES` throwing when absent, that test needs updating to reflect the new optional behavior — check `src/config/__tests__/env.test.ts` for any such case and adjust its expectation to "returns `[]`" instead of "throws" if found.

- [ ] **Step 3: Rewrite `tradeMonitor.ts`'s model management to be dynamic**

In `src/services/tradeMonitor.ts`, replace the top-level fixed array:
```typescript
const userModels: UserModelConfig[] = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));
```
with a mutable map and a refresh function. Add near the top (after existing imports), import the new module:
```typescript
import {
    diffTraderAddresses,
    getActiveTraderAddresses,
    seedFromEnvIfEmpty,
    buildTraderModelMap,
    TraderModelConfig,
} from './trackedTraders';
```
Replace the fixed `userModels` declaration and the `UserModelConfig` interface (which is now identical to `TraderModelConfig` from `trackedTraders.ts` — remove the local interface and use the imported one) with:
```typescript
let userModels: TraderModelConfig[] = [];

const refreshUserModels = async (): Promise<void> => {
    const activeAddresses = await getActiveTraderAddresses();
    const currentAddresses = userModels.map((m) => m.address);
    const { toAdd, toRemove } = diffTraderAddresses(currentAddresses, activeAddresses);

    if (toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const newModelsMap = buildTraderModelMap(toAdd);
    const keptModels = userModels.filter((m) => !toRemove.includes(m.address));
    userModels = [...keptModels, ...Array.from(newModelsMap.values())];

    if (toAdd.length > 0) {
        Logger.info(`➕ Now tracking ${toAdd.length} new trader(s): ${toAdd.map(formatAddress).join(', ')}`);
    }
    if (toRemove.length > 0) {
        Logger.info(`➖ Stopped tracking ${toRemove.length} trader(s): ${toRemove.map(formatAddress).join(', ')}`);
    }
};
```
(`formatAddress` already exists lower in this file — no change needed there, just confirm it's defined before this point or move `refreshUserModels` after `formatAddress`'s declaration since JS function declarations hoist but `const` arrow functions do not.)

Remove the top-level guard:
```typescript
if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}
```
— an empty tracked-trader list at startup is now valid (traders can be added later via Telegram).

`init()` (the function that logs DB connection info and current positions) loops over `userModels` to build its `counts`/`positionCounts`/`positionDetails`/`profitabilities` arrays, and passes `USER_ADDRESSES` directly to `Logger.dbConnection(USER_ADDRESSES, counts)` and `Logger.tradersPositions(USER_ADDRESSES, ...)`. Since `userModels` starts empty (`let userModels: TraderModelConfig[] = []`) until the first refresh runs, `init()` must not run before that first refresh, or its logged counts will be for zero traders even when `tracked_traders` has active rows. In the main `tradeMonitor` function, reorder so the refresh happens FIRST:
```typescript
export const tradeMonitor = async (): Promise<void> => {
    await seedFromEnvIfEmpty(USER_ADDRESSES);
    await refreshUserModels();

    await init();
    Logger.success(`Monitoring ${userModels.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();
    // ... rest of the function (first-run historical-trade marking, then the while loop) unchanged
```
This removes the need to pass `USER_ADDRESSES` into `init()`'s `Logger.dbConnection`/`Logger.tradersPositions` calls at all — replace both call sites inside `init()`:
```typescript
Logger.dbConnection(USER_ADDRESSES, counts);
```
with:
```typescript
Logger.dbConnection(userModels.map((m) => m.address), counts);
```
and:
```typescript
Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);
```
with:
```typescript
Logger.tradersPositions(userModels.map((m) => m.address), positionCounts, positionDetails, profitabilities);
```
(`Logger.dbConnection`/`Logger.tradersPositions` accept a `string[]` of addresses — passing `userModels.map((m) => m.address)` instead of `USER_ADDRESSES` requires no change to `Logger`'s own signature, only to what's passed in.)

Also delete the original standalone log line:
```typescript
Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
```
since it's now folded into the reordered block above.

And inside the `while (isRunning)` loop, alongside the existing `await fetchTradeData();`, add a periodic refresh gated by elapsed time (reuse the pattern already in this file for `lastCheck`-style timers, but simplest is a dedicated `setInterval`):

Right after `let isFirstRun = true;` and `let isRunning = true;` declarations, add:
```typescript
let refreshInterval: NodeJS.Timeout | null = null;
```
In `tradeMonitor()`, after the `refreshUserModels()` call added above, add:
```typescript
    refreshInterval = setInterval(() => {
        refreshUserModels().catch((error) => {
            Logger.error(`Error refreshing tracked traders: ${formatError(error)}`);
        });
    }, ENV.TRACKED_TRADERS_REFRESH_SECONDS * 1000);
```
In `stopTradeMonitor`, add cleanup:
```typescript
export const stopTradeMonitor = (): void => {
    isRunning = false;
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    Logger.info('Trade monitor shutdown requested...');
};
```

Finally, since `fetchTradeData`, `init`, etc. all iterate `userModels` at call time (not capture-time), and `userModels` is now reassigned (not mutated in place) by `refreshUserModels`, no further change is needed in those functions — they already read the module-level `userModels` binding fresh on each call.

- [ ] **Step 4: Apply the identical change to `websocketTradeMonitor.ts`**

Repeat exactly the same edit shape from Step 3 in `src/services/websocketTradeMonitor.ts`: import from `./trackedTraders`, replace the fixed `userModels` array and its `UserModelConfig` interface with the mutable version + `refreshUserModels`, remove the empty-`USER_ADDRESSES` guard, and — same reasoning as `tradeMonitor.ts` — reorder so `seedFromEnvIfEmpty` + `refreshUserModels` run BEFORE `await init();` (not after), since `init()` here reads `userModels`/`USER_ADDRESSES` for its `Logger.dbConnection`/`Logger.tradersPositions` calls too. Apply the identical `init()`-body fix: replace `Logger.dbConnection(USER_ADDRESSES, counts)` with `Logger.dbConnection(userModels.map((m) => m.address), counts)`, and `Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities)` with `Logger.tradersPositions(userModels.map((m) => m.address), positionCounts, positionDetails, profitabilities)`. Move the log line `Logger.success(\`🚀 WebSocket monitoring ${USER_ADDRESSES.length} trader(s) in real-time\`);` to after the refresh call (right after `await init();`), changing it to read `userModels.length` instead of the stale `USER_ADDRESSES.length`. Add the `setInterval`-based periodic refresh, and add cleanup in `stopWebSocketTradeMonitor`. Also update the `trackedAddresses` `Map` (used for firehose filtering) to be rebuilt inside `refreshUserModels` alongside `userModels`:

```typescript
let trackedAddresses = new Map<string, TraderModelConfig>();

const refreshUserModels = async (): Promise<void> => {
    const activeAddresses = await getActiveTraderAddresses();
    const currentAddresses = Array.from(trackedAddresses.keys());
    const { toAdd, toRemove } = diffTraderAddresses(currentAddresses, activeAddresses);

    if (toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const newModelsMap = buildTraderModelMap(toAdd);
    for (const addr of toRemove) {
        trackedAddresses.delete(addr);
    }
    for (const [addr, config] of newModelsMap) {
        trackedAddresses.set(addr, config);
    }
    userModels = Array.from(trackedAddresses.values());

    if (toAdd.length > 0) {
        Logger.info(`➕ Now tracking ${toAdd.length} new trader(s): ${toAdd.map(formatAddress).join(', ')}`);
    }
    if (toRemove.length > 0) {
        Logger.info(`➖ Stopped tracking ${toRemove.length} trader(s): ${toRemove.map(formatAddress).join(', ')}`);
    }
};
```
(This file already builds `trackedAddresses` from `userModels` at module load for firehose filtering by `proxyWallet` — that construction moves into `refreshUserModels` as shown, and `handleTradeMessage`'s existing `trackedAddresses.get(proxyWallet)` lookup needs no change since it reads the same module-level `trackedAddresses` binding.)

- [ ] **Step 5: Apply the equivalent change to `tradeExecutor.ts`**

In `src/services/tradeExecutor.ts`, replace the fixed:
```typescript
const userActivityModels: UserActivityModelConfig[] = USER_ADDRESSES.map((address) => ({
    address,
    model: getUserActivityModel(address),
}));
```
with a mutable version. This file only needs `UserActivity` models (not positions), so define locally:
```typescript
interface UserActivityModelConfig {
    address: string;
    model: ReturnType<typeof getUserActivityModel>;
}

let userActivityModels: UserActivityModelConfig[] = [];

const refreshUserActivityModels = async (): Promise<void> => {
    const activeAddresses = await getActiveTraderAddresses();
    const currentAddresses = userActivityModels.map((m) => m.address);
    const { toAdd, toRemove } = diffTraderAddresses(currentAddresses, activeAddresses);

    if (toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const kept = userActivityModels.filter((m) => !toRemove.includes(m.address));
    const added = toAdd.map((address) => ({ address, model: getUserActivityModel(address) }));
    userActivityModels = [...kept, ...added];
};
```
Add the import: `import { diffTraderAddresses, getActiveTraderAddresses } from './trackedTraders';`

Also find the existing log line:
```typescript
Logger.success(`Trade executor ready for ${USER_ADDRESSES.length} trader(s)`);
```
and the two `Logger.waiting(USER_ADDRESSES.length)` call sites further down in the polling loop (inside both the aggregation and non-aggregation branches), plus the `USER_ADDRESSES.length` argument passed to `Logger.waiting(...)` inside the aggregation branch's "buffered count" call. Change all four occurrences of `USER_ADDRESSES.length` in this file to `userActivityModels.length` — the executor's trader count must reflect the live, refreshed list, not the static env var (which may be `0` on a fresh DB-seeded install while the executor is actually serving traders added later via Telegram).

Add a module-level variable (near the existing `let isRunning = true;` declaration) for the refresh interval handle, since it needs to be reachable from `stopTradeExecutor` outside the `tradeExecutor` function:
```typescript
let executorRefreshInterval: NodeJS.Timeout | null = null;
```

In the main `tradeExecutor` function, before entering the `while (isRunning)` loop (and after moving the `Logger.success('Trade executor ready...')` line to read the live count as described above — place that log line after this refresh call so it reports the correct startup count), add:
```typescript
    await refreshUserActivityModels();
    executorRefreshInterval = setInterval(() => {
        refreshUserActivityModels().catch((error) => {
            Logger.error(`Error refreshing tracked traders: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, ENV.TRACKED_TRADERS_REFRESH_SECONDS * 1000);
```
Add cleanup in `stopTradeExecutor`:
```typescript
export const stopTradeExecutor = (): void => {
    isRunning = false;
    if (executorRefreshInterval) {
        clearInterval(executorRefreshInterval);
        executorRefreshInterval = null;
    }
    Logger.info('Trade executor shutdown requested...');
};
```

- [ ] **Step 6: Verify strict build**

Run: `npm run build:strict`
Expected: clean. This is the step most likely to surface a type mismatch (e.g., `TraderModelConfig` vs. a locally-redefined interface with a different shape) — fix any error by aligning the local usage with `TraderModelConfig`'s exact fields from Task 3.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all existing tests still pass (35 previously, plus the new ones from Tasks 1-3).

- [ ] **Step 8: Manual verification with DRY_RUN**

This step cannot be automated — do it manually:
1. Ensure `.env` has `DRY_RUN=true` and a working `MONGO_URI`.
2. Run `npm run dev`.
3. In a separate terminal, connect to MongoDB (e.g., `mongosh` or Compass) and insert a document into `tracked_traders`: `{ address: '0x...", status: 'active', source: 'manual', addedAt: new Date() }` for a real, active Polymarket trader address.
4. Within `TRACKED_TRADERS_REFRESH_SECONDS` (60s default), confirm the running bot's logs show `➕ Now tracking 1 new trader(s): ...` without a restart.
5. Update that document's `status` to `'rejected'`. Confirm the logs show `➖ Stopped tracking 1 trader(s): ...` within the refresh window.

- [ ] **Step 9: Commit**

```bash
git add src/config/env.ts src/services/tradeMonitor.ts src/services/websocketTradeMonitor.ts src/services/tradeExecutor.ts .env.example
git commit -m "Wire live tracked-trader reload into monitor and executor services

tradeMonitor.ts, websocketTradeMonitor.ts, and tradeExecutor.ts now poll
tracked_traders every TRACKED_TRADERS_REFRESH_SECONDS (default 60s) and
add/remove in-memory trader models without a restart. USER_ADDRESSES is
now optional, used only to seed tracked_traders on first boot when it's
empty."
```

---

## Task 5: Interactive Telegram commands (`/list`, `/add`, `/remove`, `/pending`)

**Files:**
- Modify: `src/services/telegramNotifier.ts`

**Interfaces:**
- Consumes: `addManualTrader(address: string, addedBy?: string): Promise<void>`, `removeTrader(address: string): Promise<boolean>`, `listTraders(status?: 'active' | 'pending' | 'rejected'): Promise<TrackedTraderInterface[]>` from `src/services/trackedTraders.ts` (Task 3)
- Consumes: `isValidEthereumAddress` from `src/config/env.ts` (Task 1) — used only for a friendlier inline error message; `addManualTrader` already validates internally, so this is a UX nicety, not a correctness requirement.

- [ ] **Step 1: Change the bot to polling mode and add the chat-id guard**

In `src/services/telegramNotifier.ts`, in the `initialize()` method, change:
```typescript
this.bot = new TelegramBot(token, { polling: false });
```
to:
```typescript
this.bot = new TelegramBot(token, { polling: true });
```
Immediately after that line (still inside the `try` block, after `this.enabled = true;`), add:
```typescript
this.registerCommandHandlers();
```

- [ ] **Step 2: Add the command handler registration method**

Add this new private method to the `TelegramNotifier` class (place it after `sendMessage`, before `notifyStartup`):

```typescript
private isAuthorized(chatId: number | string): boolean {
    return String(chatId) === this.chatId;
}

private registerCommandHandlers(): void {
    if (!this.bot) {
        return;
    }

    this.bot.onText(/\/list/, async (msg) => {
        if (!this.isAuthorized(msg.chat.id)) {
            return;
        }
        try {
            const { listTraders } = await import('./trackedTraders');
            const traders = await listTraders('active');
            if (traders.length === 0) {
                await this.sendMessage('No active tracked traders.');
                return;
            }
            const lines = traders.map(
                (t) => `• <code>${t.address}</code> (${t.source}, added ${t.addedAt.toISOString().slice(0, 10)})`
            );
            await this.sendMessage(`<b>Active Traders (${traders.length})</b>\n\n${lines.join('\n')}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ Error listing traders: ${errorMsg}`);
        }
    });

    this.bot.onText(/\/pending/, async (msg) => {
        if (!this.isAuthorized(msg.chat.id)) {
            return;
        }
        try {
            const { listTraders } = await import('./trackedTraders');
            const traders = await listTraders('pending');
            if (traders.length === 0) {
                await this.sendMessage('No pending trader candidates.');
                return;
            }
            const lines = traders.map(
                (t) =>
                    `• <code>${t.address}</code> (${t.source})${t.discoveryMeta ? `\n  ${t.discoveryMeta.reason}` : ''}`
            );
            await this.sendMessage(`<b>Pending Candidates (${traders.length})</b>\n\n${lines.join('\n')}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ Error listing pending traders: ${errorMsg}`);
        }
    });

    this.bot.onText(/\/add (.+)/, async (msg, match) => {
        if (!this.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await this.sendMessage('Usage: /add 0xADDRESS');
            return;
        }
        try {
            const { addManualTrader } = await import('./trackedTraders');
            await addManualTrader(address, String(msg.from?.id ?? 'telegram'));
            await this.sendMessage(`✅ Added <code>${address}</code> to active traders.`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ ${errorMsg}`);
        }
    });

    this.bot.onText(/\/remove (.+)/, async (msg, match) => {
        if (!this.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await this.sendMessage('Usage: /remove 0xADDRESS');
            return;
        }
        try {
            const { removeTrader } = await import('./trackedTraders');
            const removed = await removeTrader(address);
            await this.sendMessage(
                removed
                    ? `✅ Removed <code>${address}</code> from active traders.`
                    : `⚠️ <code>${address}</code> was not found or already inactive.`
            );
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ ${errorMsg}`);
        }
    });
}
```

Note: the dynamic `await import('./trackedTraders')` inside each handler (rather than a static top-of-file import) is deliberate — `telegramNotifier.ts` is imported very early (from `index.ts` before `connectDB()` runs in some paths), and `trackedTraders.ts` imports Mongoose models; a static import risks the models module evaluating before a DB connection exists in edge cases. If this proves unnecessary in practice (verify in Step 4), it can be simplified to a static top-level import — but the dynamic import is the safe default here since it defers module evaluation to first actual use.

- [ ] **Step 3: Verify strict build**

Run: `npm run build:strict`
Expected: clean.

- [ ] **Step 4: Manual verification**

Cannot be automated. With `TELEGRAM_ALERTS_ENABLED=true`, valid `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, and `DRY_RUN=true`, run `npm run dev` and from the configured Telegram chat:
1. Send `/list` — confirm it responds with the current active traders (or "No active tracked traders" on a fresh DB).
2. Send `/add 0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b` — confirm a success reply and that the address now appears in `/list`.
3. Send `/remove 0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b` — confirm success and that `/list` no longer shows it.
4. From a different Telegram account/chat (or by temporarily testing with a wrong chat ID), confirm commands are silently ignored — no reply at all.
5. Send `/add not-an-address` — confirm a friendly validation error reply, not a crash.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegramNotifier.ts
git commit -m "Add interactive Telegram commands for trader management

/list, /pending, /add <address>, /remove <address> — all restricted to
the configured TELEGRAM_CHAT_ID, silently ignoring anything else. Bot
now runs in polling mode instead of send-only."
```

---

## Task 6: Inline approve/reject buttons for discovery alerts

**Files:**
- Modify: `src/services/telegramNotifier.ts`

**Interfaces:**
- Consumes: `addManualTrader`, `removeTrader` from `src/services/trackedTraders.ts` (Task 3) — reused for the approve/reject actions
- Produces: `notifyDiscoveredTrader(candidate: { address: string; source: 'discovered_leaderboard' | 'discovered_new_wallet'; reason: string }): Promise<void>` — new public method other services (Task 7, Task 8) call to send an alert with inline buttons

- [ ] **Step 1: Add the callback_query handler**

In `registerCommandHandlers()` (added in Task 5), append:

```typescript
this.bot!.on('callback_query', async (query) => {
    if (!query.message || !this.isAuthorized(query.message.chat.id)) {
        return;
    }
    const data = query.data ?? '';
    const [action, address] = data.split(':');
    if (!address || (action !== 'approve' && action !== 'reject')) {
        return;
    }

    try {
        const { addManualTrader, removeTrader } = await import('./trackedTraders');
        if (action === 'approve') {
            await addManualTrader(address, String(query.from.id));
            await this.bot!.answerCallbackQuery(query.id, { text: `Approved ${address}` });
            await this.bot!.sendMessage(this.chatId!, `✅ Approved <code>${address}</code>`, {
                parse_mode: 'HTML',
            });
        } else {
            await removeTrader(address);
            await this.bot!.answerCallbackQuery(query.id, { text: `Rejected ${address}` });
            await this.bot!.sendMessage(this.chatId!, `❌ Rejected <code>${address}</code>`, {
                parse_mode: 'HTML',
            });
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await this.bot!.answerCallbackQuery(query.id, { text: `Error: ${errorMsg}` });
    }
});
```

(`removeTrader` on a `pending` row sets it to `rejected`, matching the "reject" semantics — no new function needed since Task 3's `removeTrader` already just sets `status: 'rejected'` regardless of the row's prior status.)

- [ ] **Step 2: Add the `notifyDiscoveredTrader` public method**

Add this method to the `TelegramNotifier` class, alongside the other `notify*` methods (e.g., after `notifyTrade`):

```typescript
async notifyDiscoveredTrader(candidate: {
    address: string;
    source: 'discovered_leaderboard' | 'discovered_new_wallet';
    reason: string;
}): Promise<void> {
    if (!this.enabled || !this.bot || !this.chatId) {
        return;
    }

    const sourceLabel =
        candidate.source === 'discovered_leaderboard' ? '📊 Leaderboard' : '🆕 New Wallet';
    const message = `
${sourceLabel} <b>Trader Candidate Found</b>

<b>Address:</b> <code>${candidate.address}</code>
<b>Reason:</b> ${candidate.reason}
    `.trim();

    try {
        await this.bot.sendMessage(this.chatId, message, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Approve', callback_data: `approve:${candidate.address}` },
                        { text: '❌ Reject', callback_data: `reject:${candidate.address}` },
                    ],
                ],
            },
        });
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.error(`Failed to send discovery alert: ${errorMsg}`);
    }
}
```

- [ ] **Step 3: Verify strict build**

Run: `npm run build:strict`
Expected: clean.

- [ ] **Step 4: Manual verification**

Cannot be automated yet without Task 7/8's workers, but can be tested standalone: write a short throwaway script (do not commit it) that imports the singleton `TelegramNotifier` default export and calls:
```typescript
import TelegramNotifier from './src/services/telegramNotifier';
TelegramNotifier.notifyDiscoveredTrader({
    address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
    source: 'discovered_leaderboard',
    reason: 'Test alert — score 92/100',
}).then(() => process.exit(0));
```
Run it with `npx ts-node <script>.ts`, confirm the Telegram message arrives with working Approve/Reject buttons, and that tapping one updates `tracked_traders` correctly (check via `/list` or `/pending` afterward) and edits the message state (via `answerCallbackQuery`'s toast). Delete the throwaway script when done.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegramNotifier.ts
git commit -m "Add inline approve/reject buttons for discovery alerts

notifyDiscoveredTrader() sends a Telegram message with Approve/Reject
inline buttons; the callback_query handler updates tracked_traders
accordingly. Used by the upcoming discovery workers."
```

---

## Task 7: `discoveryWorker.ts` — leaderboard-based discovery process

**Files:**
- Create: `src/discoveryWorker.ts`
- Modify: `ecosystem.config.js` (add the new PM2 app)
- Modify: `package.json` (add an npm script for local/manual running)
- Modify: `src/config/env.ts` (add `DISCOVERY_INTERVAL_HOURS`, `DISCOVERY_MIN_SCORE`)

**Interfaces:**
- Consumes: `discoverTraders(options: DiscoveryOptions): Promise<TraderScore[]>` from `src/scripts/discoverTraders.ts` (exported in Task 1)
- Consumes: `TrackedTraderModel` from `src/models/trackedTrader.ts` (Task 2) — to check for existing rows before inserting
- Consumes: `TelegramNotifier.notifyDiscoveredTrader` from Task 6

- [ ] **Step 1: Add the two new env vars**

In `src/config/env.ts`, in the `ENV` export object, after `TRACKED_TRADERS_REFRESH_SECONDS`, add:
```typescript
    // Hours between discoveryWorker leaderboard scans. Default: 12.
    DISCOVERY_INTERVAL_HOURS: parseInt(process.env.DISCOVERY_INTERVAL_HOURS || '12', 10),
    // Minimum discoverTraders.ts score (0-100) to trigger a pending-candidate alert.
    DISCOVERY_MIN_SCORE: parseInt(process.env.DISCOVERY_MIN_SCORE || '70', 10),
```

- [ ] **Step 2: Write `discoveryWorker.ts`**

Create `src/discoveryWorker.ts`:

```typescript
import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import { discoverTraders } from './scripts/discoverTraders';
import TrackedTraderModel from './models/trackedTrader';
import TelegramNotifier from './services/telegramNotifier';
import Logger from './utils/logger';
import { formatError } from './utils/errorHelpers';

let isRunning = true;
let intervalHandle: NodeJS.Timeout | null = null;

const runDiscoveryScan = async (): Promise<void> => {
    Logger.info('Starting leaderboard discovery scan...');
    try {
        const scores = await discoverTraders({ limit: 100 });
        const candidates = scores.filter((s) => s.totalScore >= ENV.DISCOVERY_MIN_SCORE);

        Logger.info(
            `Found ${candidates.length} candidate(s) scoring >= ${ENV.DISCOVERY_MIN_SCORE}`
        );

        for (const candidate of candidates) {
            const normalized = candidate.address.toLowerCase();
            const existing = await TrackedTraderModel.findOne({ address: normalized }).exec();
            if (existing) {
                continue; // Already tracked, pending, or previously rejected — don't re-alert
            }

            await TrackedTraderModel.create({
                address: normalized,
                status: 'pending',
                source: 'discovered_leaderboard',
                addedAt: new Date(),
                discoveryMeta: {
                    score: candidate.totalScore,
                    reason: `Score ${candidate.totalScore}/100 (${candidate.recommendation}) — win rate ${candidate.metrics.winRate.toFixed(1)}%, PnL $${candidate.metrics.totalPnl.toFixed(0)}`,
                },
            });

            await TelegramNotifier.notifyDiscoveredTrader({
                address: normalized,
                source: 'discovered_leaderboard',
                reason: `Score ${candidate.totalScore}/100 (${candidate.recommendation}) — win rate ${candidate.metrics.winRate.toFixed(1)}%, PnL $${candidate.metrics.totalPnl.toFixed(0)}`,
            });
        }

        Logger.success('Discovery scan complete');
    } catch (error) {
        Logger.error(`Discovery scan failed: ${formatError(error)}`);
    }
};

const gracefulShutdown = async (): Promise<void> => {
    isRunning = false;
    if (intervalHandle) {
        clearInterval(intervalHandle);
    }
    await closeDB();
    process.exit(0);
};

process.on('SIGTERM', () => void gracefulShutdown());
process.on('SIGINT', () => void gracefulShutdown());

const main = async (): Promise<void> => {
    await connectDB();
    Logger.success(
        `Discovery worker started — scanning every ${ENV.DISCOVERY_INTERVAL_HOURS}h, min score ${ENV.DISCOVERY_MIN_SCORE}`
    );

    await runDiscoveryScan();

    intervalHandle = setInterval(
        () => {
            if (isRunning) {
                void runDiscoveryScan();
            }
        },
        ENV.DISCOVERY_INTERVAL_HOURS * 60 * 60 * 1000
    );
};

main();
```

- [ ] **Step 3: Add the npm script**

In `package.json`, in the `"scripts"` section, add (alongside `"discover-traders"`):
```json
"discovery-worker": "ts-node src/discoveryWorker.ts",
```

- [ ] **Step 4: Add the PM2 app entry**

In `ecosystem.config.js`, add a second entry to the `apps` array (after the existing `polymarket-bot` entry):
```javascript
{
    name: 'discovery-worker',
    script: './dist/discoveryWorker.js',
    autorestart: true,
    watch: false,
    env: {
        NODE_ENV: 'production',
    },
    error_file: './logs/discovery-worker-error.log',
    out_file: './logs/discovery-worker-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    kill_timeout: 5000,
    max_restarts: 10,
    min_uptime: '10s',
},
```

- [ ] **Step 5: Verify strict build**

Run: `npm run build:strict`
Expected: clean — this also confirms `dist/discoveryWorker.js` will be produced by the existing build for the PM2 entry to reference.

- [ ] **Step 6: Manual verification**

Cannot be automated (hits the live leaderboard API and live Telegram). Run `npm run discovery-worker` directly (not via PM2) with valid `MONGO_URI` and Telegram config, let it complete one scan, and confirm: (a) it logs candidate counts, (b) any candidate scoring above `DISCOVERY_MIN_SCORE` produces exactly one `pending` row in `tracked_traders` and one Telegram alert with working buttons, (c) running it a second time does not re-alert on the same addresses (the `existing` check in Step 2 short-circuits).

- [ ] **Step 7: Commit**

```bash
git add src/discoveryWorker.ts src/config/env.ts package.json ecosystem.config.js
git commit -m "Add discoveryWorker: periodic leaderboard-based trader discovery

Standalone process (npm run discovery-worker, or the discovery-worker PM2
app) that scans the leaderboard every DISCOVERY_INTERVAL_HOURS, scores
candidates via the existing discoverTraders() logic, and writes pending
tracked_traders rows + Telegram alerts for anything scoring at or above
DISCOVERY_MIN_SCORE. Never writes status: active directly."
```

---

## Task 8: `newWalletWorker.ts` — real-time new-wallet detector

**Files:**
- Create: `src/models/seenWallet.ts`
- Create: `src/newWalletWorker.ts`
- Modify: `ecosystem.config.js` (add the new PM2 app)
- Modify: `package.json` (add an npm script)
- Modify: `src/config/env.ts` (add `NEW_WALLET_MIN_TRADE_USD`, `NEW_WALLET_SEEN_TTL_DAYS`)
- Test: `src/models/__tests__/seenWallet.test.ts`

**Interfaces:**
- Consumes: `RealTimeDataClient`, `Message` from `@polymarket/real-time-data-client` (already a dependency, used in `websocketTradeMonitor.ts`)
- Consumes: `TrackedTraderModel` from `src/models/trackedTrader.ts` (Task 2)
- Consumes: `TelegramNotifier.notifyDiscoveredTrader` from Task 6
- Produces: `SeenWalletModel` (Mongoose model, default export from `src/models/seenWallet.ts`)

- [ ] **Step 1: Add the two new env vars**

In `src/config/env.ts`, after `DISCOVERY_MIN_SCORE`, add:
```typescript
    // Minimum USD size of a wallet's FIRST observed trade to trigger a
    // pending-candidate alert. Default: 500.
    NEW_WALLET_MIN_TRADE_USD: parseFloat(process.env.NEW_WALLET_MIN_TRADE_USD || '500'),
    // Rolling window (days) for the seen_wallets TTL index — a wallet
    // silent longer than this is treated as "new" again. Default: 60.
    NEW_WALLET_SEEN_TTL_DAYS: parseInt(process.env.NEW_WALLET_SEEN_TTL_DAYS || '60', 10),
```

- [ ] **Step 2: Write the failing test for the `SeenWallet` model**

Create `src/models/__tests__/seenWallet.test.ts`:

```typescript
import SeenWalletModel from '../seenWallet';

describe('SeenWalletModel schema', () => {
    it('should build a valid document', () => {
        const doc = new SeenWalletModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            firstSeenAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeUndefined();
    });

    it('should fail validation without address', () => {
        const doc = new SeenWalletModel({ firstSeenAt: new Date() });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.address).toBeDefined();
    });

    it('should fail validation without firstSeenAt', () => {
        const doc = new SeenWalletModel({ address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b' });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.firstSeenAt).toBeDefined();
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- seenWallet.test.ts`
Expected: FAIL — `Cannot find module '../seenWallet'`.

- [ ] **Step 4: Write the model**

Create `src/models/seenWallet.ts`:

```typescript
import mongoose, { Schema, Document } from 'mongoose';
import { ENV } from '../config/env';

export interface SeenWalletInterface extends Document {
    address: string;
    firstSeenAt: Date;
}

const seenWalletSchema = new Schema<SeenWalletInterface>({
    address: { type: String, required: true, unique: true, lowercase: true },
    firstSeenAt: {
        type: Date,
        required: true,
        expires: ENV.NEW_WALLET_SEEN_TTL_DAYS * 24 * 60 * 60,
    },
});

const SeenWalletModel = mongoose.model<SeenWalletInterface>(
    'seen_wallets',
    seenWalletSchema,
    'seen_wallets'
);

export default SeenWalletModel;
```

(Mongoose's `expires` option on a `Date` field creates a TTL index measured in seconds from that field's value — this is the native MongoDB TTL mechanism referenced in the spec, no manual cleanup job needed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- seenWallet.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 6: Write `newWalletWorker.ts`**

Create `src/newWalletWorker.ts`:

```typescript
import { RealTimeDataClient, Message } from '@polymarket/real-time-data-client';
import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import SeenWalletModel from './models/seenWallet';
import TrackedTraderModel from './models/trackedTrader';
import TelegramNotifier from './services/telegramNotifier';
import Logger from './utils/logger';
import { formatError } from './utils/errorHelpers';

let client: RealTimeDataClient | null = null;
let isRunning = true;

const handleTradeMessage = async (message: Message): Promise<void> => {
    if (message.topic !== 'activity' || message.type !== 'trades') {
        return;
    }

    const trade = message.payload as Record<string, unknown>;
    const address = String(trade.proxyWallet ?? '').toLowerCase();
    if (!address) {
        return;
    }

    try {
        const alreadySeen = await SeenWalletModel.findOne({ address }).exec();
        if (alreadySeen) {
            return; // Not this wallet's first trade in the rolling window
        }

        await SeenWalletModel.create({ address, firstSeenAt: new Date() });

        const tradeSize = typeof trade.usdcSize === 'number' ? trade.usdcSize : 0;
        if (tradeSize < ENV.NEW_WALLET_MIN_TRADE_USD) {
            return;
        }

        const existingTracked = await TrackedTraderModel.findOne({ address }).exec();
        if (existingTracked) {
            return; // Already tracked/pending/rejected — don't re-alert
        }

        const reason = `First observed trade was $${tradeSize.toFixed(0)} (threshold: $${ENV.NEW_WALLET_MIN_TRADE_USD})`;

        await TrackedTraderModel.create({
            address,
            status: 'pending',
            source: 'discovered_new_wallet',
            addedAt: new Date(),
            discoveryMeta: { firstTradeSize: tradeSize, reason },
        });

        Logger.info(`🆕 New wallet with large first trade: ${address} ($${tradeSize.toFixed(0)})`);

        await TelegramNotifier.notifyDiscoveredTrader({
            address,
            source: 'discovered_new_wallet',
            reason,
        });
    } catch (error) {
        Logger.error(`Error handling trade for new-wallet detection: ${formatError(error)}`);
    }
};

const gracefulShutdown = async (): Promise<void> => {
    isRunning = false;
    if (client) {
        client.disconnect();
    }
    await closeDB();
    process.exit(0);
};

process.on('SIGTERM', () => void gracefulShutdown());
process.on('SIGINT', () => void gracefulShutdown());

const main = async (): Promise<void> => {
    await connectDB();
    Logger.success(
        `New-wallet worker started — min trade size $${ENV.NEW_WALLET_MIN_TRADE_USD}, ${ENV.NEW_WALLET_SEEN_TTL_DAYS}-day rolling window`
    );

    client = new RealTimeDataClient({
        autoReconnect: true,
        onConnect: (rtdc) => {
            Logger.success('✅ Connected to Polymarket real-time data stream');
            rtdc.subscribe({ subscriptions: [{ topic: 'activity', type: 'trades' }] });
            Logger.success('✅ Subscribed to activity/trades firehose');
        },
        onMessage: (_rtdc, message) => {
            if (isRunning) {
                void handleTradeMessage(message);
            }
        },
    });

    client.connect();
};

main();
```

- [ ] **Step 7: Add the npm script**

In `package.json`, alongside `"discovery-worker"`, add:
```json
"new-wallet-worker": "ts-node src/newWalletWorker.ts",
```

- [ ] **Step 8: Add the PM2 app entry**

In `ecosystem.config.js`, add a third entry to `apps` (after `discovery-worker`):
```javascript
{
    name: 'new-wallet-worker',
    script: './dist/newWalletWorker.js',
    autorestart: true,
    watch: false,
    env: {
        NODE_ENV: 'production',
    },
    error_file: './logs/new-wallet-worker-error.log',
    out_file: './logs/new-wallet-worker-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    kill_timeout: 5000,
    max_restarts: 10,
    min_uptime: '10s',
},
```

- [ ] **Step 9: Verify strict build**

Run: `npm run build:strict`
Expected: clean.

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 3 new `seenWallet.test.ts` tests.

- [ ] **Step 11: Manual verification**

Cannot be automated (hits the live firehose). Run `npm run new-wallet-worker` directly with valid `MONGO_URI` and Telegram config, let it run for several minutes (the platform-wide firehose is high-volume, so a hit is likely within minutes), and confirm: (a) `seen_wallets` is accumulating documents, (b) if/when a first-trade-over-threshold event fires, exactly one `pending` row + one Telegram alert is produced, (c) stopping and restarting the process does not re-alert on wallets already in `seen_wallets` (confirms the TTL/dedup logic survives a restart, since it's DB-backed not in-memory).

- [ ] **Step 12: Commit**

```bash
git add src/models/seenWallet.ts src/models/__tests__/seenWallet.test.ts src/newWalletWorker.ts src/config/env.ts package.json ecosystem.config.js
git commit -m "Add newWalletWorker: real-time new-wallet-big-trade detector

Standalone process subscribing to the activity/trades firehose, tracking
first-seen wallets in a TTL-indexed seen_wallets collection (rolling
NEW_WALLET_SEEN_TTL_DAYS window). A wallet's first trade above
NEW_WALLET_MIN_TRADE_USD produces a pending tracked_traders row and a
Telegram alert. Never writes status: active directly."
```

---

## Task 9: Update `docs/DEPLOYMENT.md` and `.env.example` for the new processes and env vars

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Modify: `.env.example`

**Interfaces:**
- None (documentation only)

- [ ] **Step 1: Add the new env vars to `.env.example`**

In `.env.example`, in the `BOT SETTINGS` section (near `USE_WEBSOCKET`, added in the earlier WebSocket work), add:
```bash
# How often (seconds) the running bot re-checks the database for
# added/removed traders. Default: 60.
TRACKED_TRADERS_REFRESH_SECONDS = 60

# Leaderboard discovery worker (npm run discovery-worker)
DISCOVERY_INTERVAL_HOURS = 12
DISCOVERY_MIN_SCORE = 70

# New-wallet detector worker (npm run new-wallet-worker)
NEW_WALLET_MIN_TRADE_USD = 500
NEW_WALLET_SEEN_TTL_DAYS = 60
```
Also update the existing `USER_ADDRESSES` line's comment to note it is now optional:
```bash
# Comma-separated or JSON array of trader addresses to copy.
# OPTIONAL as of dynamic trader management: used only to seed the
# tracked_traders database collection on first boot if it's empty.
# Add/remove traders afterward via Telegram (/add, /remove) instead.
USER_ADDRESSES = '0x...'
```

- [ ] **Step 2: Add a section to `docs/DEPLOYMENT.md` documenting the new PM2 apps**

Find the PM2 setup section in `docs/DEPLOYMENT.md` (search for `pm2 start` or the existing `ecosystem.config.js` reference) and add, after the main bot's start instructions:

```markdown
### Discovery Workers (Optional)

Two additional PM2 processes propose new trader candidates for review —
neither ever trades or auto-adds anyone; both send a Telegram alert with
Approve/Reject buttons for you to act on.

```bash
# Start all three processes (bot + both workers) at once:
pm2 start ecosystem.config.js

# Or start workers individually:
pm2 start ecosystem.config.js --only discovery-worker
pm2 start ecosystem.config.js --only new-wallet-worker

# View worker logs:
pm2 logs discovery-worker
pm2 logs new-wallet-worker
```

See `docs/superpowers/specs/2026-08-31-dynamic-trader-management-design.md`
for the full design.
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOYMENT.md .env.example
git commit -m "Document new env vars and discovery-worker PM2 apps"
```

---

## Self-Review Notes (completed during plan authoring)

- **Spec coverage:** all spec sections have a corresponding task — data model (Tasks 2, 8), live reload (Task 4), Telegram commands (Task 5), inline buttons (Task 6), both discovery workers (Tasks 7, 8), migration (Task 3's `seedFromEnvIfEmpty`, wired in Task 4), `validateRequiredEnv` relaxation (Task 4 Step 1), PM2/docs (Task 9).
- **Placeholder scan:** no TBD/TODO markers; every step has concrete code or an exact manual-verification procedure.
- **Type consistency:** `TraderModelConfig` is defined once in Task 3 and imported (not redefined) by Task 4's edits to `tradeMonitor.ts` and `websocketTradeMonitor.ts`; `tradeExecutor.ts` intentionally keeps its own narrower `UserActivityModelConfig` (it never needed `UserPosition`, matching its pre-existing shape) rather than force-fitting the shared type — called out explicitly in Task 4 Step 5 rather than left as a silent inconsistency.
