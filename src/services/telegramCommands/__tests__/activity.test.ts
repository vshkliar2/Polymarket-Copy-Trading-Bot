// src/services/telegramCommands/__tests__/activity.test.ts
jest.mock('../../../utils/errorHelpers', () => ({
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    isInsufficientBalanceOrAllowanceCode: () => false,
}));

jest.mock('../../../utils/publicClient', () => ({
    __esModule: true,
    default: {
        getPositions: jest.fn(),
        getAllPositions: jest.fn(),
        getClosedPositions: jest.fn(),
        getTradeActivity: jest.fn(),
        getLeaderboard: jest.fn(),
        getTrades: jest.fn(),
        getUserProfile: jest.fn(),
    },
}));

import { renderActivity } from '../activity';
import type { ApiActivity } from '../../../utils/publicClient';

const buildActivity = (overrides: Partial<ApiActivity> = {}): ApiActivity => ({
    proxyWallet: '0xabc',
    timestamp: 1788551163000,
    conditionId: '0xdef',
    type: 'TRADE',
    size: 54.86,
    usdcSize: 36.32,
    transactionHash: '0x123',
    price: 0.66,
    asset: '789',
    side: 'BUY',
    outcomeIndex: 1,
    title: 'US x Iran Effective Ceasefire by September 4?',
    slug: 'us-x-iran-effective-ceasefire-by-september-4',
    icon: '',
    eventSlug: 'us-x-iran-effective-ceasefire-begins',
    outcome: 'No',
    name: '',
    pseudonym: '',
    bio: '',
    profileImage: '',
    profileImageOptimized: '',
    bot: false,
    botExcutedTime: 0,
    ...overrides,
});

describe('renderActivity', () => {
    it('includes side, size, market title, price, and dollar amount', () => {
        const text = renderActivity(buildActivity());

        expect(text).toContain('BUY');
        expect(text).toContain('54.86');
        expect(text).toContain('US x Iran Effective Ceasefire by September 4?');
        expect(text).toContain('$0.66');
        expect(text).toContain('$36.32');
    });

    it('renders SELL activity distinctly from BUY', () => {
        const text = renderActivity(buildActivity({ side: 'SELL' }));
        expect(text).toContain('SELL');
    });
});
