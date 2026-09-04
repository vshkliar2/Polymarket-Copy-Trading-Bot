import { OrderSide } from '@polymarket/client';
import { updateBalanceAllowance } from '@polymarket/client/actions';
import { AssetType } from '@polymarket/bindings/clob';
import { ENV } from '../config/env';
import MY_EOA_ADDRESS from '../utils/getMyEOA';
import createClobClient from '../utils/createClobClient';
import { submitOrder, recordSellFill } from '../utils/postOrder';
import { isInsufficientBalanceOrAllowanceCode } from '../utils/errorHelpers';

/**
 * The authenticated client returned by createClobClient(). @polymarket/client's
 * SecureClient is a large structural type with ~60 action-bound methods whose
 * generic parameters are inferred, not meant to be written by hand — deriving
 * the alias from createClobClient's own return type keeps it in sync.
 */
type SecureClientType = Awaited<ReturnType<typeof createClobClient>>;

const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    title: string;
    outcome: string;
}

interface CliOptions {
    market?: string;
    conditionId?: string;
    percent?: number;
}

const USAGE = [
    'Usage:',
    '  npm run manual-sell -- --market="<search query>" [--percent=<1-100>]',
    '  npm run manual-sell -- --condition-id=<conditionId> [--percent=<1-100>]',
    '',
    'Examples:',
    '  npm run manual-sell -- --market="Will X happen" --percent=50',
    '  npm run manual-sell -- --condition-id=0xabc123...',
    '',
    '--percent defaults to 100 (sell the entire position) if omitted.',
    '--condition-id is exact and unambiguous — prefer it when you already know it.',
    '--market does a text search over your own positions and requires exactly',
    'one match; ambiguous or missing matches are refused rather than guessed at.',
].join('\n');

/**
 * Named flags (--flag=value), matching the convention already used in
 * discoverTraders.ts, rather than positional args — a positional arg list
 * for a script that sells real money is easy to get subtly wrong (was the
 * percentage the 2nd or 3rd arg?), and named flags let --market and
 * --condition-id be unambiguous alternatives rather than the same
 * positional slot doing double duty.
 */
const parseArgs = (argv: string[]): CliOptions => {
    const options: CliOptions = {};
    for (const arg of argv) {
        if (arg.startsWith('--market=')) {
            options.market = arg.slice('--market='.length);
        } else if (arg.startsWith('--condition-id=')) {
            options.conditionId = arg.slice('--condition-id='.length);
        } else if (arg.startsWith('--percent=')) {
            options.percent = parseFloat(arg.slice('--percent='.length));
        }
    }
    return options;
};

const fetchPositions = async (): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${MY_EOA_ADDRESS}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch positions: ${response.statusText}`);
    }
    return response.json();
};

const fetchPositionByConditionId = async (conditionId: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${MY_EOA_ADDRESS}&market=${encodeURIComponent(conditionId)}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch position: ${response.statusText}`);
    }
    return response.json();
};

/**
 * Returns every substring match rather than silently picking the first
 * one — a generic query (e.g. "election") could match more than one of the
 * caller's own positions, and guessing which one to sell is exactly the
 * kind of mistake that should refuse rather than proceed.
 */
const findMatchingPositions = (positions: Position[], searchQuery: string): Position[] => {
    return positions.filter((pos) => pos.title.toLowerCase().includes(searchQuery.toLowerCase()));
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

/**
 * Places SELL orders via the same submitOrder() the live bot uses (not a
 * separate, duplicated clobClient.placeMarketOrder() call) so this script
 * automatically inherits any future fix to order construction, and calls
 * recordSellFill() on every successful fill so my_positions reflects a
 * manual sell immediately — without this, my_positions would only catch up
 * on the next reconciliation tick in tradeMonitor.ts, or not at all if the
 * position was fully closed and the bot isn't currently running.
 */
const sellPosition = async (clobClient: SecureClientType, position: Position, sellSize: number) => {
    let remaining = sellSize;
    let retry = 0;

    console.log(`\n🔄 Starting to sell ${sellSize.toFixed(2)} tokens`);
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

            const orderPrice = parseFloat(maxPriceBid.price);

            console.log(`📤 Selling ${orderAmount.toFixed(2)} tokens at $${orderPrice}...`);

            const resp = await submitOrder(clobClient, {
                side: OrderSide.SELL,
                tokenID: position.asset,
                amount: orderAmount,
                price: orderPrice,
            });

            if (resp.ok === true) {
                retry = 0;
                const soldValue = (orderAmount * orderPrice).toFixed(2);
                console.log(
                    `✅ SUCCESS: Sold ${orderAmount.toFixed(2)} tokens at $${orderPrice} (Total: $${soldValue})`
                );
                // Decrement BEFORE the my_positions write, and isolate that
                // write in its own try/catch: a real order already filled at
                // this point, so a Mongo hiccup here must never re-enter the
                // outer catch/retry path below and cause this same amount to
                // be sold again as a duplicate real order.
                remaining -= orderAmount;
                try {
                    await recordSellFill(position.conditionId, orderAmount);
                } catch (recordError) {
                    console.log(
                        `⚠️  Warning: failed to record fill in my_positions (sell itself succeeded): ${recordError}`
                    );
                }

                if (remaining > 0) {
                    console.log(`⏳ Remaining to sell: ${remaining.toFixed(2)} tokens\n`);
                }
            } else {
                const errorMsg = resp.message;

                if (isInsufficientBalanceOrAllowanceCode(resp.code)) {
                    console.log(
                        `❌ Order rejected: ${errorMsg || 'Insufficient balance or allowance'}`
                    );
                    console.log(
                        'Skipping remaining attempts. Run `npm run check-allowance` before retrying.'
                    );
                    break;
                }

                retry += 1;
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

/**
 * Resolves --market or --condition-id (mutually exclusive) down to exactly
 * one Position, or exits the process. Kept separate from main() so the two
 * lookup paths (exact vs. fuzzy-search) share one place that owns the
 * "exactly one, or refuse" invariant.
 */
const resolvePosition = async (options: CliOptions): Promise<Position> => {
    if (options.conditionId && options.market) {
        console.log('❌ Specify either --market or --condition-id, not both');
        process.exit(1);
    }

    if (options.conditionId) {
        console.log(`🔍 Looking up condition ID: ${options.conditionId}`);
        const positions = await fetchPositionByConditionId(options.conditionId);
        if (positions.length === 0) {
            console.log(`❌ No position found for condition ID "${options.conditionId}"`);
            process.exit(1);
        }
        return positions[0]!;
    }

    if (options.market) {
        console.log(`🔍 Searching for: "${options.market}"`);
        console.log('📥 Fetching positions...');
        const positions = await fetchPositions();
        console.log(`Found ${positions.length} position(s)\n`);

        const matches = findMatchingPositions(positions, options.market);

        if (matches.length === 0) {
            console.log(`❌ Position "${options.market}" not found!`);
            console.log('\nAvailable positions:');
            positions.forEach((pos, idx) => {
                console.log(
                    `${idx + 1}. ${pos.title} - ${pos.outcome} (${pos.size.toFixed(2)} tokens)`
                );
            });
            process.exit(1);
        }

        if (matches.length > 1) {
            console.log(
                `❌ "${options.market}" matches ${matches.length} positions — refusing to guess which one to sell:`
            );
            matches.forEach((pos, idx) => {
                console.log(
                    `${idx + 1}. ${pos.title} - ${pos.outcome} (conditionId: ${pos.conditionId})`
                );
            });
            console.log(
                '\nNarrow your search query, or use --condition-id=<id> from the list above, and try again.'
            );
            process.exit(1);
        }

        return matches[0]!;
    }

    console.log('❌ Specify either --market="<search query>" or --condition-id=<conditionId>');
    console.log(USAGE);
    process.exit(1);
};

async function main() {
    const options = parseArgs(process.argv.slice(2));

    const sellPercentage = options.percent !== undefined ? options.percent / 100 : 1.0;
    if (isNaN(sellPercentage) || sellPercentage <= 0 || sellPercentage > 1) {
        console.log(`❌ Invalid --percent: "${options.percent}" (must be between 1 and 100)`);
        process.exit(1);
    }

    console.log('🚀 Manual Sell Script');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Wallet: ${PROXY_WALLET}`);
    console.log(`📊 Sell percentage: ${(sellPercentage * 100).toFixed(0)}%\n`);

    try {
        // Create client
        const clobClient = await createClobClient();

        console.log('✅ Connected to Polymarket\n');

        const position = await resolvePosition(options);

        console.log('✅ Position found!');
        console.log(`📌 Market: ${position.title}`);
        console.log(`📌 Outcome: ${position.outcome}`);
        console.log(`📌 Position size: ${position.size.toFixed(2)} tokens`);
        console.log(`📌 Average price: $${position.avgPrice.toFixed(4)}`);
        console.log(`📌 Current value: $${position.currentValue.toFixed(2)}`);

        // Calculate sell size
        const sellSize = position.size * sellPercentage;

        if (sellSize < 1.0) {
            console.log(
                `\n❌ Sell size (${sellSize.toFixed(2)} tokens) is below minimum (1.0 token)`
            );
            console.log('Please increase your position or adjust --percent');
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
