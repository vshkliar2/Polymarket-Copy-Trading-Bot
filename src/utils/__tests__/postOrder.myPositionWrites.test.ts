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

jest.mock('../../models/myPosition', () => {
    return {
        getMyPositionModel: () => ({
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
            updateOne: async (
                query: { conditionId: string },
                update: { $set: Partial<FakeDoc> }
            ) => {
                const existing = store.get(query.conditionId);
                if (existing) {
                    store.set(query.conditionId, { ...existing, ...update.$set });
                }
            },
            deleteOne: async (query: { conditionId: string }) => {
                store.delete(query.conditionId);
            },
        }),
    };
});

import { __test_recordBuyFill, __test_recordSellFill } from '../postOrder';
import { getMyPositionModel } from '../../models/myPosition';

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
