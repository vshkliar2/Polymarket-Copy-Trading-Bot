// src/services/telegramCommands/__tests__/positions.test.ts
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

import { renderPosition } from '../positions';
import type { ApiPosition } from '../../../utils/publicClient';

const buildPosition = (overrides: Partial<ApiPosition> = {}): ApiPosition => ({
    proxyWallet: '0xabc',
    asset: '123',
    conditionId: '0xdef',
    size: 250,
    avgPrice: 0.42,
    initialValue: 105,
    currentValue: 113.75,
    cashPnl: 8.75,
    percentPnl: 8.3333,
    totalBought: 250,
    realizedPnl: 0,
    percentRealizedPnl: 8.3333,
    curPrice: 0.455,
    redeemable: false,
    mergeable: false,
    title: 'Trump meets with Putin by December 31?',
    slug: 'trump-meets-with-putin-by-december-31',
    icon: '',
    eventSlug: 'trump-meets-with-putin-by',
    outcome: 'No',
    outcomeIndex: 1,
    oppositeOutcome: 'Yes',
    oppositeAsset: '456',
    endDate: '2027-01-01',
    negativeRisk: false,
    ...overrides,
});

describe('renderPosition', () => {
    it('includes the market title, outcome, size, prices, value, PnL, and a link', () => {
        const text = renderPosition(buildPosition());

        expect(text).toContain('Trump meets with Putin by December 31?');
        expect(text).toContain('No');
        expect(text).toContain('250');
        expect(text).toContain('$0.42');
        expect(text).toContain('$0.455');
        expect(text).toContain('$113.75');
        expect(text).toContain('+$8.75');
        expect(text).toContain('8.3%');
        expect(text).toContain(
            'https://polymarket.com/event/trump-meets-with-putin-by-december-31'
        );
    });

    it('shows a negative PnL without a plus sign', () => {
        const text = renderPosition(buildPosition({ cashPnl: -3.383, percentPnl: -70.6263 }));
        expect(text).toContain('-$3.38');
        expect(text).not.toContain('+-');
    });
});
