import { UserPositionInterface } from '../interfaces/User';
import fetchData from './fetchData';
import getMyBalance from './getMyBalance';
import MY_EOA_ADDRESS from './getMyEOA';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;

// Polymarket's /positions endpoint's own maximum page size (its default is
// 100, silently truncating without this).
const POSITIONS_PAGE_LIMIT = 500;

/**
 * Fetch every position for `userAddress`, paging through the /positions
 * endpoint via `limit`/`offset` until a short page signals the last one.
 * Without this, callers that need a user's FULL position list (as opposed
 * to fetchPositionForMarket's single-market lookup below) would silently
 * see only the endpoint's default first 100 positions — sorted
 * largest-position-first by default, so it's specifically the smaller
 * positions, or anything past the 100th, that go missing.
 */
const fetchAllPositions = async (userAddress: string): Promise<UserPositionInterface[]> => {
    const allPositions: UserPositionInterface[] = [];
    let offset = 0;

    for (;;) {
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${userAddress}&limit=${POSITIONS_PAGE_LIMIT}&offset=${offset}`;
        const page = (await fetchData(positionsUrl)) as UserPositionInterface[];
        const pageArray = Array.isArray(page) ? page : [];
        allPositions.push(...pageArray);

        if (pageArray.length < POSITIONS_PAGE_LIMIT) {
            break;
        }
        offset += POSITIONS_PAGE_LIMIT;
    }

    return allPositions;
};

/**
 * Position statistics for a trader
 */
export interface PositionStats {
    totalValue: number;
    initialValue: number;
    weightedPnl: number;
    overallPnl: number;
}

/**
 * Calculate position statistics from an array of positions
 *
 * @param positions - Array of positions to analyze
 * @returns Calculated position statistics
 */
export const calculatePositionStats = (positions: UserPositionInterface[]): PositionStats => {
    let totalValue = 0;
    let initialValue = 0;
    let weightedPnl = 0;

    positions.forEach((pos) => {
        const value = pos.currentValue ?? 0;
        const initial = pos.initialValue ?? 0;
        const pnl = pos.percentPnl ?? 0;

        totalValue += value;
        initialValue += initial;
        weightedPnl += value * pnl;
    });

    const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

    return {
        totalValue,
        initialValue,
        weightedPnl,
        overallPnl,
    };
};

/**
 * Fetch positions and balance for a user
 *
 * @param userAddress - Address of the user to fetch data for
 * @returns Object containing positions and calculated balance
 */
export const fetchUserPositionsAndBalance = async (
    userAddress: string
): Promise<{
    positions: UserPositionInterface[];
    balance: number;
}> => {
    const positionsArray = await fetchAllPositions(userAddress);

    // Calculate balance from positions (current value)
    const balance = positionsArray.reduce((total, pos) => {
        return total + (pos.currentValue ?? 0);
    }, 0);

    return {
        positions: positionsArray,
        balance,
    };
};

/**
 * Fetch my positions and USDC balance. Positions are queried by the signing
 * EOA address (data-api's indexing key); USDC balance is queried against
 * the proxy wallet (where funds actually sit on-chain).
 *
 * @returns Object containing my positions and USDC balance
 */
export const fetchMyPositionsAndBalance = async (): Promise<{
    positions: UserPositionInterface[];
    usdcBalance: number;
    totalBalance: number;
}> => {
    const positionsArray = await fetchAllPositions(MY_EOA_ADDRESS);

    // Get USDC balance
    const usdcBalance = await getMyBalance(PROXY_WALLET);

    // Calculate total balance (USDC + positions value)
    const positionsValue = positionsArray.reduce((total, pos) => {
        return total + (pos.currentValue ?? 0);
    }, 0);

    const totalBalance = usdcBalance + positionsValue;

    return {
        positions: positionsArray,
        usdcBalance,
        totalBalance,
    };
};

/**
 * Find a position by condition ID
 *
 * @param positions - Array of positions to search
 * @param conditionId - Condition ID to find
 * @returns Found position or undefined
 */
export const findPositionByConditionId = (
    positions: UserPositionInterface[],
    conditionId: string
): UserPositionInterface | undefined => {
    return positions.find((position) => position.conditionId === conditionId);
};

/**
 * Fetch a single position for `userAddress` in one specific market, via the
 * `/positions` endpoint's `market` (condition ID) query parameter.
 *
 * Currently unused by tradeExecutor.ts: this function originally backed
 * prepareTradeData's per-trade `myPosition` lookup, but the self-tracked
 * `my_positions` collection plan replaced that with a direct Mongo read —
 * see tradeExecutor.ts's `fetchMyPositionFromDb`, which reads the bot's own
 * position from `my_positions` (kept accurate by postOrder.ts's
 * recordBuyFill/recordSellFill on every fill, and by tradeMonitor.ts's
 * reconcileMyPositions tick) instead of calling the live API per trade.
 *
 * It is kept rather than deleted — a reasonable general-purpose utility for
 * fetching one user's position in one market scoped server-side (cheaper
 * and immune to the unscoped endpoint's page-size/sort caveats described
 * below), and a plausible fallback if a live-API read is ever needed again.
 * As of this writing it has no other production callers in this repo.
 *
 * Scoping server-side (vs. calling fetchUserPositionsAndBalance /
 * fetchMyPositionsAndBalance and filtering client-side) fixes two things:
 *
 * 1. Correctness: the unscoped endpoint defaults to limit=100 with no
 *    pagination in our calls, sorted largest-position-first by default. A
 *    real, held position that happens to be small (or one of >100 positions)
 *    could be silently excluded from the unscoped list, making
 *    findPositionByConditionId wrongly return undefined for a position that
 *    genuinely exists. Scoping by market can never be affected by that
 *    limit, since at most one position can match a single condition ID.
 * 2. Cost: the response body is at most one position instead of the user's
 *    entire portfolio.
 */
export const fetchPositionForMarket = async (
    userAddress: string,
    conditionId: string
): Promise<UserPositionInterface | undefined> => {
    const positionsUrl = `https://data-api.polymarket.com/positions?user=${userAddress}&market=${conditionId}`;
    const positions = (await fetchData(positionsUrl)) as UserPositionInterface[];
    const positionsArray = Array.isArray(positions) ? positions : [];
    return positionsArray[0];
};
