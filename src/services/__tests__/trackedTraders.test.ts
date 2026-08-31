// logger.ts imports chalk (ESM-only in this repo's installed version), which
// ts-jest cannot transform. Mock it so importing trackedTraders.ts for its
// pure diffTraderAddresses function doesn't drag in that transitive failure.
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}));

// config/env.ts runs dotenv.config() and parses the real .env at import
// time (including a console.log for TIERED_MULTIPLIERS), which is
// unrelated noise for these pure diffTraderAddresses tests. Mock the one
// export trackedTraders.ts needs from it.
jest.mock('../../config/env', () => ({
    isValidEthereumAddress: (address: string) => /^0x[a-fA-F0-9]{40}$/.test(address),
}));

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
