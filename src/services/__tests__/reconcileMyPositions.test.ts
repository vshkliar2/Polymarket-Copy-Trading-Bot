// tradeMonitor.ts's full import graph pulls in `../utils/errorHelpers`,
// which imports `@polymarket/bindings/clob` — an ESM-only dist bundle that
// ts-jest (as configured for this project) cannot transform. This is the
// same documented issue worked around in
// src/utils/__tests__/postOrder.myPositionWrites.test.ts and
// src/services/__tests__/trackedTraders.test.ts. tradeMonitor.ts also
// imports `../utils/logger`, which imports chalk v5 (also ESM-only) — same
// precedent, mocked the same way.
//
// Per Task 1/2's own established convention (see myPosition.test.ts and
// postOrder.myPositionWrites.test.ts), this repo does not use
// mongodb-memory-server anywhere — it is not an installed dependency, and
// Task 1/2 both avoided standing up a real Mongo connection in favor of
// mocking '../../models/myPosition' with an in-memory fake that implements
// exactly the Mongoose Model surface the code under test calls. This test
// follows that same convention instead of the brief's illustrative
// MongoMemoryServer sketch, for consistency and to avoid adding a heavyweight
// new dependency for a single test file.
//
// Only `fetchMyPositionsAndBalance` is mocked from positionHelpers —
// tradeMonitor.ts also imports `calculatePositionStats` and
// `fetchUserPositionsAndBalance` from the same module (used by other
// functions in the file, e.g. `init`/`updateTraderPositions`), so the mock
// factory preserves every other real export via jest.requireActual rather
// than replacing the whole module — matching the pattern used for
// '../../config/copyStrategy' in postOrder.myPositionWrites.test.ts.

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        clearLine: jest.fn(),
        separator: jest.fn(),
        dbConnection: jest.fn(),
        myPositions: jest.fn(),
        tradersPositions: jest.fn(),
        orderResult: jest.fn(),
    },
}));

jest.mock('../../utils/errorHelpers', () => ({
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    isInsufficientBalanceOrAllowanceCode: () => false,
}));

jest.mock('../../utils/positionHelpers', () => {
    const actual = jest.requireActual('../../utils/positionHelpers');
    return {
        ...actual,
        fetchMyPositionsAndBalance: jest.fn(),
    };
});

interface FakeDoc {
    conditionId: string;
    asset?: string;
    size: number;
    avgPrice: number;
    totalBought?: number;
    lastFillAt?: number;
}

let store: Map<string, FakeDoc>;

const fakeMyPositionModel = {
    findOne: (query: { conditionId: string }) => ({
        lean: async () => {
            const doc = store.get(query.conditionId);
            return doc ? { ...doc } : null;
        },
    }),
    // Only the projection shape reconcileMyPositions actually requests
    // ({ conditionId: 1, lastFillAt: 1 }) is honored here — this fake isn't
    // a general Mongoose stand-in, just enough surface for the code under
    // test.
    find: (_query: Record<string, unknown>, _projection?: Record<string, unknown>) => ({
        lean: () => ({
            exec: async () =>
                Array.from(store.values()).map((doc) => ({
                    conditionId: doc.conditionId,
                    lastFillAt: doc.lastFillAt,
                })),
        }),
    }),
    findOneAndUpdate: async (
        query: { conditionId: string },
        update: { $set: FakeDoc },
        _opts: { upsert: boolean }
    ) => {
        store.set(query.conditionId, { ...update.$set });
    },
    deleteMany: async (query: { conditionId: { $nin: string[] } }) => {
        const keep = new Set(query.conditionId.$nin);
        for (const key of Array.from(store.keys())) {
            if (!keep.has(key)) {
                store.delete(key);
            }
        }
    },
};

jest.mock('../../models/myPosition', () => ({
    getMyPositionModel: () => fakeMyPositionModel,
}));

import { fetchMyPositionsAndBalance } from '../../utils/positionHelpers';
import { getMyPositionModel } from '../../models/myPosition';
import { reconcileMyPositions } from '../tradeMonitor';

describe('reconcileMyPositions', () => {
    beforeEach(() => {
        store = new Map();
        jest.clearAllMocks();
    });

    it('upserts positions from the live API', async () => {
        (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
            positions: [{ conditionId: '0xa', asset: '1', size: 5, avgPrice: 0.3, totalBought: 5 }],
            usdcBalance: 100,
            totalBalance: 100,
        });

        await reconcileMyPositions();

        const doc = await getMyPositionModel().findOne({ conditionId: '0xa' }).lean();
        expect(doc?.size).toBe(5);
    });

    it('removes a position the DB has but the live API no longer reports', async () => {
        store.set('0xstale', {
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

    // Regression coverage for the fix-round finding: a reconciliation tick
    // firing within seconds of postOrder.ts's own fill write must not
    // clobber that fresh data with stale data from the live API's indexer,
    // which lags real on-chain settlement.
    describe('grace window (lastFillAt)', () => {
        it('does NOT overwrite a position with a recent lastFillAt, even with different live data', async () => {
            store.set('0xfresh', {
                conditionId: '0xfresh',
                asset: '1',
                size: 100,
                avgPrice: 0.5,
                totalBought: 100,
                lastFillAt: Date.now(), // just filled
            });
            (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
                positions: [
                    // Stale live data: indexer hasn't caught up to the fill yet.
                    { conditionId: '0xfresh', asset: '1', size: 0, avgPrice: 0, totalBought: 0 },
                ],
                usdcBalance: 100,
                totalBalance: 100,
            });

            await reconcileMyPositions();

            const doc = await getMyPositionModel().findOne({ conditionId: '0xfresh' }).lean();
            expect(doc?.size).toBe(100);
            expect(doc?.avgPrice).toBe(0.5);
        });

        it('does NOT delete a position with a recent lastFillAt even if the live API omits its conditionId entirely', async () => {
            store.set('0xbrandnew', {
                conditionId: '0xbrandnew',
                asset: '2',
                size: 50,
                avgPrice: 0.3,
                totalBought: 50,
                lastFillAt: Date.now(), // just filled; API hasn't indexed it at all yet
            });
            (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
                positions: [], // live API doesn't report this conditionId at all
                usdcBalance: 100,
                totalBalance: 100,
            });

            await reconcileMyPositions();

            const doc = await getMyPositionModel().findOne({ conditionId: '0xbrandnew' }).lean();
            expect(doc).not.toBeNull();
            expect(doc?.size).toBe(50);
        });

        it('still upserts a position with no lastFillAt normally', async () => {
            store.set('0xnofill', {
                conditionId: '0xnofill',
                asset: '3',
                size: 10,
                avgPrice: 0.2,
                totalBought: 10,
                // no lastFillAt
            });
            (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
                positions: [
                    {
                        conditionId: '0xnofill',
                        asset: '3',
                        size: 20,
                        avgPrice: 0.4,
                        totalBought: 20,
                    },
                ],
                usdcBalance: 100,
                totalBalance: 100,
            });

            await reconcileMyPositions();

            const doc = await getMyPositionModel().findOne({ conditionId: '0xnofill' }).lean();
            expect(doc?.size).toBe(20);
            expect(doc?.avgPrice).toBe(0.4);
        });

        it('still deletes a position with no lastFillAt when the live API omits it', async () => {
            store.set('0xoldstale', {
                conditionId: '0xoldstale',
                asset: '4',
                size: 5,
                avgPrice: 0.1,
                totalBought: 5,
                // no lastFillAt
            });
            (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
                positions: [],
                usdcBalance: 100,
                totalBalance: 100,
            });

            await reconcileMyPositions();

            const doc = await getMyPositionModel().findOne({ conditionId: '0xoldstale' }).lean();
            expect(doc).toBeNull();
        });

        it('treats a lastFillAt outside the grace window as stale — normal upsert/delete behavior applies', async () => {
            const longAgo = Date.now() - 61_000; // just past the 60s grace window
            store.set('0xoldfill', {
                conditionId: '0xoldfill',
                asset: '5',
                size: 100,
                avgPrice: 0.5,
                totalBought: 100,
                lastFillAt: longAgo,
            });
            store.set('0xoldfill2', {
                conditionId: '0xoldfill2',
                asset: '6',
                size: 100,
                avgPrice: 0.5,
                totalBought: 100,
                lastFillAt: longAgo,
            });
            (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
                positions: [
                    // 0xoldfill: live data differs — should overwrite since grace expired
                    { conditionId: '0xoldfill', asset: '5', size: 0, avgPrice: 0, totalBought: 0 },
                    // 0xoldfill2 omitted entirely — should be deleted since grace expired
                ],
                usdcBalance: 100,
                totalBalance: 100,
            });

            await reconcileMyPositions();

            const doc1 = await getMyPositionModel().findOne({ conditionId: '0xoldfill' }).lean();
            expect(doc1?.size).toBe(0);

            const doc2 = await getMyPositionModel().findOne({ conditionId: '0xoldfill2' }).lean();
            expect(doc2).toBeNull();
        });

        it('leaves other conditionIds unaffected when one conditionId is in its grace window', async () => {
            store.set('0xfresh2', {
                conditionId: '0xfresh2',
                asset: '7',
                size: 100,
                avgPrice: 0.5,
                totalBought: 100,
                lastFillAt: Date.now(),
            });
            (fetchMyPositionsAndBalance as jest.Mock).mockResolvedValue({
                positions: [
                    { conditionId: '0xfresh2', asset: '7', size: 0, avgPrice: 0, totalBought: 0 },
                    {
                        conditionId: '0xother',
                        asset: '8',
                        size: 25,
                        avgPrice: 0.6,
                        totalBought: 25,
                    },
                ],
                usdcBalance: 100,
                totalBalance: 100,
            });

            await reconcileMyPositions();

            // Fresh fill left alone
            const fresh = await getMyPositionModel().findOne({ conditionId: '0xfresh2' }).lean();
            expect(fresh?.size).toBe(100);

            // Other conditionId upserted normally
            const other = await getMyPositionModel().findOne({ conditionId: '0xother' }).lean();
            expect(other?.size).toBe(25);
        });
    });
});
