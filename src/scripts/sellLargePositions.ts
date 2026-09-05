import { OrderSide, OrderType } from '@polymarket/client';
import { updateBalanceAllowance } from '@polymarket/client/actions';
import { AssetType } from '@polymarket/bindings/clob';
import { ENV } from '../config/env';
import publicClient from '../utils/publicClient';
import MY_EOA_ADDRESS from '../utils/getMyEOA';
import secureClient from '../utils/secureClient';

/**
 * The authenticated client returned by secureClient(). @polymarket/client's
 * SecureClient is a large structural type with ~60 action-bound methods whose
 * generic parameters are inferred, not meant to be written by hand — deriving
 * the alias from secureClient's own return type keeps it in sync.
 */
type SecureClientType = Awaited<ReturnType<typeof secureClient>>;

const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

const SELL_PERCENTAGE = 0.8; // 80%
const MIN_POSITION_VALUE = 17; // Продаем только позиции > $17

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    totalBought: number;
    realizedPnl: number;
    percentRealizedPnl: number;
    curPrice: number;
    title?: string;
    slug?: string;
    outcome?: string;
}

const updatePolymarketCache = async (clobClient: SecureClientType, tokenId: string) => {
    try {
        console.log('🔄 Updating Polymarket balance cache for token...');
        const updateParams = {
            assetType: AssetType.CONDITIONAL,
            assetId: tokenId,
        };

        await updateBalanceAllowance(clobClient, updateParams);
        console.log('✅ Cache updated successfully\n');
    } catch (error) {
        console.log('⚠️  Warning: Could not update cache:', error);
    }
};

const sellPosition = async (clobClient: SecureClientType, position: Position, sellSize: number) => {
    let remaining = sellSize;
    let retry = 0;

    console.log(
        `\n🔄 Starting to sell ${sellSize.toFixed(2)} tokens (${(SELL_PERCENTAGE * 100).toFixed(0)}% of position)`
    );
    console.log(`Token ID: ${position.asset.slice(0, 20)}...`);
    console.log(`Market: ${position.title} - ${position.outcome}\n`);

    // Update Polymarket cache before selling
    await updatePolymarketCache(clobClient, position.asset);

    while (remaining > 0 && retry < RETRY_LIMIT) {
        try {
            // Получаем текущую книгу заказов
            const orderBook = await clobClient.fetchOrderBook({ assetId: position.asset });

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('❌ No bids available in order book');
                break;
            }

            // Находим лучший бид
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log(`📊 Best bid: ${maxPriceBid.size} tokens @ $${maxPriceBid.price}`);

            // Определяем размер ордера
            let orderAmount: number;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                orderAmount = remaining;
            } else {
                orderAmount = parseFloat(maxPriceBid.size);
            }

            // Создаем ордер на продажу
            const orderArgs = {
                side: OrderSide.SELL,
                tokenID: position.asset,
                amount: orderAmount,
                price: parseFloat(maxPriceBid.price),
            };

            console.log(`📤 Selling ${orderAmount.toFixed(2)} tokens at $${orderArgs.price}...`);

            const resp = await clobClient.placeMarketOrder({
                tokenId: orderArgs.tokenID,
                side: OrderSide.SELL,
                shares: orderArgs.amount,
                minPrice: orderArgs.price,
                orderType: OrderType.FOK,
            });

            if (resp.ok === true) {
                retry = 0;
                const soldValue = (orderAmount * orderArgs.price).toFixed(2);
                console.log(
                    `✅ SUCCESS: Sold ${orderAmount.toFixed(2)} tokens at $${orderArgs.price} (Total: $${soldValue})`
                );
                remaining -= orderAmount;

                if (remaining > 0) {
                    console.log(`⏳ Remaining to sell: ${remaining.toFixed(2)} tokens\n`);
                }
            } else {
                retry += 1;
                const errorMsg = resp.message;
                console.log(
                    `⚠️  Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMsg ? `: ${errorMsg}` : ''}`
                );

                if (retry < RETRY_LIMIT) {
                    console.log('🔄 Retrying...\n');
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        } catch (error) {
            retry += 1;
            console.error(`❌ Error during sell attempt ${retry}/${RETRY_LIMIT}:`, error);

            if (retry < RETRY_LIMIT) {
                console.log('🔄 Retrying...\n');
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }

    if (remaining > 0) {
        console.log(`\n⚠️  Could not sell all tokens. Remaining: ${remaining.toFixed(2)} tokens`);
        return false;
    } else {
        console.log(`\n🎉 Successfully sold ${sellSize.toFixed(2)} tokens!`);
        return true;
    }
};

async function main() {
    console.log('🚀 Sell Large Positions Script');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Wallet: ${PROXY_WALLET}`);
    console.log(`📊 Sell percentage: ${(SELL_PERCENTAGE * 100).toFixed(0)}%`);
    console.log(`💰 Minimum position value: $${MIN_POSITION_VALUE}\n`);

    try {
        // Создаем клиента
        const clobClient = await secureClient();

        console.log('✅ Connected to Polymarket\n');

        // Получаем все позиции
        console.log('📥 Fetching positions...');
        const positions = (await publicClient.getPositions(
            MY_EOA_ADDRESS
        )) as unknown as Position[];
        console.log(`Found ${positions.length} position(s)\n`);

        // Фильтруем большие позиции
        const largePositions = positions.filter((p) => p.currentValue > MIN_POSITION_VALUE);

        if (largePositions.length === 0) {
            console.log(`✅ No positions larger than $${MIN_POSITION_VALUE} found.`);
            process.exit(0);
        }

        // Сортируем по размеру
        largePositions.sort((a, b) => b.currentValue - a.currentValue);

        console.log(`🎯 Found ${largePositions.length} large position(s):\n`);
        for (const pos of largePositions) {
            console.log(`  • ${pos.title || 'Unknown'} [${pos.outcome}]`);
            console.log(
                `    Current: $${pos.currentValue.toFixed(2)} (${pos.size.toFixed(2)} shares)`
            );
            console.log(
                `    Will sell: ${(pos.size * SELL_PERCENTAGE).toFixed(2)} shares (${(SELL_PERCENTAGE * 100).toFixed(0)}%)`
            );
            console.log(``);
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        let successCount = 0;
        let failureCount = 0;
        let totalSold = 0;

        // Продаем каждую позицию
        for (let i = 0; i < largePositions.length; i++) {
            const position = largePositions[i];
            const sellSize = Math.floor(position.size * SELL_PERCENTAGE);

            console.log(`\n📦 Position ${i + 1}/${largePositions.length}`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`Market: ${position.title || 'Unknown'}`);
            console.log(`Outcome: ${position.outcome || 'Unknown'}`);
            console.log(`Position size: ${position.size.toFixed(2)} tokens`);
            console.log(`Average price: $${position.avgPrice.toFixed(4)}`);
            console.log(`Current value: $${position.currentValue.toFixed(2)}`);
            console.log(
                `PnL: $${position.cashPnl.toFixed(2)} (${position.percentPnl.toFixed(2)}%)`
            );

            if (sellSize < 1.0) {
                console.log(
                    `\n⚠️  Skipping: Sell size (${sellSize.toFixed(2)} tokens) is below minimum (1.0 token)\n`
                );
                failureCount++;
                continue;
            }

            const success = await sellPosition(clobClient, position, sellSize);

            if (success) {
                successCount++;
                totalSold += sellSize;
            } else {
                failureCount++;
            }

            // Пауза между продажами
            if (i < largePositions.length - 1) {
                console.log('\n⏳ Waiting 2 seconds before next sale...\n');
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 SUMMARY');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`✅ Successful sales: ${successCount}/${largePositions.length}`);
        console.log(`❌ Failed sales: ${failureCount}/${largePositions.length}`);
        console.log(`📦 Total tokens sold: ${totalSold.toFixed(2)}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        console.log('✅ Script completed!');
    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Unhandled error:', error);
        process.exit(1);
    });
