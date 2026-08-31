import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import Logger from '../utils/logger';
import PolymarketWebSocketClient from '../utils/websocketClient';
import {
    calculatePositionStats,
    fetchMyPositionsAndBalance,
    fetchUserPositionsAndBalance,
} from '../utils/positionHelpers';
import { formatError } from '../utils/errorHelpers';
import fetchData from '../utils/fetchData';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

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

// WebSocket client instance
let wsClient: PolymarketWebSocketClient | null = null;

// Track if monitor is running
let isRunning = false;

// Store position update interval
let positionUpdateInterval: NodeJS.Timeout | null = null;

/**
 * Format address for display (first 6 + last 4 characters)
 */
const formatAddress = (address: string): string => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

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

        const stats = calculatePositionStats(positions.map((p) => p.toObject()) as any);
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
    Logger.info(`🔔 New trade detected for ${formatAddress(address)}`);
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
 * Handle WebSocket trade message
 */
const handleTradeMessage = async (message: any): Promise<void> => {
    try {
        // Check if this is a trade message
        if (message.event_type !== 'trade' && message.type !== 'trade') {
            return;
        }

        // Extract trade data (format may vary, adjust based on actual API)
        const tradeData = message.data || message;
        const userAddress = (tradeData.maker || tradeData.user || '').toLowerCase();

        // Check if this trade is from one of our monitored traders
        const userModel = userModels.find((model) => model.address === userAddress);
        if (!userModel) {
            return; // Not a trader we're monitoring
        }

        Logger.info(`📨 WebSocket trade message received for ${formatAddress(userAddress)}`);

        // Fetch full trade details from API
        // (WebSocket might not include all fields we need)
        const apiUrl = `https://data-api.polymarket.com/activity?user=${userAddress}&type=TRADE`;
        const activities = (await fetchData(apiUrl)) as Array<Record<string, unknown>>;

        if (!Array.isArray(activities) || activities.length === 0) {
            return;
        }

        // Process the most recent trade(s)
        const recentTrades = activities.slice(0, 5); // Check last 5 trades
        for (const activity of recentTrades) {
            await processNewTrade(activity, userAddress, userModel.UserActivity);
        }

        // Update positions for this trader
        await updateTraderPositions(userAddress, userModel.UserPosition);
    } catch (error) {
        Logger.error(`Error handling WebSocket trade message: ${formatError(error)}`);
    }
};

/**
 * Fetch initial historical trades for all traders
 */
const fetchInitialTrades = async (): Promise<void> => {
    Logger.info('Fetching initial trade history...');

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
                `Error fetching initial data for ${formatAddress(address)}: ${formatError(error)}`
            );
        }
    }

    Logger.success('Initial trade history loaded');
};

/**
 * Start periodic position updates
 * (WebSocket only notifies on trades, not position changes)
 */
const startPositionUpdates = (): void => {
    // Update positions every 5 minutes
    positionUpdateInterval = setInterval(
        async () => {
            try {
                for (const { address, UserPosition } of userModels) {
                    await updateTraderPositions(address, UserPosition);
                }
            } catch (error) {
                Logger.error(`Error updating positions: ${formatError(error)}`);
            }
        },
        5 * 60 * 1000
    ); // 5 minutes
};

/**
 * Stop the WebSocket trade monitor
 */
export const stopWebSocketTradeMonitor = (): void => {
    isRunning = false;
    Logger.info('WebSocket trade monitor shutdown requested...');

    if (positionUpdateInterval) {
        clearInterval(positionUpdateInterval);
        positionUpdateInterval = null;
    }

    if (wsClient) {
        wsClient.close();
        wsClient = null;
    }
};

/**
 * Main WebSocket trade monitoring function
 */
const websocketTradeMonitor = async (): Promise<void> => {
    if (isRunning) {
        Logger.warning('WebSocket trade monitor is already running');
        return;
    }

    isRunning = true;

    await init();
    Logger.success(
        `🚀 WebSocket monitoring ${USER_ADDRESSES.length} trader(s) in real-time`
    );
    Logger.separator();

    // Fetch initial trade history
    await fetchInitialTrades();

    // Mark all existing historical trades as processed
    Logger.info('Marking historical trades as processed...');
    for (const { address, UserActivity } of userModels) {
        const count = await UserActivity.updateMany(
            { bot: false },
            { $set: { bot: true, botExcutedTime: 999 } }
        );
        if (count.modifiedCount > 0) {
            Logger.info(
                `Marked ${count.modifiedCount} historical trades as processed for ${formatAddress(address)}`
            );
        }
    }
    Logger.success('Historical trades processed. Now monitoring for new trades only.\n');
    Logger.separator();

    // Initialize WebSocket client
    wsClient = new PolymarketWebSocketClient(ENV.CLOB_WS_URL);

    // Register message handler
    wsClient.onMessage(handleTradeMessage);

    // Connect to WebSocket
    try {
        await wsClient.connect();

        // Subscribe to each trader's trades
        // Note: The exact subscription format depends on Polymarket's WebSocket API
        // This is a generic implementation that may need adjustment
        for (const address of USER_ADDRESSES) {
            Logger.info(`Subscribing to trades for ${formatAddress(address)}`);
            wsClient.subscribe('user', { user: address });
        }

        Logger.success(`✅ Subscribed to ${USER_ADDRESSES.length} trader(s)`);
        Logger.info('💡 Waiting for real-time trade notifications...\n');
    } catch (error) {
        Logger.error(`Failed to connect to WebSocket: ${formatError(error)}`);
        throw error;
    }

    // Start periodic position updates
    startPositionUpdates();

    // Keep monitor running
    while (isRunning) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    Logger.info('WebSocket trade monitor stopped');
};

export default websocketTradeMonitor;
