import { ENV } from '../config/env';
import Logger from './logger';
import { fetchMyPositionsAndBalance } from './positionHelpers';

/**
 * Portfolio Manager
 * Handles position limits, diversification, and risk management
 */

/**
 * Get current position size for a specific market
 * @deprecated Use the position parameter in checkMarketPositionLimit instead
 */
export const getCurrentMarketPosition = async (
    conditionId: string
): Promise<{ currentValue: number; size: number; found: boolean }> => {
    try {
        const { positions } = await fetchMyPositionsAndBalance();

        const position = positions.find((p) => p.conditionId === conditionId);

        if (position) {
            return {
                currentValue: position.currentValue ?? 0,
                size: position.size ?? 0,
                found: true,
            };
        }

        return { currentValue: 0, size: 0, found: false };
    } catch (error) {
        Logger.error(`Error fetching market position: ${error}`);
        return { currentValue: 0, size: 0, found: false };
    }
};

/**
 * Check if adding a new trade would exceed per-market position limits
 * Returns adjusted amount if needed, or 0 if trade should be skipped
 *
 * @param proposedAmount - Amount in USD to add to this market
 * @param availableUSDC - Available USDC balance (not total balance!)
 * @param currentPosition - Optional existing position (pass to avoid redundant API call)
 */
export const checkMarketPositionLimit = (
    proposedAmount: number,
    availableUSDC: number,
    currentPosition?: { currentValue?: number; size?: number }
): { allowed: boolean; adjustedAmount: number; reason?: string } => {
    const maxUSD = ENV.MAX_POSITION_PER_MARKET_USD;
    const maxPercent = ENV.MAX_POSITION_PER_MARKET_PERCENT;

    // If no limits configured, allow everything
    if (!maxUSD && !maxPercent) {
        return { allowed: true, adjustedAmount: proposedAmount };
    }

    // Get current position value
    const currentValue = currentPosition?.currentValue ?? 0;

    // Calculate actual limit (use stricter of USD or % limit)
    let actualLimit = Infinity;

    if (maxUSD) {
        actualLimit = Math.min(actualLimit, maxUSD);
    }

    if (maxPercent) {
        const percentLimit = (availableUSDC * maxPercent) / 100;
        actualLimit = Math.min(actualLimit, percentLimit);
    }

    // Calculate what position would be after this trade
    const newTotal = currentValue + proposedAmount;

    if (newTotal <= actualLimit) {
        // Within limits
        return { allowed: true, adjustedAmount: proposedAmount };
    }

    // Would exceed limit - check if we can scale down
    const remainingBudget = actualLimit - currentValue;

    if (remainingBudget < 1.0) {
        // Less than $1 remaining - skip trade
        return {
            allowed: false,
            adjustedAmount: 0,
            reason: `Market position limit reached ($${actualLimit.toFixed(2)} max, currently $${currentValue.toFixed(2)})`,
        };
    }

    // Scale down to fit within limit
    return {
        allowed: true,
        adjustedAmount: remainingBudget,
        reason: `Scaled down from $${proposedAmount.toFixed(2)} to $${remainingBudget.toFixed(2)} (market limit: $${actualLimit.toFixed(2)})`,
    };
};

/**
 * Check if market end date is within acceptable range
 */
export const checkMarketEndDate = (
    endDate: string | number | undefined
): { allowed: boolean; reason?: string; daysUntilEnd?: number } => {
    const maxDays = ENV.MAX_MARKET_DURATION_DAYS;
    const minDays = ENV.MIN_MARKET_DURATION_DAYS;

    // If no end date configured, allow everything
    if (!endDate) {
        Logger.warning('Market has no end date - allowing trade');
        return { allowed: true };
    }

    // Parse end date
    let endTimestamp: number;
    if (typeof endDate === 'string') {
        endTimestamp = new Date(endDate).getTime();
    } else {
        endTimestamp = endDate;
    }

    if (isNaN(endTimestamp)) {
        Logger.warning('Invalid end date format - allowing trade');
        return { allowed: true };
    }

    const now = Date.now();
    const daysUntilEnd = (endTimestamp - now) / (1000 * 60 * 60 * 24);

    // Check if market has already ended
    if (daysUntilEnd < 0) {
        return {
            allowed: false,
            reason: 'Market has already ended',
            daysUntilEnd: 0,
        };
    }

    // Check minimum duration
    if (minDays && daysUntilEnd < minDays) {
        return {
            allowed: false,
            reason: `Market ends too soon (${daysUntilEnd.toFixed(1)} days, min: ${minDays} days)`,
            daysUntilEnd,
        };
    }

    // Check maximum duration
    if (maxDays && daysUntilEnd > maxDays) {
        return {
            allowed: false,
            reason: `Market ends too far away (${daysUntilEnd.toFixed(0)} days, max: ${maxDays} days)`,
            daysUntilEnd,
        };
    }

    return { allowed: true, daysUntilEnd };
};

/**
 * Get portfolio summary for monitoring
 */
export const getPortfolioSummary = async (): Promise<{
    totalValue: number;
    numPositions: number;
    topPositions: Array<{ market: string; value: number; percent: number }>;
    mostConcentrated?: { market: string; percent: number };
}> => {
    try {
        const { positions } = await fetchMyPositionsAndBalance();

        const totalValue = positions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);

        const positionDetails = positions.map((p) => ({
            market: p.title || 'Unknown',
            value: p.currentValue ?? 0,
            percent: totalValue > 0 ? ((p.currentValue ?? 0) / totalValue) * 100 : 0,
        }));

        // Sort by value descending
        positionDetails.sort((a, b) => b.value - a.value);

        const topPositions = positionDetails.slice(0, 5);
        const mostConcentrated =
            positionDetails.length > 0 ? positionDetails[0] : undefined;

        return {
            totalValue,
            numPositions: positions.length,
            topPositions,
            mostConcentrated,
        };
    } catch (error) {
        Logger.error(`Error getting portfolio summary: ${error}`);
        return {
            totalValue: 0,
            numPositions: 0,
            topPositions: [],
        };
    }
};
