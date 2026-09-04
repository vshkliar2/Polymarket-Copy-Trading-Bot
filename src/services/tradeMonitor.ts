import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import {
    calculatePositionStats,
    fetchMyPositionsAndBalance,
    fetchUserPositionsAndBalance,
} from '../utils/positionHelpers';
import { formatError } from '../utils/errorHelpers';
import {
    diffTraderAddresses,
    getActiveTraderAddresses,
    buildTraderModelMap,
    TraderModelConfig,
} from './trackedTraders';
import { emitNewTrade } from './tradeEvents';
import { getMyPositionModel } from '../models/myPosition';

const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

let userModels: TraderModelConfig[] = [];

/**
 * Format address for display (first 6 + last 4 characters)
 */
const formatAddress = (address: string): string => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const refreshUserModels = async (): Promise<void> => {
    const activeAddresses = await getActiveTraderAddresses();
    const currentAddresses = userModels.map((m) => m.address);
    const { toAdd, toRemove } = diffTraderAddresses(currentAddresses, activeAddresses);

    if (toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const newModelsMap = buildTraderModelMap(toAdd);
    const keptModels = userModels.filter((m) => !toRemove.includes(m.address));
    userModels = [...keptModels, ...Array.from(newModelsMap.values())];

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
    Logger.tradersPositions(
        userModels.map((m) => m.address),
        positionCounts,
        positionDetails,
        profitabilities
    );
};

/**
 * Process and save a new trade activity
 */
const processNewTrade = async (
    activity: Record<string, unknown>,
    address: string,
    UserActivity: TraderModelConfig['UserActivity']
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
    emitNewTrade({ id: String(newActivity._id), userAddress: address, detectedAt: Date.now() });
};

/**
 * Update positions for a trader
 */
const updateTraderPositions = async (
    address: string,
    UserPosition: TraderModelConfig['UserPosition']
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

// A self-tracked fill is authoritative for this long after it happens —
// the live /positions API is an indexer that lags real on-chain
// settlement by a few seconds, so reconciling too soon after our own
// fill risks overwriting or deleting fresh, correct data with stale
// data the API hasn't caught up to yet. 60s is comfortably larger than
// realistic indexer lag while still bounding drift from the CLI scripts
// this reconciliation exists to catch (those are human-invoked, minutes
// to hours apart — a 60s exemption window costs essentially nothing
// against that threat model).
const RECONCILIATION_GRACE_MS = 60_000;

/**
 * Re-syncs my_positions against the live API on every tick of the main
 * monitor loop (same FETCH_INTERVAL cadence updateTraderPositions already
 * uses for trader collections). postOrder.ts keeps my_positions accurate
 * for the bot's own BUY/SELL fills already, so in the common case this is
 * a no-op confirmation; it exists to bound drift from the CLI scripts
 * (manualSell.ts, sellLargePositions.ts, closeStalePositions.ts,
 * closeResolvedPositions.ts, redeemResolvedPositions.ts) that can change
 * our on-chain position outside postOrder.ts's control, without requiring
 * each of those scripts to know about my_positions individually.
 *
 * Unlike updateTraderPositions (upsert-only), this also DELETES any
 * my_positions doc whose conditionId the live API no longer reports at
 * all — the only signal available that a position was fully closed by one
 * of those out-of-band scripts.
 *
 * Grace window: the live /positions API is an indexer that lags real
 * on-chain settlement by a few seconds. Without an exemption, a
 * reconciliation tick firing within that lag window right after
 * postOrder.ts's own recordBuyFill/recordSellFill writes could
 * overwrite fresh, correct my_positions data with stale data the API
 * hasn't caught up to yet — or, worse, if the fill created a brand-new
 * position the API hasn't indexed at all yet, the deleteMany below would
 * delete that doc outright (its conditionId is absent from
 * liveConditionIds). On the SELL side that is not self-healing:
 * tradeExecutor.ts's postSellOrder bails out with `if (!myPosition)` and
 * marks the trade bot:true with no retry, permanently skipping it. So any
 * doc whose `lastFillAt` is within RECONCILIATION_GRACE_MS of now is left
 * untouched by both the upsert loop and the deleteMany — the self-tracked
 * write remains authoritative until the grace window elapses, at which
 * point normal reconciliation resumes for that conditionId.
 */
export const reconcileMyPositions = async (): Promise<void> => {
    const { positions } = await fetchMyPositionsAndBalance();
    const MyPosition = getMyPositionModel();

    const now = Date.now();
    const existingDocs = await MyPosition.find({}, { conditionId: 1, lastFillAt: 1 }).lean().exec();
    const recentlyFilledConditionIds = new Set(
        existingDocs
            .filter(
                (doc) =>
                    typeof doc.lastFillAt === 'number' &&
                    now - doc.lastFillAt < RECONCILIATION_GRACE_MS
            )
            .map((doc) => doc.conditionId)
    );

    const liveConditionIds = positions.map((p) => p.conditionId).filter(Boolean);

    if (positions.length > 0) {
        for (const position of positions) {
            if (recentlyFilledConditionIds.has(position.conditionId)) {
                // A confirmed fill for this conditionId happened within the
                // grace window — leave the self-tracked doc as the
                // authority rather than overwriting it with data the live
                // API's indexer may not have caught up on yet.
                continue;
            }
            await MyPosition.findOneAndUpdate(
                { conditionId: position.conditionId },
                {
                    $set: {
                        conditionId: position.conditionId,
                        asset: position.asset,
                        size: position.size,
                        avgPrice: position.avgPrice,
                        totalBought: position.totalBought,
                    },
                },
                { upsert: true }
            );
        }
    }

    // Exclude both: conditionIds the live API currently reports, AND
    // conditionIds with a recent self-tracked fill (even if the live API's
    // response omits them entirely, e.g. a brand-new position it hasn't
    // indexed yet) — deleting the latter would wipe out a fresh, real
    // position based only on indexer lag.
    const excludedFromDeletion = Array.from(
        new Set([...liveConditionIds, ...recentlyFilledConditionIds])
    );
    await MyPosition.deleteMany({ conditionId: { $nin: excludedFromDeletion } });
};

/**
 * Fetch and process trade data for a single trader
 */
const fetchTradeDataForTrader = async ({
    address,
    UserActivity,
    UserPosition,
}: TraderModelConfig): Promise<void> => {
    try {
        // Fetch trade activities from Polymarket API
        const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
        const activities = (await fetchData(apiUrl)) as Array<Record<string, unknown>>;

        if (!Array.isArray(activities) || activities.length === 0) {
            return;
        }

        // Process each activity
        for (const activity of activities) {
            await processNewTrade(activity, address, UserActivity);
        }

        // Update positions
        await updateTraderPositions(address, UserPosition);
    } catch (error) {
        Logger.error(`Error fetching data for ${formatAddress(address)}: ${formatError(error)}`);
    }
};

/**
 * Fetch and process trade data for all monitored traders in parallel.
 * Traders write to separate MongoDB collections, so there is no write
 * contention between them; each trader's fetch is independently wrapped
 * in try/catch so one trader's failure never blocks the others.
 */
const fetchTradeData = async (): Promise<void> => {
    await Promise.all(userModels.map(fetchTradeDataForTrader));
};

// Track if this is the first run
let isFirstRun = true;
// Track if monitor should continue running
let isRunning = true;
let refreshInterval: NodeJS.Timeout | null = null;

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = (): void => {
    isRunning = false;
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    Logger.info('Trade monitor shutdown requested...');
};

/**
 * Main trade monitoring function
 * Monitors traders for new trades and updates positions
 */
const tradeMonitor = async (): Promise<void> => {
    // Note: tracked_traders seeding happens once at startup in src/index.ts,
    // before either the monitor or the executor starts, so both services see a
    // consistent, already-seeded collection.
    await refreshUserModels();
    refreshInterval = setInterval(() => {
        refreshUserModels().catch((error) => {
            Logger.error(`Error refreshing tracked traders: ${formatError(error)}`);
        });
    }, ENV.TRACKED_TRADERS_REFRESH_SECONDS * 1000);

    await init();
    Logger.success(`Monitoring ${userModels.length} trader(s) every ${FETCH_INTERVAL}s`);
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
        try {
            await reconcileMyPositions();
        } catch (error) {
            Logger.error(`Error reconciling my_positions: ${formatError(error)}`);
        }
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
