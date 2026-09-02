import { ethers } from 'ethers';
import {
    AssetType,
    ClobClient,
    OrderType,
    Side,
    SignatureTypeV2,
} from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import MY_EOA_ADDRESS from '../utils/getMyEOA';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;
const POLYGON_CHAIN_ID = 137;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

// ==================== CONFIGURATION ====================
// Edit these values:
const TRADER_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'; // Trader to check
const MARKET_SEARCH_QUERY = 'Khamenei'; // Search term for market
const SELL_PERCENTAGE = 1.0; // 1.0 = 100%, 0.5 = 50%, etc.
// =======================================================

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    title: string;
    outcome: string;
}

const isGnosisSafe = async (
    address: string,
    provider: ethers.providers.JsonRpcProvider
): Promise<boolean> => {
    try {
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        console.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

const createClobClient = async (
    provider: ethers.providers.JsonRpcProvider
): Promise<ClobClient> => {
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const isProxySafe = await isGnosisSafe(PROXY_WALLET, provider);

    console.log(`Wallet type: ${isProxySafe ? 'Gnosis Safe' : 'EOA'}`);
    const signatureType = isProxySafe ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA;

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    // V2 client uses options object
    let clobClient = new ClobClient({
        host: CLOB_HTTP_URL,
        chain: POLYGON_CHAIN_ID,
        signer: wallet,
        signatureType,
        ...(isProxySafe && { funderAddress: PROXY_WALLET }),
    });

    // V2 uses createOrDeriveApiKey()
    const creds = await clobClient.createOrDeriveApiKey();

    clobClient = new ClobClient({
        host: CLOB_HTTP_URL,
        chain: POLYGON_CHAIN_ID,
        signer: wallet,
        creds,
        signatureType,
        ...(isProxySafe && { funderAddress: PROXY_WALLET }),
    });

    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

const fetchPositions = async (walletAddress: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch positions: ${response.statusText}`);
    }
    return response.json();
};

const findMatchingPosition = (positions: Position[], searchQuery: string): Position | undefined => {
    return positions.find((pos) => pos.title.toLowerCase().includes(searchQuery.toLowerCase()));
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        console.log('🔄 Updating Polymarket balance cache for token...');
        const updateParams = {
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        };

        await clobClient.updateBalanceAllowance(updateParams);
        console.log('✅ Cache updated successfully\n');
    } catch (error) {
        console.log('⚠️  Warning: Could not update cache:', error);
    }
};

const sellPosition = async (clobClient: ClobClient, position: Position, sellSize: number) => {
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
            const orderBook = await clobClient.getOrderBook(position.asset);

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
                side: Side.SELL,
                tokenID: position.asset,
                amount: orderAmount,
                price: parseFloat(maxPriceBid.price),
            };

            console.log(`📤 Selling ${orderAmount.toFixed(2)} tokens at $${orderArgs.price}...`);

            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
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
                const errorMsg = extractOrderError(resp);
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

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

async function main() {
    console.log('🔍 Trader Position Check & Sell Script');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Your wallet: ${PROXY_WALLET}`);
    console.log(`👤 Trader: ${TRADER_ADDRESS}`);
    console.log(`🔍 Searching for: "${MARKET_SEARCH_QUERY}"\n`);

    try {
        // Create provider and client
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const clobClient = await createClobClient(provider);

        console.log('✅ Connected to Polymarket\n');

        // ==================== CHECK TRADER POSITION ====================
        console.log('📥 Fetching trader positions...');
        const traderPositions = await fetchPositions(TRADER_ADDRESS);
        console.log(`Found ${traderPositions.length} trader position(s)\n`);

        const traderPosition = findMatchingPosition(traderPositions, MARKET_SEARCH_QUERY);

        if (!traderPosition) {
            console.log(`❌ Trader has no position matching "${MARKET_SEARCH_QUERY}"!`);
            console.log('\nTrader available positions:');
            traderPositions.forEach((pos, idx) => {
                console.log(
                    `${idx + 1}. ${pos.title} - ${pos.outcome} (${pos.size.toFixed(2)} tokens, $${pos.currentValue.toFixed(2)})`
                );
            });
            process.exit(1);
        }

        console.log('✅ Trader position found!');
        console.log(`📌 Market: ${traderPosition.title}`);
        console.log(`📌 Outcome: ${traderPosition.outcome}`);
        console.log(`📌 Trader position size: ${traderPosition.size.toFixed(2)} tokens`);
        console.log(`📌 Trader avg price: $${traderPosition.avgPrice.toFixed(4)}`);
        console.log(`📌 Trader current value: $${traderPosition.currentValue.toFixed(2)}\n`);

        // ==================== CHECK YOUR POSITION ====================
        console.log('📥 Fetching your positions...');
        const myPositions = await fetchPositions(MY_EOA_ADDRESS);
        console.log(`Found ${myPositions.length} position(s)\n`);

        const myPosition = myPositions.find(
            (pos) => pos.conditionId === traderPosition.conditionId
        );

        if (!myPosition) {
            console.log(
                `❌ You have no position in "${MARKET_SEARCH_QUERY}" (conditionId: ${traderPosition.conditionId})`
            );
            console.log('\nYour available positions:');
            myPositions.forEach((pos, idx) => {
                console.log(
                    `${idx + 1}. ${pos.title} - ${pos.outcome} (${pos.size.toFixed(2)} tokens, $${pos.currentValue.toFixed(2)})`
                );
            });
            process.exit(1);
        }

        console.log('✅ Your position found!');
        console.log(`📌 Market: ${myPosition.title}`);
        console.log(`📌 Outcome: ${myPosition.outcome}`);
        console.log(`📌 Your position size: ${myPosition.size.toFixed(2)} tokens`);
        console.log(`📌 Your avg price: $${myPosition.avgPrice.toFixed(4)}`);
        console.log(`📌 Your current value: $${myPosition.currentValue.toFixed(2)}\n`);

        // ==================== COMPARISON ====================
        console.log('📊 COMPARISON');
        console.log('═══════════════════════════════════════════════');
        console.log(`Trader position: ${traderPosition.size.toFixed(2)} tokens`);
        console.log(`Your position:   ${myPosition.size.toFixed(2)} tokens`);
        const ratio = (myPosition.size / traderPosition.size) * 100;
        console.log(`Your/Trader ratio: ${ratio.toFixed(2)}%\n`);

        // ==================== SELL DECISION ====================
        if (SELL_PERCENTAGE > 0) {
            const sellSize = myPosition.size * SELL_PERCENTAGE;

            if (sellSize < 1.0) {
                console.log(
                    `\n❌ Sell size (${sellSize.toFixed(2)} tokens) is below minimum (1.0 token)`
                );
                console.log('Please increase your position or adjust SELL_PERCENTAGE');
                process.exit(1);
            }

            console.log(`📊 Sell percentage: ${(SELL_PERCENTAGE * 100).toFixed(0)}%`);
            console.log(
                `📊 Will sell: ${sellSize.toFixed(2)} tokens out of ${myPosition.size.toFixed(2)}`
            );
            console.log(
                `📊 Estimated value: $${(sellSize * myPosition.avgPrice).toFixed(2)} (at avg price)\n`
            );

            // Sell position
            await sellPosition(clobClient, myPosition, sellSize);
        } else {
            console.log('ℹ️  SELL_PERCENTAGE is 0 - skipping sell (check-only mode)\n');
        }

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
