// postOrder.ts's full import graph cannot be transformed by ts-jest as
// configured for this project: both `@polymarket/client` and
// `@polymarket/bindings/clob`'s own dist bundles are ESM (fail to parse
// directly), and `./logger` imports chalk v5 (also ESM-only — see the same
// issue called out in src/services/__tests__/trackedTraders.test.ts). No
// existing src/utils/__tests__/*postorder* file exists to mimic a working
// mocking setup for these dependencies either (confirmed by probing before
// writing this file). So, per the task brief's documented fallback, this is
// a narrower unit test written directly against the two new internal helper
// functions (__test_recordBuyFill / __test_recordSellFill), exported
// test-only per the brief's own naming convention (grepped for
// `__test_`/`VisibleForTesting`/`@internal` first — no existing convention
// was found in this codebase).
//
// Only the things that actually fail transformation are mocked below:
// `@polymarket/client` and `@polymarket/bindings/clob` (minimal enum/class
// stubs — real values don't matter since none of postOrder.ts's
// order-submission logic runs in this test) and `./logger` (following the
// exact precedent in trackedTraders.test.ts). `../config/env` is left real
// — it just runs dotenv.config() against this worktree's real (gitignored)
// .env file, which is harmless in a test process.
//
// Rather than adding a new `mongodb-memory-server` dependency (a heavyweight
// addition — downloads a real MongoDB binary — for a single test file) to
// spin up a real Mongo connection for getMyPositionModel(), this mocks
// '../../models/myPosition' with an in-memory fake that implements exactly
// the Mongoose Model surface the two helpers call (findOne().lean(),
// findOneAndUpdate, updateOne, deleteOne). This matches Task 1's own test
// choice (src/models/__tests__/myPosition.test.ts) to not stand up a real DB
// connection, and matches this repo's existing jest.mock-based convention
// for isolating a unit under test from its dependencies (see
// src/services/__tests__/trackedTraders.test.ts).

// DRY_RUN is read once as a module-level const in postOrder.ts
// (`const DRY_RUN = ENV.DRY_RUN;`), captured at import time from
// `process.env.DRY_RUN === 'true'`. Set explicitly here (rather than
// relying on this worktree's own .env) so the fill-success regression test
// below is portable across environments and exercises submitOrder's
// dry-run path instead of a real client.placeMarketOrder call.
process.env.DRY_RUN = 'true';

jest.mock('../logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        orderResult: jest.fn(),
    },
}));

jest.mock('@polymarket/client', () => ({
    OrderSide: { BUY: 'BUY', SELL: 'SELL' },
    OrderType: { FOK: 'FOK', FAK: 'FAK' },
    RequestRejectedError: class RequestRejectedError extends Error {},
}));

jest.mock('@polymarket/bindings/clob', () => ({
    OrderPostStatus: { MATCHED: 'MATCHED', LIVE: 'LIVE', DELAYED: 'DELAYED' },
    OrderResponseErrorCode: {
        INSUFFICIENT_BALANCE_OR_ALLOWANCE: 'INSUFFICIENT_BALANCE_OR_ALLOWANCE',
        FOK_NOT_FILLED: 'FOK_NOT_FILLED',
        FAK_NOT_FILLED: 'FAK_NOT_FILLED',
        MARKET_NOT_READY: 'MARKET_NOT_READY',
        INVALID_NONCE: 'INVALID_NONCE',
        INVALID_EXPIRATION: 'INVALID_EXPIRATION',
        POST_ONLY_WOULD_CROSS: 'POST_ONLY_WOULD_CROSS',
        POST_ONLY_MODE: 'POST_ONLY_MODE',
        UNKNOWN: 'UNKNOWN',
    },
}));

interface FakeDoc {
    conditionId: string;
    asset?: string;
    size: number;
    avgPrice: number;
    totalBought: number;
}

let store: Map<string, FakeDoc>;

// A single stable fake model object (not a fresh object literal per call) so
// that a test can override one of its methods (e.g. findOneAndUpdate) with
// a jest.fn() that rejects, and have every subsequent call to
// getMyPositionModel() from postOrder.ts's helpers see that same override —
// needed for the "write throws" regression tests below.
const fakeMyPositionModel = {
    findOne: (query: { conditionId: string }) => ({
        lean: async () => {
            const doc = store.get(query.conditionId);
            return doc ? { ...doc } : null;
        },
    }),
    findOneAndUpdate: async (
        query: { conditionId: string },
        update: { $set: FakeDoc },
        _opts: { upsert: boolean }
    ) => {
        store.set(query.conditionId, { ...update.$set });
    },
    updateOne: async (query: { conditionId: string }, update: { $set: Partial<FakeDoc> }) => {
        const existing = store.get(query.conditionId);
        if (existing) {
            store.set(query.conditionId, { ...existing, ...update.$set });
        }
    },
    deleteOne: async (query: { conditionId: string }) => {
        store.delete(query.conditionId);
    },
};

jest.mock('../../models/myPosition', () => {
    return {
        getMyPositionModel: () => fakeMyPositionModel,
    };
});

// --- Mocks for the fill-success regression test (postBuyOrder/postSellOrder
// end-to-end) below. These isolate the test from unrelated business logic
// (copy-strategy sizing config, per-market position limits, market end-date
// filtering, real .env values) so it exercises only what's relevant here:
// that a thrown error from recordBuyFill/recordSellFill is now caught and
// does not propagate out of postBuyOrder/postSellOrder or abort the
// existing Logger.orderResult/Telegram-notification/retry-loop flow.

let userActivityUpdateOne: jest.Mock;
let userActivityFind: jest.Mock;

jest.mock('../../models/userHistory', () => ({
    getUserActivityModel: () => ({
        updateOne: (...args: unknown[]) => userActivityUpdateOne(...args),
        find: (...args: unknown[]) => ({
            exec: async () => userActivityFind(...args),
        }),
        updateMany: async () => undefined,
    }),
}));

jest.mock('../../config/copyStrategy', () => {
    // env.ts imports the real CopyStrategy enum from this same module for
    // its own config parsing, so preserve every real export and only
    // override the two functions postOrder.ts calls for sizing — keeps
    // this test isolated from whatever COPY_STRATEGY-related values happen
    // to be set in this worktree's .env, without breaking env.ts's import.
    const actual = jest.requireActual('../../config/copyStrategy');
    return {
        ...actual,
        calculateOrderSize: () => ({
            finalAmount: 10,
            reasoning: 'test fixed $10 order',
            belowMinimum: false,
        }),
        getTradeMultiplier: () => 1,
    };
});

jest.mock('../portfolioManager', () => ({
    checkMarketPositionLimit: () => ({ allowed: true, adjustedAmount: 10 }),
    checkMarketEndDate: () => ({ allowed: true }),
}));

jest.mock('../../services/telegramNotifier', () => ({
    __esModule: true,
    default: {
        notify: jest.fn().mockResolvedValue(undefined),
        notifyTrade: jest.fn().mockResolvedValue(undefined),
        notifyError: jest.fn().mockResolvedValue(undefined),
    },
}));

import {
    __test_recordBuyFill,
    __test_recordSellFill,
    postBuyOrder,
    postSellOrder,
} from '../postOrder';
import { getMyPositionModel } from '../../models/myPosition';
import type { UserActivityInterface, UserPositionInterface } from '../../interfaces/User';
import Logger from '../logger';

describe('my_positions writes on fill', () => {
    beforeEach(() => {
        store = new Map();
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

// Regression coverage for the fix-round finding: a my_positions write
// failure (recordBuyFill/recordSellFill throwing, e.g. a transient Mongo
// error) must be caught inside postBuyOrder/postSellOrder and must NOT
// propagate out of, or abort, the enclosing function — the fill itself
// already happened and is order-critical; my_positions bookkeeping is not.
describe('my_positions write failures do not abort postBuyOrder/postSellOrder', () => {
    const baseTrade = {
        _id: 'trade-id-1',
        conditionId: '0xcondFail',
        asset: 'assetFail',
        price: 0.5,
        usdcSize: 10,
        size: 20,
        title: 'Test Market',
        slug: 'test-market',
        endDate: undefined,
    } as unknown as UserActivityInterface;

    const fakeClientBuy = {
        fetchOrderBook: jest.fn().mockResolvedValue({
            asks: [{ price: '0.5', size: '100' }],
            bids: [],
        }),
    };

    const fakeClientSell = {
        fetchOrderBook: jest.fn().mockResolvedValue({
            asks: [],
            bids: [{ price: '0.5', size: '100' }],
        }),
    };

    beforeEach(() => {
        store = new Map();
        userActivityUpdateOne = jest.fn().mockResolvedValue(undefined);
        userActivityFind = jest.fn().mockResolvedValue([]);
        jest.clearAllMocks();
    });

    it('postBuyOrder does not throw and still logs the fill when recordBuyFill throws', async () => {
        const originalFindOneAndUpdate = getMyPositionModel().findOneAndUpdate;
        (getMyPositionModel().findOneAndUpdate as unknown) = jest
            .fn()
            .mockRejectedValue(new Error('simulated Mongo write failure'));

        await expect(
            postBuyOrder(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                fakeClientBuy as any,
                undefined,
                baseTrade,
                1000,
                '0xuser'
            )
        ).resolves.toBeUndefined();

        // The fill still completed and was logged/tracked despite the
        // my_positions write failing — the failure must be swallowed, not
        // allowed to abort the function before Logger.orderResult runs.
        expect(Logger.orderResult).toHaveBeenCalledWith(true, expect.stringContaining('Bought'));
        expect(Logger.warning).toHaveBeenCalledWith(
            expect.stringContaining('Failed to record BUY fill in my_positions')
        );
        expect(userActivityUpdateOne).toHaveBeenCalled();

        (getMyPositionModel().findOneAndUpdate as unknown) = originalFindOneAndUpdate;
    });

    it('postSellOrder does not throw and still logs the fill when recordSellFill throws', async () => {
        // Seed an existing position so postSellOrder has something to sell.
        store.set('0xcondFail', {
            conditionId: '0xcondFail',
            asset: 'assetFail',
            size: 20,
            avgPrice: 0.5,
            totalBought: 20,
        });
        const myPosition = {
            size: 20,
            avgPrice: 0.5,
        } as unknown as UserPositionInterface;

        const originalFindOne = getMyPositionModel().findOne;
        (getMyPositionModel().findOne as unknown) = jest.fn().mockImplementation(() => ({
            lean: async () => {
                throw new Error('simulated Mongo read failure');
            },
        }));

        await expect(
            postSellOrder(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                fakeClientSell as any,
                myPosition,
                undefined,
                baseTrade,
                1000,
                '0xuser'
            )
        ).resolves.toBeUndefined();

        expect(Logger.orderResult).toHaveBeenCalledWith(true, expect.stringContaining('Sold'));
        expect(Logger.warning).toHaveBeenCalledWith(
            expect.stringContaining('Failed to record SELL fill in my_positions')
        );
        expect(userActivityUpdateOne).toHaveBeenCalled();

        (getMyPositionModel().findOne as unknown) = originalFindOne;
    });
});
