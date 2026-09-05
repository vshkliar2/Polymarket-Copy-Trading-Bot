jest.mock('../../../utils/errorHelpers', () => ({
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    isInsufficientBalanceOrAllowanceCode: () => false,
}));

jest.mock('@polymarket/client', () => ({
    createPublicClient: () => ({}),
}));

import { isConditionId, renderMarket } from '../market';
import type { Market } from '@polymarket/client';

describe('isConditionId', () => {
    it('recognizes a 0x-prefixed hex string as a condition ID', () => {
        expect(
            isConditionId('0x15ddba100cf49043ada06a98d63ac221cdca86da873485dcca72c174cb9cc300')
        ).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(
            isConditionId('0X15DDBA100CF49043ADA06A98D63AC221CDCA86DA873485DCCA72C174CB9CC300')
        ).toBe(true);
    });

    it('treats a plain slug as not a condition ID', () => {
        expect(isConditionId('trump-meets-with-putin-by-december-31')).toBe(false);
    });

    it('treats an empty string as not a condition ID', () => {
        expect(isConditionId('')).toBe(false);
    });
});

const buildMarket = (overrides: Partial<Market> = {}): Market =>
    ({
        id: '2365031',
        slug: 'trump-meets-with-putin-by-december-31',
        conditionId: '0x15ddba100cf49043ada06a98d63ac221cdca86da873485dcca72c174cb9cc300',
        question: 'Trump meets with Putin by December 31?',
        state: { active: true, closed: false } as Market['state'],
        prices: {
            bestBid: '0.54',
            bestAsk: '0.55',
            lastTradePrice: '0.54',
            spread: '0.01',
        } as Market['prices'],
        metrics: {
            volume24hr: '302.63173700000004',
            volume: '119323.761939',
            liquidity: '44751.6627',
        } as Market['metrics'],
        outcomes: {
            yes: { label: 'Yes', price: '0.545' },
            no: { label: 'No', price: '0.455' },
        } as Market['outcomes'],
        ...overrides,
    }) as Market;

describe('renderMarket', () => {
    it('includes question, outcome prices, spread, volume, liquidity, status, and a link', () => {
        const text = renderMarket(buildMarket());

        expect(text).toContain('Trump meets with Putin by December 31?');
        expect(text).toContain('$0.545');
        expect(text).toContain('$0.455');
        expect(text).toContain('$0.01');
        expect(text).toContain('$302.63');
        expect(text).toContain('$119,323.76');
        expect(text).toContain('$44,751.66');
        expect(text).toContain('active');
        expect(text).toContain(
            'https://polymarket.com/event/trump-meets-with-putin-by-december-31'
        );
    });

    it('shows closed status for a closed market', () => {
        const text = renderMarket(
            buildMarket({ state: { active: false, closed: true } as Market['state'] })
        );
        expect(text).toContain('closed');
    });

    it('escapes HTML-significant characters in the question', () => {
        const text = renderMarket(buildMarket({ question: 'Fed cuts & CPI < 3%?' }));
        expect(text).toContain('Fed cuts &amp; CPI &lt; 3%?');
        expect(text).not.toContain('Fed cuts & CPI < 3%?');
    });
});
