import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import mongoose from 'mongoose';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const MY_ADDRESS = ENV.PROXY_WALLET?.toLowerCase();
const MONGO_URI = ENV.MONGO_URI;

async function main() {
    await mongoose.connect(MONGO_URI as string);

    console.log('');
    console.log('═'.repeat(70));
    console.log('📊 SLIPPAGE ANALYSIS');
    console.log('═'.repeat(70));
    console.log('');

    // Get my trades
    const MyActivity = getUserActivityModel('my_wallet');
    const myTrades = await MyActivity.find({ side: 'BUY' }).sort({ timestamp: -1 }).limit(50);

    console.log(`Found ${myTrades.length} of your BUY trades\n`);

    const slippageData: Array<{
        date: string;
        market: string;
        traderPrice: number;
        myPrice: number;
        slippageCents: number;
        slippagePercent: number;
    }> = [];

    for (const myTrade of myTrades) {
        const conditionId = myTrade.conditionId;
        const timestamp = myTrade.timestamp;

        // Find the trader's trade that triggered this
        for (const userAddress of USER_ADDRESSES) {
            const TraderActivity = getUserActivityModel(userAddress);

            // Find trader's trade around the same time (within 30 seconds before)
            const traderTrade = await TraderActivity.findOne({
                conditionId,
                side: 'BUY',
                timestamp: {
                    $gte: timestamp - 30, // Up to 30 seconds before
                    $lte: timestamp, // At or before my trade
                },
            }).sort({ timestamp: -1 });

            if (traderTrade) {
                const slippageCents = myTrade.price - traderTrade.price;
                const slippagePercent = (slippageCents / traderTrade.price) * 100;

                slippageData.push({
                    date: new Date(myTrade.timestamp * 1000).toISOString().split('T')[0],
                    market: myTrade.slug || 'Unknown',
                    traderPrice: traderTrade.price,
                    myPrice: myTrade.price,
                    slippageCents,
                    slippagePercent,
                });

                break; // Found the trader, stop searching
            }
        }
    }

    if (slippageData.length === 0) {
        console.log('❌ No matching trader trades found to compare slippage\n');
        await mongoose.disconnect();
        return;
    }

    // Sort by slippage (worst first)
    slippageData.sort((a, b) => b.slippagePercent - a.slippagePercent);

    console.log('📈 SLIPPAGE BY TRADE (Top 20 worst):\n');
    console.log(
        'Date       | Market                              | Trader → You    | Slippage'
    );
    console.log('-'.repeat(100));

    for (const data of slippageData.slice(0, 20)) {
        const marketShort = data.market.substring(0, 35).padEnd(35);
        const priceStr = `$${data.traderPrice.toFixed(3)} → $${data.myPrice.toFixed(3)}`;
        const slippageStr = `+$${data.slippageCents.toFixed(3)} (+${data.slippagePercent.toFixed(1)}%)`;

        console.log(
            `${data.date} | ${marketShort} | ${priceStr.padEnd(15)} | ${slippageStr}`
        );
    }

    console.log('');
    console.log('═'.repeat(70));
    console.log('📊 SUMMARY STATISTICS');
    console.log('═'.repeat(70));

    const avgSlippageCents =
        slippageData.reduce((sum, d) => sum + d.slippageCents, 0) / slippageData.length;
    const avgSlippagePercent =
        slippageData.reduce((sum, d) => sum + d.slippagePercent, 0) / slippageData.length;
    const maxSlippageCents = Math.max(...slippageData.map((d) => d.slippageCents));
    const maxSlippagePercent = Math.max(...slippageData.map((d) => d.slippagePercent));
    const minSlippageCents = Math.min(...slippageData.map((d) => d.slippageCents));

    console.log('');
    console.log(`Total Trades Analyzed: ${slippageData.length}`);
    console.log('');
    console.log(`Average Slippage: $${avgSlippageCents.toFixed(3)} (${avgSlippagePercent.toFixed(2)}%)`);
    console.log(`Max Slippage: $${maxSlippageCents.toFixed(3)} (${maxSlippagePercent.toFixed(2)}%)`);
    console.log(`Min Slippage: $${minSlippageCents.toFixed(3)}`);
    console.log('');

    // Rating
    if (avgSlippagePercent < 1) {
        console.log('✅ EXCELLENT - Your slippage is very low!');
    } else if (avgSlippagePercent < 2) {
        console.log('✅ GOOD - Your slippage is acceptable for copy trading');
    } else if (avgSlippagePercent < 3) {
        console.log('⚠️  MODERATE - Consider reducing MAX_ORDER_SIZE_USD');
    } else {
        console.log('❌ HIGH - Slippage is eating into your profits');
        console.log('   → Reduce MAX_ORDER_SIZE_USD from $80 to $30-40');
        console.log('   → Or copy traders who trade smaller sizes');
    }

    console.log('');
    console.log('═'.repeat(70));

    await mongoose.disconnect();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
