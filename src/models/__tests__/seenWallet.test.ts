// seenWallet.ts imports ENV from config/env.ts to compute its TTL index
// (ENV.NEW_WALLET_SEEN_TTL_DAYS). config/env.ts runs dotenv.config() and
// console.logs at import time, and transitively pulls in utils/logger.ts,
// which imports chalk@5 (ESM-only) — ts-jest's CommonJS transform can't
// handle that import and fails with "Cannot use import statement outside
// a module". Mock the one field this model reads from ENV, same fix used
// in src/services/__tests__/trackedTraders.test.ts (Task 3).
jest.mock('../../config/env', () => ({
    ENV: { NEW_WALLET_SEEN_TTL_DAYS: 60 },
}));

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
