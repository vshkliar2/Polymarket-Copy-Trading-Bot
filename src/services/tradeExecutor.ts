import { UserActivityInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';
import {
    fetchMyPositionsAndBalance,
    fetchUserPositionsAndBalance,
    findPositionByConditionId,
} from '../utils/positionHelpers';
import { diffTraderAddresses, getActiveTraderAddresses } from './trackedTraders';
import { onNewTrade, NewTradePayload } from './tradeEvents';
import { formatError } from '../utils/errorHelpers';
import type createClobClient from '../utils/createClobClient';

/**
 * The authenticated client returned by createClobClient(). Defined
 * independently from the identical alias in postOrder.ts (not exported
 * there) — deriving from createClobClient's own return type keeps both in
 * sync with its signature without either file importing from the other.
 */
type SecureClientType = Awaited<ReturnType<typeof createClobClient>>;

// Safety-net poll interval: catches anything an event might have missed
// (a crash between save() and emit, a trade inserted outside the normal
// monitor path) and drives the trade-aggregation window check, which needs
// to fire on elapsed time even when no new trade has arrived. Far slower
// than event-driven execution needs, since it's a backstop, not the
// primary trigger.
const SAFETY_NET_POLL_MS = 5000;

const TRADE_AGGREGATION_ENABLED = ENV.TRADE_AGGREGATION_ENABLED;
const TRADE_AGGREGATION_WINDOW_SECONDS = ENV.TRADE_AGGREGATION_WINDOW_SECONDS;
const TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0; // Polymarket minimum

/**
 * User activity model configuration
 */
interface UserActivityModelConfig {
    address: string;
    model: ReturnType<typeof getUserActivityModel>;
}

let userActivityModels: UserActivityModelConfig[] = [];

const refreshUserActivityModels = async (): Promise<void> => {
    const activeAddresses = await getActiveTraderAddresses();
    const currentAddresses = userActivityModels.map((m) => m.address);
    const { toAdd, toRemove } = diffTraderAddresses(currentAddresses, activeAddresses);

    if (toAdd.length === 0 && toRemove.length === 0) {
        return;
    }

    const kept = userActivityModels.filter((m) => !toRemove.includes(m.address));
    const added = toAdd.map((address) => ({ address, model: getUserActivityModel(address) }));
    userActivityModels = [...kept, ...added];
};

interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
    /** When this trade was first detected/saved by a monitor. Falls back to
     * fetch time for trades picked up by the safety-net sweep, which has no
     * visibility into the original detection moment. Used only for the
     * processing-latency log in executeSingleTrade. */
    detectedAt: number;
}

interface AggregatedTrade {
    userAddress: string;
    conditionId: string;
    asset: string;
    side: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    totalUsdcSize: number;
    averagePrice: number;
    firstTradeTime: number;
    lastTradeTime: number;
}

// Buffer for aggregating trades
const tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();

const readTempTrades = async (): Promise<TradeWithUser[]> => {
    // Query all traders' collections in parallel — they are independent
    // MongoDB collections, so there is no contention between these reads.
    const perTraderTrades = await Promise.all(
        userActivityModels.map(async ({ address, model }) => {
            // Only get trades that haven't been processed yet (bot: false AND botExcutedTime: 0)
            // This prevents processing the same trade multiple times
            const trades = await model
                .find({
                    $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
                })
                .exec();

            return trades.map((trade) => ({
                ...(trade.toObject() as UserActivityInterface),
                userAddress: address,
                // The safety-net sweep has no record of when the monitor
                // originally detected this trade, so it stamps "now" —
                // this undercounts latency for these trades, but keeps the
                // field meaningful for the (much more common) event-driven
                // path in fetchTradeById below.
                detectedAt: Date.now(),
            }));
        })
    );

    return perTraderTrades.flat();
};

/**
 * Fetch a single trade by id, scoped to the trader's own collection, per
 * the {id, userAddress} payload a 'newTrade' event carries. Still filters
 * on bot:false/botExcutedTime:0 so a trade already picked up by a prior
 * safety-net sweep (or already executed) isn't processed twice.
 */
const fetchTradeById = async ({
    id,
    userAddress,
    detectedAt,
}: NewTradePayload): Promise<TradeWithUser | null> => {
    const modelConfig = userActivityModels.find((m) => m.address === userAddress);
    if (!modelConfig) {
        // Trader was removed from tracked_traders between the monitor's
        // write and this event firing — nothing to do.
        return null;
    }

    const trade = await modelConfig.model
        .findOne({
            _id: id,
            type: 'TRADE',
            bot: false,
            botExcutedTime: 0,
        })
        .exec();

    if (!trade) {
        return null;
    }

    return {
        ...(trade.toObject() as UserActivityInterface),
        userAddress,
        detectedAt,
    };
};

/**
 * Generate a unique key for trade aggregation based on user, market, side
 */
const getAggregationKey = (trade: TradeWithUser): string => {
    return `${trade.userAddress}:${trade.conditionId}:${trade.asset}:${trade.side}`;
};

/**
 * Add trade to aggregation buffer or update existing aggregation
 */
const addToAggregationBuffer = (trade: TradeWithUser): void => {
    const key = getAggregationKey(trade);
    const existing = tradeAggregationBuffer.get(key);
    const now = Date.now();

    if (existing) {
        // Update existing aggregation
        existing.trades.push(trade);
        existing.totalUsdcSize += trade.usdcSize;
        // Recalculate weighted average price
        const totalValue = existing.trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
        existing.averagePrice = totalValue / existing.totalUsdcSize;
        existing.lastTradeTime = now;
    } else {
        // Create new aggregation
        tradeAggregationBuffer.set(key, {
            userAddress: trade.userAddress,
            conditionId: trade.conditionId,
            asset: trade.asset,
            side: trade.side || 'BUY',
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            trades: [trade],
            totalUsdcSize: trade.usdcSize,
            averagePrice: trade.price,
            firstTradeTime: now,
            lastTradeTime: now,
        });
    }
};

/**
 * Check buffer and return ready aggregated trades
 * Trades are ready if:
 * 1. Total size >= minimum AND
 * 2. Time window has passed since first trade
 */
const getReadyAggregatedTrades = (): AggregatedTrade[] => {
    const ready: AggregatedTrade[] = [];
    const now = Date.now();
    const windowMs = TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

    for (const [key, agg] of tradeAggregationBuffer.entries()) {
        const timeElapsed = now - agg.firstTradeTime;

        // Check if aggregation is ready
        if (timeElapsed >= windowMs) {
            if (agg.totalUsdcSize >= TRADE_AGGREGATION_MIN_TOTAL_USD) {
                // Aggregation meets minimum and window passed - ready to execute
                ready.push(agg);
            } else {
                // Window passed but total too small - mark individual trades as skipped
                Logger.info(
                    `Trade aggregation for ${agg.userAddress} on ${agg.slug || agg.asset}: $${agg.totalUsdcSize.toFixed(2)} total from ${agg.trades.length} trades below minimum ($${TRADE_AGGREGATION_MIN_TOTAL_USD}) - skipping`
                );

                // Mark all trades in this aggregation as processed (bot: true)
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                }
            }
            // Remove from buffer either way
            tradeAggregationBuffer.delete(key);
        }
    }

    return ready;
};

/**
 * Prepare trade execution data (positions and balances)
 */
const prepareTradeData = async (trade: TradeWithUser) => {
    const [myData, userData] = await Promise.all([
        fetchMyPositionsAndBalance(),
        fetchUserPositionsAndBalance(trade.userAddress),
    ]);

    const myPosition = findPositionByConditionId(myData.positions, trade.conditionId);
    const userPosition = findPositionByConditionId(userData.positions, trade.conditionId);

    return {
        myPosition,
        userPosition,
        myBalance: myData.usdcBalance, // Use USDC balance only (available for trading)
        userBalance: userData.balance,
    };
};

/**
 * Atomically claim a trade before committing it to a processing path
 * (buffering for aggregation, or immediate execution). Both the
 * event-driven fast path and the safety-net sweep can observe the same
 * bot:false/botExcutedTime:0 document concurrently; only the caller whose
 * findOneAndUpdate actually matches wins the claim. Returns true if this
 * call claimed the trade, false if something else already did.
 */
const claimTrade = async (trade: TradeWithUser): Promise<boolean> => {
    const UserActivity = getUserActivityModel(trade.userAddress);
    const claimed = await UserActivity.findOneAndUpdate(
        { _id: trade._id, bot: false, botExcutedTime: 0 },
        { $set: { botExcutedTime: 1 } }
    ).exec();
    return claimed !== null;
};

/**
 * Execute a single trade
 */
const executeSingleTrade = async (
    clobClient: SecureClientType,
    trade: TradeWithUser
): Promise<void> => {
    // With both an event-driven path and a safety-net sweep able to observe
    // the same trade concurrently, claim it atomically first — only the
    // caller that wins the claim proceeds, avoiding double-execution.
    if (!(await claimTrade(trade))) {
        return;
    }

    const claimedAt = Date.now();
    Logger.info(`⏱️  Pickup latency: ${claimedAt - trade.detectedAt}ms since detection`);

    Logger.trade(trade.userAddress, trade.side ?? 'UNKNOWN', {
        asset: trade.asset,
        side: trade.side,
        amount: trade.usdcSize,
        price: trade.price,
        slug: trade.slug,
        eventSlug: trade.eventSlug,
        transactionHash: trade.transactionHash,
    });

    const { myPosition, userPosition, myBalance, userBalance } = await prepareTradeData(trade);

    Logger.balance(myBalance, userBalance, trade.userAddress);

    // Execute the trade
    const condition = trade.side === 'BUY' ? 'buy' : 'sell';
    try {
        await postOrder(
            clobClient,
            condition,
            myPosition,
            userPosition,
            trade,
            myBalance,
            userBalance,
            trade.userAddress
        );
    } catch (error) {
        // postOrder's submitOrder() calls client.placeMarketOrder(), which can
        // THROW typed errors (InsufficientLiquidityError, RateLimitError,
        // TransportError, SigningError, etc.) rather than only returning a
        // rejection object. claimTrade() above already set botExcutedTime: 1
        // to atomically claim this trade; if we let the throw propagate
        // uncaught, that claim is never followed by any further status
        // update, so the trade would be stuck at botExcutedTime: 1 forever —
        // neither the safety-net sweep nor a future event re-picks up
        // anything but botExcutedTime: 0. Reset to 0 (not 999, which means
        // "historical/skipped forever") so a transient failure gets retried
        // instead of permanently stranding the trade, and swallow the error
        // here so one failing trade doesn't abort the rest of the batch loop
        // in doTrading/processTradeBatch.
        //
        // Guard the reset with botExcutedTime: 1 (the exact state our own
        // claimTrade() put this trade in) rather than an unconditional
        // update by _id alone: removeTrader() (trackedTraders.ts) drains a
        // trader's remaining trades via updateMany({bot: false}, {bot: true,
        // botExcutedTime: 999}) — and a claimed-but-not-yet-executed trade
        // still has bot: false (claimTrade only ever touches botExcutedTime),
        // so it matches that drain's filter. If a removeTrader drain lands
        // between this throw and this reset, an unconditional update would
        // stomp its {bot: true, botExcutedTime: 999} back down to
        // botExcutedTime: 0, producing an inconsistent record. Scoping the
        // filter to botExcutedTime: 1 means the reset only fires if nothing
        // else already moved this trade out of the state this call frame
        // itself put it in — the same "only transition state this call
        // frame owns" property claimTrade()'s findOneAndUpdate relies on.
        Logger.error(`Error executing trade for ${trade.userAddress}: ${formatError(error)}`);
        const UserActivity = getUserActivityModel(trade.userAddress);
        await UserActivity.updateOne(
            { _id: trade._id, botExcutedTime: 1 },
            { $set: { botExcutedTime: 0 } }
        );
        return;
    }

    Logger.info(`⏱️  Total processing time: ${Date.now() - trade.detectedAt}ms since detection`);
    Logger.separator();
};

/**
 * Execute multiple trades
 */
const doTrading = async (clobClient: SecureClientType, trades: TradeWithUser[]): Promise<void> => {
    for (const trade of trades) {
        await executeSingleTrade(clobClient, trade);
    }
};

/**
 * Execute aggregated trades
 */
const doAggregatedTrading = async (
    clobClient: SecureClientType,
    aggregatedTrades: AggregatedTrade[]
): Promise<void> => {
    for (const agg of aggregatedTrades) {
        Logger.header(`📊 AGGREGATED TRADE (${agg.trades.length} trades combined)`);
        Logger.info(`Market: ${agg.slug ?? agg.asset}`);
        Logger.info(`Side: ${agg.side}`);
        Logger.info(`Total volume: $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`Average price: $${agg.averagePrice.toFixed(4)}`);

        // Mark all individual trades as being processed
        for (const trade of agg.trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        if (agg.trades.length === 0) {
            Logger.warning('Aggregated trade has no trades, skipping');
            return;
        }

        const { myPosition, userPosition, myBalance, userBalance } = await prepareTradeData(
            agg.trades[0]!
        );

        Logger.balance(myBalance, userBalance, agg.userAddress);

        // Create a synthetic trade object for postOrder using aggregated values
        const firstTrade = agg.trades[0]!;
        const syntheticTrade: UserActivityInterface = {
            ...firstTrade, // Use first trade as template
            usdcSize: agg.totalUsdcSize,
            price: agg.averagePrice,
            side: agg.side as 'BUY' | 'SELL',
        };

        // Execute the aggregated trade
        const condition = agg.side === 'BUY' ? 'buy' : 'sell';
        try {
            await postOrder(
                clobClient,
                condition,
                myPosition,
                userPosition,
                syntheticTrade,
                myBalance,
                userBalance,
                agg.userAddress
            );
        } catch (error) {
            // Same throw-safety gap as executeSingleTrade: postOrder's
            // submitOrder() can throw (InsufficientLiquidityError,
            // RateLimitError, TransportError, SigningError, etc.) instead of
            // only returning a rejection object. All trades in this
            // aggregation were already claimed (botExcutedTime: 1) above; if
            // the throw propagated uncaught here, every one of them would be
            // stuck at botExcutedTime: 1 forever. Reset them all back to 0
            // (not 999 — that means "historical/skipped forever") so the
            // safety-net sweep or a future event can retry the whole group,
            // and continue the aggregatedTrades loop instead of aborting it.
            //
            // Guard each reset with botExcutedTime: 1 (the exact state the
            // claim loop above put each trade in), not an unconditional
            // update by _id alone — see executeSingleTrade's catch block for
            // the full reasoning: removeTrader() (trackedTraders.ts) can
            // drain a claimed-but-not-yet-executed trade (still bot: false)
            // via updateMany({bot: false}, {bot: true, botExcutedTime: 999})
            // concurrently with this catch running. Scoping to
            // botExcutedTime: 1 ensures this reset only fires for trades
            // still in the state this call frame's own claim loop put them
            // in, so it can't stomp a newer state written by something else.
            Logger.error(
                `Error executing aggregated trade for ${agg.userAddress}: ${formatError(error)}`
            );
            for (const trade of agg.trades) {
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne(
                    { _id: trade._id, botExcutedTime: 1 },
                    { $set: { botExcutedTime: 0 } }
                );
            }
            continue;
        }

        Logger.separator();
    }
};

// Track if executor should continue running
let isRunning = true;
let executorRefreshInterval: NodeJS.Timeout | null = null;
let safetyNetInterval: NodeJS.Timeout | null = null;
let idleLogInterval: NodeJS.Timeout | null = null;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = (): void => {
    isRunning = false;
    if (executorRefreshInterval) {
        clearInterval(executorRefreshInterval);
        executorRefreshInterval = null;
    }
    if (safetyNetInterval) {
        clearInterval(safetyNetInterval);
        safetyNetInterval = null;
    }
    if (idleLogInterval) {
        clearInterval(idleLogInterval);
        idleLogInterval = null;
    }
    Logger.info('Trade executor shutdown requested...');
};

/**
 * Process a batch of already-fetched trades through the existing
 * aggregation/immediate-execution branching. Shared by both the
 * event-driven single-trade path and the safety-net sweep, so the
 * execution logic itself doesn't change based on how a trade was found.
 */
const processTradeBatch = async (
    clobClient: SecureClientType,
    trades: TradeWithUser[]
): Promise<void> => {
    if (TRADE_AGGREGATION_ENABLED) {
        if (trades.length > 0) {
            Logger.clearLine();
            Logger.info(`📥 ${trades.length} new trade${trades.length > 1 ? 's' : ''} detected`);

            for (const trade of trades) {
                // Only aggregate BUY trades below minimum threshold
                if (trade.side === 'BUY' && trade.usdcSize < TRADE_AGGREGATION_MIN_TOTAL_USD) {
                    // Claim before buffering: the buffer is in-process
                    // state, not itself a guard against the same trade
                    // being fetched and buffered twice by concurrent
                    // triggers (an event + the safety-net sweep).
                    if (!(await claimTrade(trade))) {
                        continue;
                    }
                    Logger.info(
                        `Adding $${trade.usdcSize.toFixed(2)} ${trade.side} trade to aggregation buffer for ${trade.slug ?? trade.asset}`
                    );
                    addToAggregationBuffer(trade);
                } else {
                    // Execute large trades immediately (not aggregated)
                    Logger.clearLine();
                    Logger.header(`⚡ IMMEDIATE TRADE (above threshold)`);
                    await doTrading(clobClient, [trade]);
                }
            }
        }

        // Check for ready aggregated trades — must happen even when no new
        // trade arrived, since a buffered group's time window can expire
        // on its own. This is why the safety-net interval exists.
        const readyAggregations = getReadyAggregatedTrades();
        if (readyAggregations.length > 0) {
            Logger.clearLine();
            Logger.header(
                `⚡ ${readyAggregations.length} AGGREGATED TRADE${readyAggregations.length > 1 ? 'S' : ''} READY`
            );
            await doAggregatedTrading(clobClient, readyAggregations);
        }
    } else if (trades.length > 0) {
        // Original non-aggregation logic
        Logger.clearLine();
        Logger.header(`⚡ ${trades.length} NEW TRADE${trades.length > 1 ? 'S' : ''} TO COPY`);
        await doTrading(clobClient, trades);
    }
};

/**
 * Main trade executor function
 * Processes trades and executes them based on configuration
 */
const tradeExecutor = async (clobClient: SecureClientType): Promise<void> => {
    await refreshUserActivityModels();
    executorRefreshInterval = setInterval(() => {
        refreshUserActivityModels().catch((error) => {
            Logger.error(
                `Error refreshing tracked traders: ${error instanceof Error ? error.message : String(error)}`
            );
        });
    }, ENV.TRACKED_TRADERS_REFRESH_SECONDS * 1000);

    Logger.success(`Trade executor ready for ${userActivityModels.length} trader(s)`);
    if (TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `Trade aggregation enabled: ${TRADE_AGGREGATION_WINDOW_SECONDS}s window, $${TRADE_AGGREGATION_MIN_TOTAL_USD} minimum`
        );
    }

    // Fast path: a monitor emits 'newTrade' the instant it writes a trade to
    // Mongo. React immediately with a targeted single-document fetch instead
    // of waiting for the next safety-net sweep.
    onNewTrade((payload) => {
        if (!isRunning) return;
        fetchTradeById(payload)
            .then(async (trade) => {
                if (trade) {
                    await processTradeBatch(clobClient, [trade]);
                }
            })
            .catch((error) => {
                Logger.error(`Error processing new-trade event: ${formatError(error)}`);
            });
    });

    // Safety net: catches anything an event might have missed (a crash
    // between save() and emit, a trade inserted outside the normal monitor
    // path) and drives the aggregation-window-expiry check, which needs to
    // fire on elapsed time even with zero new trades. Far slower than
    // event-driven execution needs, since it's a backstop, not the primary
    // trigger.
    safetyNetInterval = setInterval(() => {
        readTempTrades()
            .then((trades) => processTradeBatch(clobClient, trades))
            .catch((error) => {
                Logger.error(`Error in safety-net sweep: ${formatError(error)}`);
            });
    }, SAFETY_NET_POLL_MS);

    // Idle heartbeat: a real, newline-terminated log line (not the old
    // \r-based spinner, which renders as garbled control characters in
    // file-based logs like PM2's) so an operator watching logs can tell the
    // executor is alive during quiet periods, without spamming every tick.
    idleLogInterval = setInterval(() => {
        const bufferedCount = tradeAggregationBuffer.size;
        Logger.info(
            bufferedCount > 0
                ? `Waiting for trades from ${userActivityModels.length} trader(s)... (${bufferedCount} trade group(s) pending)`
                : `Waiting for trades from ${userActivityModels.length} trader(s)...`
        );
    }, 60_000);
};

export default tradeExecutor;
