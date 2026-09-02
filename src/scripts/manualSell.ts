import { OrderSide, OrderType } from '@polymarket/client';
import { updateBalanceAllowance } from '@polymarket/client/actions';
import { AssetType } from '@polymarket/bindings/clob';
import { ENV } from '../config/env';
import MY_EOA_ADDRESS from '../utils/getMyEOA';
import createClobClient from '../utils/createClobClient';

/**
 * The authenticated client returned by createClobClient(). @polymarket/client's
 * SecureClient is a large structural type with ~60 action-bound methods whose
 * generic parameters are inferred, not meant to be written by hand — deriving
 * the alias from createClobClient's own return type keeps it in sync.
 */
type SecureClientType = Awaited<ReturnType<typeof createClobClient>>;

const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

// Market search query
const MARKET_SEARCH_QUERY = 'Khamenei out as Supreme Leader of Iran by January 31';
const SELL_PERCENTAGE = 1.0; // 100%

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    title: string;
    outcome: string;
}

const fetchPositions = async (): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${MY_EOA_ADDRESS}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch positions: ${response.statusText}`);
    }
    return response.json();
};

const findMatchingPosition = (positions: Position[], searchQuery: string): Position | undefined => {
    return positions.find((pos) => pos.title.toLowerCase().includes(searchQuery.toLowerCase()));
};

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
    console.log(`Token ID: ${position.asset}`);
    console.log(`Market: ${position.title} - ${position.outcome}\n`);

    // Update Polymarket cache before selling
    await updatePolymarketCache(clobClient, position.asset);

    while (remaining > 0 && retry < RETRY_LIMIT) {
        try {
            // Get current order book
            const orderBook = await clobClient.fetchOrderBook({ assetId: position.asset });

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('❌ No bids available in order book');
                break;
            }

            // Find best bid
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max?.price ?? '0') ? bid : max;
            }, orderBook.bids[0]);

            if (!maxPriceBid) {
                console.log('❌ No valid bids found in order book');
                break;
            }

            console.log(`📊 Best bid: ${maxPriceBid.size} tokens @ $${maxPriceBid.price}`);

            // Determine order size
            let orderAmount: number;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                orderAmount = remaining;
            } else {
                orderAmount = parseFloat(maxPriceBid.size);
            }

            // Create sell order
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
    } else {
        console.log(`\n🎉 Successfully sold ${sellSize.toFixed(2)} tokens!`);
    }
};

async function main() {
    console.log('🚀 Manual Sell Script');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Wallet: ${PROXY_WALLET}`);
    console.log(`🔍 Searching for: "${MARKET_SEARCH_QUERY}"`);
    console.log(`📊 Sell percentage: ${(SELL_PERCENTAGE * 100).toFixed(0)}%\n`);

    try {
        // Create client
        const clobClient = await createClobClient();

        console.log('✅ Connected to Polymarket\n');

        // Get all positions
        console.log('📥 Fetching positions...');
        const positions = await fetchPositions();
        console.log(`Found ${positions.length} position(s)\n`);

        // Find matching position
        const position = findMatchingPosition(positions, MARKET_SEARCH_QUERY);

        if (!position) {
            console.log(`❌ Position "${MARKET_SEARCH_QUERY}" not found!`);
            console.log('\nAvailable positions:');
            positions.forEach((pos, idx) => {
                console.log(
                    `${idx + 1}. ${pos.title} - ${pos.outcome} (${pos.size.toFixed(2)} tokens)`
                );
            });
            process.exit(1);
        }

        console.log('✅ Position found!');
        console.log(`📌 Market: ${position.title}`);
        console.log(`📌 Outcome: ${position.outcome}`);
        console.log(`📌 Position size: ${position.size.toFixed(2)} tokens`);
        console.log(`📌 Average price: $${position.avgPrice.toFixed(4)}`);
        console.log(`📌 Current value: $${position.currentValue.toFixed(2)}`);

        // Calculate sell size
        const sellSize = position.size * SELL_PERCENTAGE;

        if (sellSize < 1.0) {
            console.log(
                `\n❌ Sell size (${sellSize.toFixed(2)} tokens) is below minimum (1.0 token)`
            );
            console.log('Please increase your position or adjust SELL_PERCENTAGE');
            process.exit(1);
        }

        // Sell position
        await sellPosition(clobClient, position, sellSize);

        console.log('\n✅ Script completed!');
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
