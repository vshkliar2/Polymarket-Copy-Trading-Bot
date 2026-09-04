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
}

let store: Map<string, FakeDoc>;

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
});
