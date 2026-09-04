import { OrderSide } from '@polymarket/client';
import { updateBalanceAllowance } from '@polymarket/client/actions';
import { AssetType } from '@polymarket/bindings/clob';
import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import { submitOrder, recordBuyFill } from '../utils/postOrder';
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
const MIN_ORDER_SIZE_USD = 1.0;

interface Market {
    conditionId: string;
    question: string;
    outcomes: string; // JSON-encoded array, e.g. '["Yes","No"]'
    clobTokenIds: string; // JSON-encoded array, aligned with outcomes
    active: boolean;
    closed: boolean;
}

/**
 * The public /markets endpoint (not /positions) — we're buying INTO a
 * market we may not already hold, so there is no existing position to look
 * up. Filtered client-side by question text and to active, unclosed markets.
 */
const fetchMarkets = async (searchQuery: string): Promise<Market[]> => {
    const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&search=${encodeURIComponent(searchQuery)}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.statusText}`);
    }
    return response.json();
};

/**
 * Unlike manualSell.ts's findMatchingPosition (which searches only the
 * caller's own small position list), this searches the ENTIRE public market
 * catalog via gamma's fuzzy /markets?search= endpoint — a short or generic
 * query can easily match several unrelated markets. Returns every
 * substring match rather than silently picking the first one, so the
 * caller can refuse to proceed on ambiguity instead of risking a real order
 * on the wrong market.
 */
const findMatchingMarkets = (markets: Market[], searchQuery: string): Market[] => {
    return markets.filter((m) => m.question.toLowerCase().includes(searchQuery.toLowerCase()));
};

/**
 * Resolves which token (outcome) to buy from a market's parallel
 * outcomes/clobTokenIds arrays, matching the requested outcome label
 * case-insensitively (e.g. "yes" matches "Yes").
 */
const resolveOutcomeToken = (
    market: Market,
    outcomeLabel: string
): { tokenId: string; outcome: string } | undefined => {
    const outcomes: string[] = JSON.parse(market.outcomes);
    const tokenIds: string[] = JSON.parse(market.clobTokenIds);
    if (outcomes.length !== tokenIds.length) {
        // outcomes/clobTokenIds are meant to be parallel arrays (same
        // index = same outcome). If a corrupted/legacy market record ever
        // broke that invariant, indexing into tokenIds by an index found in
        // outcomes could silently resolve to the WRONG token — buying the
        // wrong outcome with real money. Refuse rather than guess.
        return undefined;
    }
    const index = outcomes.findIndex((o) => o.toLowerCase() === outcomeLabel.toLowerCase());
    if (index === -1) {
        return undefined;
    }
    return { tokenId: tokenIds[index]!, outcome: outcomes[index]! };
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
 * Places BUY orders via the same submitOrder() the live bot uses (not a
 * separate, duplicated clobClient.placeMarketOrder() call), so this script
 * automatically gets the maxSpend fee-headroom fix (see submitOrder's own
 * comment in postOrder.ts) rather than needing that fix re-applied by hand
 * and risking it drifting out of sync later. Calls recordBuyFill() on every
 * successful fill so my_positions reflects a manual buy immediately —
 * without this, a position bought here would be invisible to the bot's own
 * postSellOrder until the next reconciliation tick in tradeMonitor.ts.
 */
const buyMarket = async (
    clobClient: SecureClientType,
    conditionId: string,
    tokenId: string,
    usdAmount: number
) => {
    let remaining = usdAmount;
    let retry = 0;
    let totalBoughtTokens = 0;

    console.log(`\n🔄 Starting to buy $${usdAmount.toFixed(2)} worth of tokens`);
    console.log(`Token ID: ${tokenId}\n`);

    // Update Polymarket cache before buying
    await updatePolymarketCache(clobClient, tokenId);

    while (remaining > 0 && retry < RETRY_LIMIT) {
        try {
            const orderBook = await clobClient.fetchOrderBook({ assetId: tokenId });

            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('❌ No asks available in order book');
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min?.price ?? '999999') ? ask : min;
            }, orderBook.asks[0]);

            if (!minPriceAsk) {
                console.log('❌ No valid asks found in order book');
                break;
            }

            console.log(`📊 Best ask: ${minPriceAsk.size} tokens @ $${minPriceAsk.price}`);

            if (remaining < MIN_ORDER_SIZE_USD) {
                console.log(`Remaining amount ($${remaining.toFixed(2)}) below minimum - stopping`);
                break;
            }

            const orderPrice = parseFloat(minPriceAsk.price);
            const maxOrderSize = parseFloat(minPriceAsk.size) * orderPrice;
            const orderAmount = Math.min(remaining, maxOrderSize);

            console.log(`📤 Buying $${orderAmount.toFixed(2)} at $${orderPrice}...`);

            const resp = await submitOrder(clobClient, {
                side: OrderSide.BUY,
                tokenID: tokenId,
                amount: orderAmount,
                price: orderPrice,
            });

            if (resp.ok === true) {
                retry = 0;
                const tokensBought = orderAmount / orderPrice;
                totalBoughtTokens += tokensBought;
                console.log(
                    `✅ SUCCESS: Bought $${orderAmount.toFixed(2)} at $${orderPrice} (${tokensBought.toFixed(2)} tokens)`
                );
                // Decrement BEFORE the my_positions write, and isolate that
                // write in its own try/catch: a real order already filled at
                // this point, so a Mongo hiccup here must never re-enter the
                // outer catch/retry path below and cause this same amount to
                // be bought again as a duplicate real order.
                remaining -= orderAmount;
                try {
                    await recordBuyFill(conditionId, tokenId, tokensBought, orderPrice);
                } catch (recordError) {
                    console.log(
                        `⚠️  Warning: failed to record fill in my_positions (buy itself succeeded): ${recordError}`
                    );
                }

                if (remaining > 0) {
                    console.log(`⏳ Remaining to spend: $${remaining.toFixed(2)}\n`);
                }
            } else {
                const errorMsg = resp.message;

                if (isInsufficientBalanceOrAllowanceCode(resp.code)) {
                    console.log(
                        `❌ Order rejected: ${errorMsg || 'Insufficient balance or allowance'}`
                    );
                    console.log(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
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
            console.error(`❌ Error during buy attempt ${retry}/${RETRY_LIMIT}:`, error);

            if (retry < RETRY_LIMIT) {
                console.log('🔄 Retrying...\n');
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }

    if (remaining > MIN_ORDER_SIZE_USD - 1e-9) {
        console.log(`\n⚠️  Could not spend all funds. Remaining: $${remaining.toFixed(2)}`);
    } else {
        console.log(
            `\n🎉 Successfully bought ${totalBoughtTokens.toFixed(2)} tokens for $${(usdAmount - remaining).toFixed(2)}!`
        );
    }
};

async function main() {
    const marketSearchQuery = process.argv[2];
    const outcomeLabel = process.argv[3];
    const usdAmountArg = process.argv[4];

    if (!marketSearchQuery || !outcomeLabel || !usdAmountArg) {
        console.log('❌ Missing required arguments');
        console.log('Usage: npm run manual-buy "<market search query>" <outcome> <usd amount>');
        console.log('Example: npm run manual-buy "Will X happen" Yes 25');
        process.exit(1);
    }

    const usdAmount = parseFloat(usdAmountArg);
    if (isNaN(usdAmount) || usdAmount < MIN_ORDER_SIZE_USD) {
        console.log(
            `❌ Invalid USD amount: "${usdAmountArg}" (must be at least $${MIN_ORDER_SIZE_USD})`
        );
        process.exit(1);
    }

    console.log('🚀 Manual Buy Script');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Wallet: ${PROXY_WALLET}`);
    console.log(`🔍 Searching for: "${marketSearchQuery}"`);
    console.log(`📊 Outcome: ${outcomeLabel}`);
    console.log(`💵 Amount: $${usdAmount.toFixed(2)}\n`);

    try {
        const clobClient = await createClobClient();

        console.log('✅ Connected to Polymarket\n');

        console.log('📥 Fetching markets...');
        const markets = await fetchMarkets(marketSearchQuery);
        console.log(`Found ${markets.length} market(s)\n`);

        const matches = findMatchingMarkets(markets, marketSearchQuery);

        if (matches.length === 0) {
            console.log(`❌ Market "${marketSearchQuery}" not found!`);
            console.log('\nAvailable markets:');
            markets.forEach((m, idx) => {
                console.log(`${idx + 1}. ${m.question}`);
            });
            process.exit(1);
        }

        if (matches.length > 1) {
            console.log(
                `❌ "${marketSearchQuery}" matches ${matches.length} markets — refusing to guess which one to buy:`
            );
            matches.forEach((m, idx) => {
                console.log(`${idx + 1}. ${m.question} (conditionId: ${m.conditionId})`);
            });
            console.log('\nNarrow your search query to match exactly one market and try again.');
            process.exit(1);
        }

        const market = matches[0]!;

        console.log('✅ Market found!');
        console.log(`📌 Market: ${market.question}`);
        console.log(`📌 Condition ID: ${market.conditionId}`);

        const resolved = resolveOutcomeToken(market, outcomeLabel);
        if (!resolved) {
            console.log(`❌ Outcome "${outcomeLabel}" not found in this market!`);
            console.log(`Available outcomes: ${market.outcomes}`);
            process.exit(1);
        }

        console.log(`📌 Outcome: ${resolved.outcome}`);
        console.log(`📌 Token ID: ${resolved.tokenId}`);

        await buyMarket(clobClient, market.conditionId, resolved.tokenId, usdAmount);

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
