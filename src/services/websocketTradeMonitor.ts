import { RealTimeDataClient, Message, ConnectionStatus } from '@polymarket/real-time-data-client';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import TelegramNotifier from './telegramNotifier';
import {
    calculatePositionStats,
    fetchMyPositionsAndBalance,
    fetchUserPositionsAndBalance,
} from '../utils/positionHelpers';
import { formatError } from '../utils/errorHelpers';
import fetchData from '../utils/fetchData';
import {
    diffTraderAddresses,
    getActiveTraderAddresses,
    seedFromEnvIfEmpty,
    buildTraderModelMap,
    TraderModelConfig,
} from './trackedTraders';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

let userModels: TraderModelConfig[] = [];

// Fast lookup: lowercase tracked address -> model config
const trackedAddresses = new Map<string, TraderModelConfig>();

// The activity/trades topic is a firehose of ALL Polymarket trades — there is
// no working server-side per-wallet filter (documented market_slug/event_slug
// filters are known-broken upstream), so every message is checked against
// trackedAddresses and discarded immediately if it doesn't match.
let client: RealTimeDataClient | null = null;
let isRunning = false;
let positionUpdateInterval: NodeJS.Timeout | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

// Visibility counters, logged periodically so a live-but-quiet connection
// is distinguishable from a stalled one.
let totalMessagesSeen = 0;
let matchedMessagesSeen = 0;
let statsLogInterval: NodeJS.Timeout | null = null;

/**
 * Format address for display (first 6 + last 4 characters)
 */
const formatAddress = (address: string): string => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const refreshUserModels = async (): Promise<void> => {
    const activeAddresses = await getActiveTraderAddresses();
    const currentAddresses = Array.from(trackedAddresses.keys());
    const { toAdd, toRemove } = diffTraderAddresses(currentAddresses, activeAddresses);

    if (toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const newModelsMap = buildTraderModelMap(toAdd);
    for (const addr of toRemove) {
        trackedAddresses.delete(addr);
    }
    for (const [addr, config] of newModelsMap) {
        trackedAddresses.set(addr, config);
    }
    userModels = Array.from(trackedAddresses.values());

    if (toAdd.length > 0) {
        Logger.info(
            `➕ Now tracking ${toAdd.length} new trader(s): ${toAdd.map(formatAddress).join(', ')}`
        );
    }
    if (toRemove.length > 0) {
        Logger.info(
            `➖ Stopped tracking ${toRemove.length} trader(s): ${toRemove.map(formatAddress).join(', ')}`
        );
    }
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
    Logger.dbConnection(
        userModels.map((m) => m.address),
        counts
    );

    // Show your own positions first
    try {
        const { positions: myPositions, usdcBalance } = await fetchMyPositionsAndBalance();

        if (myPositions.length > 0) {
            const stats = calculatePositionStats(myPositions);

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

    const positionCounts: number[] = [];
    const positionDetails: Array<Array<Record<string, unknown>>> = [];
    const profitabilities: number[] = [];

    for (const { UserPosition } of userModels) {
        const positions = await UserPosition.find().exec();
        positionCounts.push(positions.length);

        const stats = calculatePositionStats(positions.map((p) => p.toObject()) as any);
        profitabilities.push(stats.overallPnl);

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
    Logger.tradersPositions(
        userModels.map((m) => m.address),
        positionCounts,
        positionDetails,
        profitabilities
    );
};

/**
 * Process and save a new trade activity (shared shape with polling mode's
 * tradeMonitor.ts — same schema, same dedup-by-transactionHash behavior).
 */
const processNewTrade = async (
    activity: Record<string, unknown>,
    address: string,
    UserActivity: TraderModelConfig['UserActivity']
): Promise<void> => {
    const timestamp = typeof activity.timestamp === 'number' ? activity.timestamp : 0;
    if (timestamp < TOO_OLD_TIMESTAMP) {
        return;
    }

    const transactionHash = String(activity.transactionHash ?? '');
    const existingActivity = await UserActivity.findOne({ transactionHash }).exec();
    if (existingActivity) {
        return; // Already processed this trade
    }

    const newActivity = new UserActivity({
        proxyWallet: String(activity.proxyWallet ?? ''),
        timestamp,
        conditionId: String(activity.conditionId ?? ''),
        type: String(activity.type ?? 'TRADE'),
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
 * Update positions for a trader (position/P&L data is not part of the trade
 * stream, so this stays a periodic REST poll regardless of monitoring mode).
 */
const updateTraderPositions = async (
    address: string,
    UserPosition: TraderModelConfig['UserPosition']
): Promise<void> => {
    const { positions } = await fetchUserPositionsAndBalance(address);

    if (positions.length > 0) {
        for (const position of positions) {
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
 * Fetch and process trade data for a single trader via REST.
 * Used for the initial backfill and for reconnect catch-up.
 */
const fetchTradeDataForTrader = async ({
    address,
    UserActivity,
    UserPosition,
}: TraderModelConfig): Promise<void> => {
    try {
        const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
        const activities = (await fetchData(apiUrl)) as Array<Record<string, unknown>>;

        if (!Array.isArray(activities) || activities.length === 0) {
            return;
        }

        for (const activity of activities) {
            await processNewTrade(activity, address, UserActivity);
        }

        await updateTraderPositions(address, UserPosition);
    } catch (error) {
        Logger.error(`Error fetching data for ${formatAddress(address)}: ${formatError(error)}`);
    }
};

/**
 * Handle a single trade message from the activity/trades firehose.
 */
const handleTradeMessage = async (message: Message): Promise<void> => {
    if (message.topic !== 'activity' || message.type !== 'trades') {
        return;
    }

    totalMessagesSeen++;

    const trade = message.payload as Record<string, unknown>;
    const proxyWallet = String(trade.proxyWallet ?? '').toLowerCase();
    const userModel = trackedAddresses.get(proxyWallet);
    if (!userModel) {
        return; // Not one of our tracked traders — expected for the vast majority of messages
    }

    matchedMessagesSeen++;

    try {
        await processNewTrade(trade, userModel.address, userModel.UserActivity);
        // Position/P&L changes with every trade; refresh it for this trader now
        // rather than waiting for the periodic sweep.
        await updateTraderPositions(userModel.address, userModel.UserPosition);
    } catch (error) {
        Logger.error(
            `Error handling trade for ${formatAddress(userModel.address)}: ${formatError(error)}`
        );
    }
};

/**
 * Fetch initial historical trades for all traders and mark them processed,
 * matching polling mode's first-run behavior (don't replay history as new).
 */
const fetchInitialTrades = async (): Promise<void> => {
    Logger.info('Fetching initial trade history...');

    await Promise.all(userModels.map(fetchTradeDataForTrader));

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

    Logger.success('Initial trade history loaded');
};

/**
 * Start periodic position updates (every 5 minutes) — a safety-net sweep on
 * top of the per-trade refresh in handleTradeMessage, since positions also
 * move with market price alone, independent of trades.
 */
const startPositionUpdates = (): void => {
    positionUpdateInterval = setInterval(
        async () => {
            try {
                await Promise.all(
                    userModels.map(({ address, UserPosition }) =>
                        updateTraderPositions(address, UserPosition)
                    )
                );
            } catch (error) {
                Logger.error(`Error updating positions: ${formatError(error)}`);
            }
        },
        5 * 60 * 1000
    );
};

/**
 * Start periodic stats logging so a live-but-quiet connection is
 * distinguishable from a stalled one.
 */
const startStatsLogging = (): void => {
    statsLogInterval = setInterval(
        () => {
            Logger.info(
                `📊 WebSocket firehose: ${totalMessagesSeen} trades seen, ${matchedMessagesSeen} matched your tracked wallets`
            );
        },
        5 * 60 * 1000
    );
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
    if (statsLogInterval) {
        clearInterval(statsLogInterval);
        statsLogInterval = null;
    }
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    if (client) {
        client.disconnect();
        client = null;
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

    await seedFromEnvIfEmpty(USER_ADDRESSES);
    await refreshUserModels();
    refreshInterval = setInterval(() => {
        refreshUserModels().catch((error) => {
            Logger.error(`Error refreshing tracked traders: ${formatError(error)}`);
        });
    }, ENV.TRACKED_TRADERS_REFRESH_SECONDS * 1000);

    await init();
    Logger.success(`🚀 WebSocket monitoring ${userModels.length} trader(s) in real-time`);
    Logger.separator();

    // Backfill/mark historical trades as processed BEFORE opening the
    // subscription, so there's no gap between "process started" and
    // "subscription live" where a trade could be missed entirely.
    await fetchInitialTrades();
    Logger.success('Historical trades processed. Now monitoring for new trades only.\n');
    Logger.separator();

    let hasConnectedOnce = false;

    client = new RealTimeDataClient({
        autoReconnect: true,
        onConnect: (rtdc) => {
            Logger.success('✅ Connected to Polymarket real-time data stream');
            rtdc.subscribe({ subscriptions: [{ topic: 'activity', type: 'trades' }] });
            Logger.success('✅ Subscribed to activity/trades firehose');

            if (hasConnectedOnce) {
                // Reconnected after a drop — the firehose has no replay, so
                // anything that happened during the gap is otherwise lost.
                // Catch up via REST for all tracked traders.
                Logger.warning('Reconnected after a disconnect — running catch-up fetch...');
                Promise.all(userModels.map(fetchTradeDataForTrader)).catch((error) => {
                    Logger.error(`Reconnect catch-up fetch failed: ${formatError(error)}`);
                });
            }
            hasConnectedOnce = true;
        },
        onMessage: (_rtdc, message) => {
            handleTradeMessage(message).catch((error) => {
                Logger.error(`Error handling WebSocket message: ${formatError(error)}`);
            });
        },
        onStatusChange: (status) => {
            if (status === ConnectionStatus.DISCONNECTED) {
                Logger.warning('⚠️  WebSocket disconnected — auto-reconnect in progress...');
            }
        },
    });

    try {
        client.connect();
    } catch (error) {
        const errorMsg = formatError(error);
        Logger.error(`Failed to connect to WebSocket: ${errorMsg}`);
        await TelegramNotifier.notifyError({
            title: 'WebSocket Connection Failed',
            message: errorMsg,
            severity: 'critical',
        });
        throw error;
    }

    startPositionUpdates();
    startStatsLogging();

    // Keep monitor running
    while (isRunning) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    Logger.info('WebSocket trade monitor stopped');
};

export default websocketTradeMonitor;
