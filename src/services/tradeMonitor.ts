import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import {
    calculatePositionStats,
    fetchMyPositionsAndBalance,
    fetchUserPositionsAndBalance,
} from '../utils/positionHelpers';
import { formatError } from '../utils/errorHelpers';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

/**
 * User model configuration
 */
interface UserModelConfig {
    address: string;
    UserActivity: ReturnType<typeof getUserActivityModel>;
    UserPosition: ReturnType<typeof getUserPositionModel>;
}

// Create activity and position models for each user
const userModels: UserModelConfig[] = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

/**
 * Initialize and display position information
 */
const init = async (): Promise<void> => {
    // Count trades for each trader
    const counts: number[] = [];
    for (const { UserActivity } of userModels) {
        const count = await UserActivity.countDocuments();
        counts.push(count);
    }
    Logger.clearLine();
    Logger.dbConnection(USER_ADDRESSES, counts);

    // Show your own positions first
    try {
        const { positions: myPositions, usdcBalance } = await fetchMyPositionsAndBalance();

        if (myPositions.length > 0) {
            const stats = calculatePositionStats(myPositions);

            // Get top 5 positions by profitability (PnL)
            const myTopPositions = myPositions
                .sort((a, b) => (b.percentPnl ?? 0) - (a.percentPnl ?? 0))
                .slice(0, 5)
                .map((p) => ({
                    outcome: p.outcome,
                    title: p.title,
                    currentValue: p.currentValue ?? 0,
                    percentPnl: p.percentPnl ?? 0,
                    avgPrice: p.avgPrice ?? 0,
                    curPrice: p.curPrice ?? 0,
                }));

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET,
                myPositions.length,
                myTopPositions,
                stats.overallPnl,
                stats.totalValue,
                stats.initialValue,
                usdcBalance
            );
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, usdcBalance);
        }
    } catch (error) {
        Logger.error(`Failed to fetch your positions: ${formatError(error)}`);
    }

    // Show current positions count with details for traders you're copying
    const positionCounts: number[] = [];
    const positionDetails: Array<Array<Record<string, unknown>>> = [];
    const profitabilities: number[] = [];

    for (const { UserPosition } of userModels) {
        const positions = await UserPosition.find().exec();
        positionCounts.push(positions.length);

        const stats = calculatePositionStats(positions.map(p => p.toObject()) as any);
        profitabilities.push(stats.overallPnl);

        // Get top 3 positions by profitability (PnL)
        const topPositions = positions
            .sort((a, b) => (b.percentPnl ?? 0) - (a.percentPnl ?? 0))
            .slice(0, 3)
            .map((p) => ({
                outcome: p.outcome,
                title: p.title,
                currentValue: p.currentValue ?? 0,
                percentPnl: p.percentPnl ?? 0,
                avgPrice: p.avgPrice ?? 0,
                curPrice: p.curPrice ?? 0,
            }));
        positionDetails.push(topPositions);
    }

    Logger.clearLine();
    Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);
};

/**
 * Format address for display (first 6 + last 4 characters)
 */
const formatAddress = (address: string): string => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

/**
 * Process and save a new trade activity
 */
const processNewTrade = async (
    activity: Record<string, unknown>,
    address: string,
    UserActivity: UserModelConfig['UserActivity']
): Promise<void> => {
    // Skip if too old
    const timestamp = typeof activity.timestamp === 'number' ? activity.timestamp : 0;
    if (timestamp < TOO_OLD_TIMESTAMP) {
        return;
    }

    // Check if this trade already exists in database
    const transactionHash = String(activity.transactionHash ?? '');
    const existingActivity = await UserActivity.findOne({
        transactionHash,
    }).exec();

    if (existingActivity) {
        return; // Already processed this trade
    }

    // Save new trade to database
    const newActivity = new UserActivity({
        proxyWallet: String(activity.proxyWallet ?? ''),
        timestamp,
        conditionId: String(activity.conditionId ?? ''),
        type: String(activity.type ?? ''),
        size: typeof activity.size === 'number' ? activity.size : 0,
        usdcSize: typeof activity.usdcSize === 'number' ? activity.usdcSize : 0,
        transactionHash,
        price: typeof activity.price === 'number' ? activity.price : 0,
        asset: String(activity.asset ?? ''),
        side: String(activity.side ?? ''),
        outcomeIndex: typeof activity.outcomeIndex === 'number' ? activity.outcomeIndex : 0,
        title: String(activity.title ?? ''),
        slug: String(activity.slug ?? ''),
        icon: String(activity.icon ?? ''),
        eventSlug: String(activity.eventSlug ?? ''),
        outcome: String(activity.outcome ?? ''),
        name: String(activity.name ?? ''),
        pseudonym: String(activity.pseudonym ?? ''),
        bio: String(activity.bio ?? ''),
        profileImage: String(activity.profileImage ?? ''),
        profileImageOptimized: String(activity.profileImageOptimized ?? ''),
        bot: false,
        botExcutedTime: 0,
    });

    await newActivity.save();
    Logger.info(`New trade detected for ${formatAddress(address)}`);
};

/**
 * Update positions for a trader
 */
const updateTraderPositions = async (
    address: string,
    UserPosition: UserModelConfig['UserPosition']
): Promise<void> => {
    const { positions } = await fetchUserPositionsAndBalance(address);

    if (positions.length > 0) {
        for (const position of positions) {
            // Update or create position
            await UserPosition.findOneAndUpdate(
                { asset: position.asset ?? '', conditionId: position.conditionId ?? '' },
                {
                    proxyWallet: position.proxyWallet,
                    asset: position.asset,
                    conditionId: position.conditionId,
                    size: position.size,
                    avgPrice: position.avgPrice,
                    initialValue: position.initialValue,
                    currentValue: position.currentValue,
                    cashPnl: position.cashPnl,
                    percentPnl: position.percentPnl,
                    totalBought: position.totalBought,
                    realizedPnl: position.realizedPnl,
                    percentRealizedPnl: position.percentRealizedPnl,
                    curPrice: position.curPrice,
                    redeemable: position.redeemable,
                    mergeable: position.mergeable,
                    title: position.title,
                    slug: position.slug,
                    icon: position.icon,
                    eventSlug: position.eventSlug,
                    outcome: position.outcome,
                    outcomeIndex: position.outcomeIndex,
                    oppositeOutcome: position.oppositeOutcome,
                    oppositeAsset: position.oppositeAsset,
                    endDate: position.endDate,
                    negativeRisk: position.negativeRisk,
                },
                { upsert: true }
            );
        }
    }
};

/**
 * Fetch and process trade data for all monitored traders
 */
const fetchTradeData = async (): Promise<void> => {
    for (const { address, UserActivity, UserPosition } of userModels) {
        try {
            // Fetch trade activities from Polymarket API
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
            const activities = (await fetchData(apiUrl)) as Array<Record<string, unknown>>;

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            // Process each activity
            for (const activity of activities) {
                await processNewTrade(activity, address, UserActivity);
            }

            // Update positions
            await updateTraderPositions(address, UserPosition);
        } catch (error) {
            Logger.error(
                `Error fetching data for ${formatAddress(address)}: ${formatError(error)}`
            );
        }
    }
};

// Track if this is the first run
let isFirstRun = true;
// Track if monitor should continue running
let isRunning = true;

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = (): void => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
};

/**
 * Main trade monitoring function
 * Monitors traders for new trades and updates positions
 */
const tradeMonitor = async (): Promise<void> => {
    await init();
    Logger.success(`Monitoring ${USER_ADDRESSES.length} trader(s) every ${FETCH_INTERVAL}s`);
    Logger.separator();

    // On first run, mark all existing historical trades as already processed
    if (isFirstRun) {
        Logger.info('First run: marking all historical trades as processed...');
        for (const { address, UserActivity } of userModels) {
            const count = await UserActivity.updateMany(
                { bot: false },
                { $set: { bot: true, botExcutedTime: 999 } }
            );
            if (count.modifiedCount > 0) {
                Logger.info(
                    `Marked ${count.modifiedCount} historical trades as processed for ${address.slice(0, 6)}...${address.slice(-4)}`
                );
            }
        }
        isFirstRun = false;
        Logger.success('\nHistorical trades processed. Now monitoring for new trades only.');
        Logger.separator();
    }

    while (isRunning) {
        await fetchTradeData();
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
