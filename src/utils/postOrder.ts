import { OrderSide, OrderType } from '@polymarket/client';
import { OrderPostStatus } from '@polymarket/bindings/clob';
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

// Legacy parameters (for backward compatibility in SELL logic)
const TRADE_MULTIPLIER = ENV.TRADE_MULTIPLIER;
const COPY_PERCENTAGE = ENV.COPY_PERCENTAGE;

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
        return client.placeMarketOrder({
            tokenId: orderArgs.tokenID,
            side: OrderSide.BUY,
            amount: orderArgs.amount,
            maxPrice: orderArgs.price,
            orderType: OrderType.FOK,
        });
    }

    // SELL orders take `shares` (token quantity), not a dollar `amount` —
    // orderArgs.amount is already a token count at every SELL call site in
    // this file (the merge and sell branches), matching this distinction.
    return client.placeMarketOrder({
        tokenId: orderArgs.tokenID,
        side: OrderSide.SELL,
        shares: orderArgs.amount,
        minPrice: orderArgs.price,
        orderType: OrderType.FOK,
    });
};

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = 1.0; // Minimum order size in tokens for SELL/MERGE orders

const postOrder = async (
    client: SecureClientType,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string
) => {
    const UserActivity = getUserActivityModel(userAddress);
    //Merge strategy
    if (condition === 'merge') {
        Logger.info('Executing MERGE strategy...');
        if (!my_position) {
            Logger.warning('No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `Position size (${remaining.toFixed(2)} tokens) too small to merge - skipping`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let retry = 0;
        let abortDueToFunds = false;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await client.fetchOrderBook({ assetId: trade.asset });
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('No bids available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
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
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: OrderSide.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: OrderSide.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            const resp = await submitOrder(client, order_arges);
            if (resp.ok === true) {
                retry = 0;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );

                // Send Telegram notification for successful SELL trade (initial position close)
                TelegramNotifier.notifyTrade({
                    market: trade.slug || trade.title || 'Unknown Market',
                    side: 'SELL',
                    amount: order_arges.amount * order_arges.price, // Convert tokens to USD
                    price: order_arges.price,
                    traderAddress: userAddress,
                    dryRun: DRY_RUN,
                    success: true,
                    traderAmount: trade.usdcSize,
                    yourBalance: my_balance,
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
            // Send Telegram notification for failed SELL trade (insufficient funds)
            TelegramNotifier.notifyTrade({
                market: trade.slug || trade.title || 'Unknown Market',
                side: 'SELL',
                amount: my_position.size * trade.price,
                price: trade.price,
                traderAddress: userAddress,
                dryRun: DRY_RUN,
                success: false,
                reason: 'Insufficient tokens in your position',
                retryAttempts: retry,
                traderAmount: trade.usdcSize,
                yourBalance: my_balance,
            }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
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
                amount: my_position.size * trade.price,
                price: trade.price,
                traderAddress: userAddress,
                dryRun: DRY_RUN,
                success: false,
                reason: `Failed after ${RETRY_LIMIT} attempts - Price slippage or order book issues`,
                retryAttempts: RETRY_LIMIT,
                traderAmount: trade.usdcSize,
                yourBalance: my_balance,
            }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
            });

            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'buy') {
        //Buy strategy
        Logger.info('Executing BUY strategy...');

        Logger.info(`Your balance: $${my_balance.toFixed(2)}`);
        Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

        // Get current position size for position limit checks
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Use new copy strategy system
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
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
            my_balance,
            my_position
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
                `Creating order: $${orderSize.toFixed(2)} @ $${minPriceAsk.price} (Balance: $${my_balance.toFixed(2)})`
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
                    yourBalance: my_balance,
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
                yourBalance: my_balance,
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
                yourBalance: my_balance,
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
    } else if (condition === 'sell') {
        //Sell strategy
        Logger.info('Executing SELL strategy...');
        let remaining = 0;
        if (!my_position) {
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

        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
            );
        }

        if (!user_position) {
            // Trader sold entire position - we sell entire position too
            remaining = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
            );
        } else {
            // Calculate the % of position the trader is selling
            // user_position.size is trader's position AFTER the sell
            // So trader's position BEFORE = user_position.size + trade.size
            const trader_position_before = user_position.size + trade.size;
            const trader_position_after = user_position.size;
            const trader_sell_percent = trade.size / trader_position_before;

            Logger.info(
                `📊 Trader position: Before=${trader_position_before.toFixed(2)}, After=${trader_position_after.toFixed(2)}, Sold=${trade.size.toFixed(2)}`
            );
            Logger.info(
                `📊 Your position: ${my_position.size.toFixed(2)} tokens (tracked: ${totalBoughtTokens.toFixed(2)} tokens)`
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
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `No tracked purchases found, using current position: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
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
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  Calculated sell ${remaining.toFixed(2)} tokens > Your position ${my_position.size.toFixed(2)} tokens`
            );
            Logger.warning(`Capping to maximum available: ${my_position.size.toFixed(2)} tokens`);
            remaining = my_position.size;
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
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );

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
                    yourBalance: my_balance,
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
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
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
                amount: my_position.size * trade.price,
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
                amount: my_position.size * trade.price,
                price: trade.price,
                traderAddress: userAddress,
                dryRun: DRY_RUN,
                success: false,
                reason: `Failed after ${RETRY_LIMIT} attempts - Price slippage or order book issues`,
                retryAttempts: RETRY_LIMIT,
                traderAmount: trade.usdcSize,
                yourBalance: my_balance,
            }).catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                Logger.error(`Failed to send Telegram notification: ${errorMsg}`);
            });

            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else {
        Logger.error(`Unknown condition: ${condition}`);
    }
};

export default postOrder;
