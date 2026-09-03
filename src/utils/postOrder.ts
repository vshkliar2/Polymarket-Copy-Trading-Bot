import { OrderSide, OrderType, RequestRejectedError } from '@polymarket/client';
import { OrderPostStatus, OrderResponseErrorCode } from '@polymarket/bindings/clob';
import type { AcceptedOrderResponse, OrderResponse } from '@polymarket/bindings/clob';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';
import { isInsufficientBalanceOrAllowanceCode } from './errorHelpers';
import TelegramNotifier from '../services/telegramNotifier';
import { checkMarketPositionLimit, checkMarketEndDate } from './portfolioManager';
import type createClobClient from './createClobClient';

/**
 * The authenticated client returned by createClobClient(). @polymarket/client's
 * SecureClient is a large structural type with ~60 action-bound methods whose
 * generic parameters are inferred, not meant to be written by hand — deriving
 * the alias from createClobClient's own return type keeps it in sync.
 */
type SecureClientType = Awaited<ReturnType<typeof createClobClient>>;

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;
const DRY_RUN = ENV.DRY_RUN;

/**
 * Maps a thrown RequestRejectedError's message text to the matching
 * OrderResponseErrorCode. @polymarket/bindings' own error-code mapping
 * (which the SDK uses when a rejection comes back as a normal HTTP 200
 * response body) keys off this exact message text, so this mirrors that
 * mapping for the case where the SAME rejection reason instead arrives via
 * a thrown error (see the comment on placeMarketOrderNormalizingRejection
 * below for why both paths exist). Order matters: checked top-to-bottom,
 * first match wins — the insufficient-balance case is a substring match
 * (mirroring the SDK's own `.includes(...)` check) so it must not be
 * shadowed by a later exact-match entry.
 */
interface RejectedMessageMapping {
    test: (message: string) => boolean;
    code: OrderResponseErrorCode;
}

const REQUEST_REJECTED_MESSAGE_TO_CODE: RejectedMessageMapping[] = [
    {
        test: (m) => m.includes('not enough balance / allowance'),
        code: OrderResponseErrorCode.INSUFFICIENT_BALANCE_OR_ALLOWANCE,
    },
    {
        test: (m) => m === "order couldn't be fully filled. FOK orders are fully filled or killed.",
        code: OrderResponseErrorCode.FOK_NOT_FILLED,
    },
    {
        test: (m) =>
            m ===
            'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
        code: OrderResponseErrorCode.FAK_NOT_FILLED,
    },
    {
        test: (m) => m === 'the market is not yet ready to process new orders',
        code: OrderResponseErrorCode.MARKET_NOT_READY,
    },
    { test: (m) => m === 'invalid nonce', code: OrderResponseErrorCode.INVALID_NONCE },
    { test: (m) => m === 'invalid expiration', code: OrderResponseErrorCode.INVALID_EXPIRATION },
    {
        test: (m) => m === 'invalid post-only order: order crosses book',
        code: OrderResponseErrorCode.POST_ONLY_WOULD_CROSS,
    },
    {
        test: (m) => m === 'post-only mode: only post-only orders and cancels are allowed',
        code: OrderResponseErrorCode.POST_ONLY_MODE,
    },
];

const codeForRejectedRequestMessage = (message: string): OrderResponseErrorCode => {
    const match = REQUEST_REJECTED_MESSAGE_TO_CODE.find(({ test }) => test(message));
    return match?.code ?? OrderResponseErrorCode.UNKNOWN;
};

/**
 * Calls client.placeMarketOrder(), normalizing a thrown RequestRejectedError
 * into the same RejectedOrderResponse shape (`{ok: false, code, message}`)
 * the SDK returns for other rejection reasons.
 *
 * Confirmed live (not just from reading the SDK's types): a FOK order that
 * cannot be fully filled comes back as a THROWN RequestRejectedError, not an
 * `{ok: false}` response — even though @polymarket/bindings' own response
 * parser has code that maps this exact rejection message to
 * OrderResponseErrorCode.FOK_NOT_FILLED for the `{ok:false}` path. Without
 * this normalization, executeSingleTrade's outer catch treated every
 * FOK-not-filled rejection as an unretryable error on the FIRST order-book
 * snapshot, aborting the trade instead of retrying against a fresh order
 * book like every other rejection reason already does.
 *
 * Every other thrown error type (RateLimitError, TransportError,
 * SigningError, UnexpectedResponseError, UserInputError) is intentionally
 * left to propagate — those aren't retryable within this loop and are
 * already handled by tradeExecutor.ts's outer catch (resets botExcutedTime
 * to 0 so a transient failure gets retried on the next event/sweep, per the
 * comment there).
 */
const placeMarketOrderNormalizingRejection = async (
    client: SecureClientType,
    request: Parameters<SecureClientType['placeMarketOrder']>[0]
): Promise<OrderResponse> => {
    try {
        return await client.placeMarketOrder(request);
    } catch (error) {
        if (error instanceof RequestRejectedError) {
            // error.code (when the server sends one) is an arbitrary string,
            // not guaranteed to be a member of OrderResponseErrorCode — an
            // unchecked cast risks silently producing a wrong-but-valid-looking
            // enum value. The message-based mapping below is built directly
            // from @polymarket/bindings' own internal mapping (see the comment
            // on REQUEST_REJECTED_MESSAGE_TO_CODE), so it's the more reliable
            // source of truth here.
            const code = codeForRejectedRequestMessage(error.message);
            return { ok: false, code, message: error.message };
        }
        throw error;
    }
};

/**
 * Submits an order via the CLOB client, unless DRY_RUN is enabled.
 * In dry-run mode, logs the order that would be submitted and returns a
 * synthetic success response so downstream bookkeeping (position tracking,
 * botExcutedTime, Telegram notifications) still runs against realistic data,
 * without placing any real order or spending real funds.
 *
 * The synthetic dry-run response is a real `AcceptedOrderResponse` (`ok: true`
 * plus every field of that type) so that all downstream handling — `resp.ok`,
 * `resp.transactionsHashes[0]` — behaves identically whether or not DRY_RUN is
 * on. The return type is pinned to `OrderResponse` so the compiler enforces
 * that: `AcceptedOrderResponse`'s string fields are branded (`OrderId`,
 * `DecimalString`, `TxHash`), so the placeholders need casts, but pinning the
 * type guarantees no field of the real response is missing from the fake one.
 *
 * `orderType: OrderType.FOK` is passed explicitly. @polymarket/client defaults
 * market orders to FAK (fill-and-kill / partial fills allowed), but the retry
 * loops below decrement `remaining` by the FULL requested amount on any
 * `ok: true` response, which is only sound under fill-or-kill semantics. This
 * also preserves the exact behaviour of the previous clob-client-v2 call,
 * `postOrder(signedOrder, OrderType.FOK)`.
 */
const submitOrder = async (
    client: SecureClientType,
    orderArgs: { side: OrderSide; tokenID: string; amount: number; price: number }
): Promise<OrderResponse> => {
    if (DRY_RUN) {
        Logger.info(
            `🧪 [DRY_RUN] Would submit ${orderArgs.side} order: $${orderArgs.amount.toFixed(2)} @ $${orderArgs.price} (token ${orderArgs.tokenID})`
        );
        const dryRunResponse: AcceptedOrderResponse = {
            ok: true,
            orderId: 'DRY_RUN_NO_ID' as AcceptedOrderResponse['orderId'],
            status: OrderPostStatus.MATCHED,
            makingAmount: String(orderArgs.amount) as AcceptedOrderResponse['makingAmount'],
            takingAmount: String(
                orderArgs.amount / orderArgs.price
            ) as AcceptedOrderResponse['takingAmount'],
            transactionsHashes: [
                'DRY_RUN_NO_TX' as AcceptedOrderResponse['transactionsHashes'][number],
            ],
            tradeIds: [],
        };
        return dryRunResponse;
    }

    if (orderArgs.side === OrderSide.BUY) {
        return placeMarketOrderNormalizingRejection(client, {
            tokenId: orderArgs.tokenID,
            side: OrderSide.BUY,
            amount: orderArgs.amount,
            // maxSpend === amount tells the SDK the requested amount should
            // INCLUDE taker fees, so it resizes the actual share quantity
            // down to fit the fee inside orderArgs.amount rather than
            // charging the fee on top of it. This is the actual root cause
            // of FOK-not-filled BUY failures under @polymarket/client:
            // orderArgs.price (maxPrice below) is set to the best ask price
            // itself, leaving zero headroom for any fee — a BUY order sized
            // at exactly the best ask, with no maxSpend, cannot fill even a
            // penny of taker fee within that price ceiling, so it is killed
            // by construction every single time, independent of real market
            // liquidity or retries. Confirmed against @polymarket/client's
            // own docs: "Desired USD notional to buy, before market and
            // builder taker fees... Set maxSpend equal to amount when the
            // requested amount should include fees." SELL orders have no
            // equivalent issue — they specify a token `shares` count, and
            // fees come out of USDC proceeds received, not out of the order
            // itself.
            maxSpend: orderArgs.amount,
            maxPrice: orderArgs.price,
            orderType: OrderType.FOK,
        });
    }

    // SELL orders take `shares` (token quantity), not a dollar `amount` —
    // orderArgs.amount is already a token count at every SELL call site in
    // this file, matching this distinction.
    return placeMarketOrderNormalizingRejection(client, {
        tokenId: orderArgs.tokenID,
        side: OrderSide.SELL,
        shares: orderArgs.amount,
        minPrice: orderArgs.price,
        orderType: OrderType.FOK,
    });
};

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = 1.0; // Minimum order size in tokens for SELL orders

/**
 * Copy a BUY trade. Sizing is driven entirely by the trader's `trade.usdcSize`
 * and our own `myBalance`/`myPosition` — the trader's own position/balance
 * play no part in a BUY decision, so this function doesn't take them.
 */
export const postBuyOrder = async (
    client: SecureClientType,
    myPosition: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    myBalance: number,
    userAddress: string
): Promise<void> => {
    const UserActivity = getUserActivityModel(userAddress);
    //Buy strategy
    Logger.info('Executing BUY strategy...');

    Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

    // Get current position size for position limit checks
    const currentPositionValue = myPosition ? myPosition.size * myPosition.avgPrice : 0;

    // Use new copy strategy system
    const orderCalc = calculateOrderSize(
        COPY_STRATEGY_CONFIG,
        trade.usdcSize,
        myBalance,
        currentPositionValue
    );

    // Log the calculation reasoning
    Logger.info(`📊 ${orderCalc.reasoning}`);

    // Check if order should be executed
    if (orderCalc.finalAmount === 0) {
        Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
        if (orderCalc.belowMinimum) {
            Logger.warning(`💡 Increase COPY_SIZE or wait for larger trades`);
        }
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    // Check Market end date filter
    const endDateCheck = checkMarketEndDate(trade.endDate);
    if (!endDateCheck.allowed) {
        Logger.warning(`⏰ ${endDateCheck.reason}`);
        await TelegramNotifier.notify(
            `⏰ <b>Trade Skipped - End Date</b>\n\n` +
                `Market: ${trade.slug || trade.title}\n` +
                `Trader: ${userAddress.substring(0, 10)}...\n` +
                `Reason: ${endDateCheck.reason}`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    if (endDateCheck.daysUntilEnd) {
        Logger.info(`⏰ Market ends in ${endDateCheck.daysUntilEnd.toFixed(1)} days`);
    }

    // Check Per-market position limit
    const positionLimitCheck = checkMarketPositionLimit(
        orderCalc.finalAmount,
        myBalance,
        myPosition
    );

    if (!positionLimitCheck.allowed) {
        Logger.warning(`💰 ${positionLimitCheck.reason}`);
        await TelegramNotifier.notify(
            `💰 <b>Trade Skipped - Position Limit</b>\n\n` +
                `Market: ${trade.slug || trade.title}\n` +
                `Trader: ${userAddress.substring(0, 10)}...\n` +
                `Trader Amount: $${trade.usdcSize.toFixed(2)}\n` +
                `Reason: ${positionLimitCheck.reason}`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    // Adjust order size if scaled down by position limit
    if (positionLimitCheck.adjustedAmount < orderCalc.finalAmount) {
        Logger.info(`💰 ${positionLimitCheck.reason}`);
        await TelegramNotifier.notify(
            `💰 <b>Order Size Adjusted</b>\n\n` +
                `Market: ${trade.slug || trade.title}\n` +
                `Original: $${orderCalc.finalAmount.toFixed(2)}\n` +
                `Adjusted: $${positionLimitCheck.adjustedAmount.toFixed(2)}\n` +
                `Reason: ${positionLimitCheck.reason}`
        );
        orderCalc.finalAmount = positionLimitCheck.adjustedAmount;
    }

    let remaining = orderCalc.finalAmount;

    let retry = 0;
    let abortDueToFunds = false;
    let totalBoughtTokens = 0; // Track total tokens bought for this trade

    while (remaining > 0 && retry < RETRY_LIMIT) {
        const orderBook = await client.fetchOrderBook({ assetId: trade.asset });
        if (!orderBook.asks || orderBook.asks.length === 0) {
            Logger.warning('No asks available in order book');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            break;
        }

        const minPriceAsk = orderBook.asks.reduce((min, ask) => {
            return parseFloat(ask.price) < parseFloat(min?.price ?? '999999') ? ask : min;
        }, orderBook.asks[0]);

        if (!minPriceAsk) {
            Logger.error('No asks available in order book');
            break;
        }

        Logger.info(`Best ask: ${minPriceAsk.size} @ $${minPriceAsk.price}`);
        if (parseFloat(minPriceAsk.price) - 0.05 > trade.price) {
            Logger.warning('Price slippage too high - skipping trade');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            break;
        }

        // Check if remaining amount is below minimum before creating order
        if (remaining < MIN_ORDER_SIZE_USD) {
            Logger.info(
                `Remaining amount ($${remaining.toFixed(2)}) below minimum - completing trade`
            );
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
            break;
        }

        const maxOrderSize = parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price);
        const orderSize = Math.min(remaining, maxOrderSize);

        const order_arges = {
            side: OrderSide.BUY,
            tokenID: trade.asset,
            amount: orderSize,
            price: parseFloat(minPriceAsk.price),
        };

        Logger.info(
            `Creating order: $${orderSize.toFixed(2)} @ $${minPriceAsk.price} (Balance: $${myBalance.toFixed(2)})`
        );
        const resp = await submitOrder(client, order_arges);
        if (resp.ok === true) {
            retry = 0;
            const tokensBought = order_arges.amount / order_arges.price;
            totalBoughtTokens += tokensBought;
            Logger.orderResult(
                true,
                `Bought $${order_arges.amount.toFixed(2)} at $${order_arges.price} (${tokensBought.toFixed(2)} tokens)`
            );

            // Send Telegram notification for successful trade
            TelegramNotifier.notifyTrade({
                market: trade.slug || trade.title || 'Unknown Market',
                side: 'BUY',
                amount: order_arges.amount,
                price: order_arges.price,
                traderAddress: userAddress,
                dryRun: DRY_RUN,
                success: true,
                traderAmount: trade.usdcSize,
                yourBalance: myBalance,
                transactionHash: resp.transactionsHashes[0] ?? undefined,
            }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
            });

            remaining -= order_arges.amount;
        } else {
            const errorMessage = resp.message;

            // Log full response for debugging
            Logger.warning(`Full API Response: ${JSON.stringify(resp, null, 2)}`);

            if (isInsufficientBalanceOrAllowanceCode(resp.code)) {
                abortDueToFunds = true;
                Logger.warning(
                    `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                );
                Logger.warning(
                    'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                );
                break;
            }
            retry += 1;
            Logger.warning(
                `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
            );
        }
    }
    if (abortDueToFunds) {
        // Send Telegram notification for failed trade (insufficient funds)
        TelegramNotifier.notifyTrade({
            market: trade.slug || trade.title || 'Unknown Market',
            side: 'BUY',
            amount: orderCalc.finalAmount,
            price: trade.price,
            traderAddress: userAddress,
            dryRun: DRY_RUN,
            success: false,
            reason: 'Insufficient balance or USDC allowance',
            retryAttempts: retry,
            traderAmount: trade.usdcSize,
            yourBalance: myBalance,
        }).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
        });

        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
        );
        return;
    }
    if (retry >= RETRY_LIMIT) {
        // Send notification for order that failed after all retries
        TelegramNotifier.notifyTrade({
            market: trade.slug || trade.title || 'Unknown Market',
            side: 'BUY',
            amount: orderCalc.finalAmount,
            price: trade.price,
            traderAddress: userAddress,
            dryRun: DRY_RUN,
            success: false,
            reason: `Failed after ${RETRY_LIMIT} attempts - Price slippage or order book issues`,
            retryAttempts: RETRY_LIMIT,
            traderAmount: trade.usdcSize,
            yourBalance: myBalance,
        }).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
        });

        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
        );
    } else {
        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, myBoughtSize: totalBoughtTokens }
        );
    }

    // Log the tracked purchase for later sell reference
    if (totalBoughtTokens > 0) {
        Logger.info(
            `📝 Tracked purchase: ${totalBoughtTokens.toFixed(2)} tokens for future sell calculations`
        );
    }
};

/**
 * Copy a SELL trade — mirrors the percentage of their position the trader
 * sold, scaled against our own tracked purchase size (falling back to
 * current position size if we have no tracked purchases). Needs the
 * trader's position (to compute their sell percentage) in addition to our
 * own; `myBalance` is threaded through only for Telegram notification
 * display, never for sizing math.
 */
export const postSellOrder = async (
    client: SecureClientType,
    myPosition: UserPositionInterface | undefined,
    userPosition: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    myBalance: number,
    userAddress: string
): Promise<void> => {
    const UserActivity = getUserActivityModel(userAddress);
    //Sell strategy
    Logger.info('Executing SELL strategy...');
    let remaining = 0;
    if (!myPosition) {
        Logger.warning('No position to sell');
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    // Get all previous BUY trades for this asset to calculate total bought
    const previousBuys = await UserActivity.find({
        asset: trade.asset,
        conditionId: trade.conditionId,
        side: 'BUY',
        bot: true,
        myBoughtSize: { $exists: true, $gt: 0 },
    }).exec();

    const totalBoughtTokens = previousBuys.reduce((sum, buy) => sum + (buy.myBoughtSize || 0), 0);

    if (totalBoughtTokens > 0) {
        Logger.info(
            `📊 Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
        );
    }

    if (!userPosition) {
        // Trader sold entire position - we sell entire position too
        remaining = myPosition.size;
        Logger.info(
            `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
        );
    } else {
        // Calculate the % of position the trader is selling
        // userPosition.size is trader's position AFTER the sell
        // So trader's position BEFORE = userPosition.size + trade.size
        const trader_position_before = userPosition.size + trade.size;
        const trader_position_after = userPosition.size;
        const trader_sell_percent = trade.size / trader_position_before;

        Logger.info(
            `📊 Trader position: Before=${trader_position_before.toFixed(2)}, After=${trader_position_after.toFixed(2)}, Sold=${trade.size.toFixed(2)}`
        );
        Logger.info(
            `📊 Your position: ${myPosition.size.toFixed(2)} tokens (tracked: ${totalBoughtTokens.toFixed(2)} tokens)`
        );
        Logger.info(
            `📊 Trader selling: ${trade.size.toFixed(2)} tokens (${(trader_sell_percent * 100).toFixed(2)}% of their position)`
        );

        // Use tracked bought tokens if available, otherwise fallback to current position
        let baseSellSize;
        if (totalBoughtTokens > 0) {
            baseSellSize = totalBoughtTokens * trader_sell_percent;
            Logger.info(
                `Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
            );
        } else {
            baseSellSize = myPosition.size * trader_sell_percent;
            Logger.warning(
                `No tracked purchases found, using current position: ${myPosition.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
            );
        }

        // Apply tiered or single multiplier based on trader's order size (symmetrical with BUY logic)
        const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
        remaining = baseSellSize * multiplier;

        if (multiplier !== 1.0) {
            Logger.info(
                `Applying ${multiplier}x multiplier (based on trader's $${trade.usdcSize.toFixed(2)} order): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} tokens`
            );
        }
    }

    // Check minimum order size
    if (remaining < MIN_ORDER_SIZE_TOKENS) {
        Logger.warning(
            `❌ Cannot execute: Sell amount ${remaining.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
        );
        Logger.warning(`💡 This happens when position sizes are too small or mismatched`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    // Cap sell amount to available position size
    if (remaining > myPosition.size) {
        Logger.warning(
            `⚠️  Calculated sell ${remaining.toFixed(2)} tokens > Your position ${myPosition.size.toFixed(2)} tokens`
        );
        Logger.warning(`Capping to maximum available: ${myPosition.size.toFixed(2)} tokens`);
        remaining = myPosition.size;
    }

    let retry = 0;
    let abortDueToFunds = false;
    let totalSoldTokens = 0; // Track total tokens sold

    while (remaining > 0 && retry < RETRY_LIMIT) {
        const orderBook = await client.fetchOrderBook({ assetId: trade.asset });
        if (!orderBook.bids || orderBook.bids.length === 0) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            Logger.warning('No bids available in order book');
            break;
        }

        const maxPriceBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max?.price ?? '0') ? bid : max;
        }, orderBook.bids[0]);

        if (!maxPriceBid) {
            Logger.error('No bids available in order book');
            break;
        }

        Logger.info(`Best bid: ${maxPriceBid.size} @ $${maxPriceBid.price}`);

        // Check if remaining amount is below minimum before creating order
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.info(
                `Remaining amount (${remaining.toFixed(2)} tokens) below minimum - completing trade`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            break;
        }

        const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));

        // Final check: don't create orders below minimum
        if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
            Logger.info(
                `Order amount (${sellAmount.toFixed(2)} tokens) below minimum - completing trade`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            break;
        }

        const order_arges = {
            side: OrderSide.SELL,
            tokenID: trade.asset,
            amount: sellAmount,
            price: parseFloat(maxPriceBid.price),
        };
        const resp = await submitOrder(client, order_arges);
        if (resp.ok === true) {
            retry = 0;
            totalSoldTokens += order_arges.amount;
            Logger.orderResult(true, `Sold ${order_arges.amount} tokens at $${order_arges.price}`);

            // Send Telegram notification for successful SELL trade
            TelegramNotifier.notifyTrade({
                market: trade.slug || trade.title || 'Unknown Market',
                side: 'SELL',
                amount: order_arges.amount * order_arges.price, // Convert tokens to USD
                price: order_arges.price,
                traderAddress: userAddress,
                dryRun: DRY_RUN,
                success: true,
                traderAmount: trade.usdcSize,
                yourBalance: myBalance,
                transactionHash: resp.transactionsHashes[0] ?? undefined,
            }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
            });

            remaining -= order_arges.amount;
        } else {
            const errorMessage = resp.message;

            // Log full response for debugging
            Logger.warning(`Full API Response: ${JSON.stringify(resp, null, 2)}`);

            if (isInsufficientBalanceOrAllowanceCode(resp.code)) {
                abortDueToFunds = true;
                Logger.warning(
                    `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                );
                Logger.warning(
                    'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                );
                break;
            }
            retry += 1;
            Logger.warning(
                `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
            );
        }
    }

    // Update tracked purchases after successful sell
    if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
        const sellPercentage = totalSoldTokens / totalBoughtTokens;

        if (sellPercentage >= 0.99) {
            // Sold essentially all tracked tokens - clear tracking
            await UserActivity.updateMany(
                {
                    asset: trade.asset,
                    conditionId: trade.conditionId,
                    side: 'BUY',
                    bot: true,
                    myBoughtSize: { $exists: true, $gt: 0 },
                },
                { $set: { myBoughtSize: 0 } }
            );
            Logger.info(
                `🧹 Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
            );
        } else {
            // Partial sell - reduce tracked purchases proportionally
            for (const buy of previousBuys) {
                const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                await UserActivity.updateOne({ _id: buy._id }, { $set: { myBoughtSize: newSize } });
            }
            Logger.info(
                `📝 Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
            );
        }
    }

    if (abortDueToFunds) {
        // Send Telegram notification for failed SELL trade (insufficient tokens)
        TelegramNotifier.notifyTrade({
            market: trade.slug || 'Unknown Market',
            side: 'SELL',
            amount: myPosition.size * trade.price,
            price: trade.price,
            traderAddress: userAddress,
            dryRun: DRY_RUN,
            success: false,
        }).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
        });

        TelegramNotifier.notifyError({
            title: 'SELL Order Failed - Insufficient Tokens',
            message: 'Not enough tokens or allowance to execute sell',
            severity: 'high',
        }).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to send Telegram error notification: ${errorMsg}`);
        });

        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, botExcutedTime: RETRY_LIMIT }
        );
        return;
    }
    if (retry >= RETRY_LIMIT) {
        // Send notification for SELL order that failed after all retries
        TelegramNotifier.notifyTrade({
            market: trade.slug || trade.title || 'Unknown Market',
            side: 'SELL',
            amount: myPosition.size * trade.price,
            price: trade.price,
            traderAddress: userAddress,
            dryRun: DRY_RUN,
            success: false,
            reason: `Failed after ${RETRY_LIMIT} attempts - Price slippage or order book issues`,
            retryAttempts: RETRY_LIMIT,
            traderAmount: trade.usdcSize,
            yourBalance: myBalance,
        }).catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
        });

        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
    } else {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }
};
