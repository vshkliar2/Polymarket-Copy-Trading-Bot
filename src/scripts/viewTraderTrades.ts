import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import mongoose from 'mongoose';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const MONGO_URI = ENV.MONGO_URI;

async function main() {
    await mongoose.connect(MONGO_URI as string);

    console.log('');
    console.log('═'.repeat(80));
    console.log('👤 TRADER TRANSACTION VIEWER');
    console.log('═'.repeat(80));
    console.log('');

    // Check which trader to view (default: first one)
    const traderAddress = process.argv[2] || USER_ADDRESSES[0];

    if (!traderAddress) {
        console.log('❌ No trader address provided');
        console.log('Usage: npm run view-trader <address>');
        await mongoose.disconnect();
        return;
    }

    console.log(`Trader: ${traderAddress}`);
    console.log('');

    const TraderActivity = getUserActivityModel(traderAddress);

    // Get recent trades (last 50)
    const trades = await TraderActivity.find({})
        .sort({ timestamp: -1 })
        .limit(50);

    if (trades.length === 0) {
        console.log('❌ No trades found for this trader');
        console.log('');
        console.log('Possible reasons:');
        console.log('  1. Bot hasn\'t fetched trades yet (run bot first)');
        console.log('  2. Trader hasn\'t made any trades recently');
        console.log('  3. Wrong address');
        await mongoose.disconnect();
        return;
    }

    console.log(`📊 Found ${trades.length} recent trades\n`);
    console.log('═'.repeat(80));

    // Group by BUY and SELL
    const buyTrades = trades.filter((t) => t.side === 'BUY');
    const sellTrades = trades.filter((t) => t.side === 'SELL');

    console.log(`🟢 BUY Trades: ${buyTrades.length}`);
    console.log(`🔴 SELL Trades: ${sellTrades.length}`);
    console.log('');

    // Show last 20 trades
    console.log('═'.repeat(80));
    console.log('RECENT TRADES (Last 20)');
    console.log('═'.repeat(80));
    console.log('');
    console.log(
        'Date & Time          | Side | Amount    | Price   | Market'
    );
    console.log('-'.repeat(80));

    for (const trade of trades.slice(0, 20)) {
        const date = new Date((trade.timestamp || 0) * 1000).toISOString().replace('T', ' ').substring(0, 19);
        const side = trade.side === 'BUY' ? '🟢 BUY ' : '🔴 SELL';
        const amount = `$${(trade.usdcSize || 0).toFixed(2)}`.padEnd(9);
        const price = `$${(trade.price || 0).toFixed(3)}`;
        const market = (trade.slug || 'Unknown').substring(0, 35);

        console.log(`${date} | ${side} | ${amount} | ${price} | ${market}`);
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('📈 STATISTICS');
    console.log('═'.repeat(80));

    const totalBuyVolume = buyTrades.reduce((sum, t) => sum + (t.usdcSize || 0), 0);
    const totalSellVolume = sellTrades.reduce((sum, t) => sum + (t.usdcSize || 0), 0);
    const avgBuySize = buyTrades.length > 0 ? totalBuyVolume / buyTrades.length : 0;
    const avgSellSize = sellTrades.length > 0 ? totalSellVolume / sellTrades.length : 0;
    const avgBuyPrice = buyTrades.length > 0
        ? buyTrades.reduce((sum, t) => sum + (t.price || 0), 0) / buyTrades.length
        : 0;

    console.log('');
    console.log(`Total Buy Volume:  $${totalBuyVolume.toFixed(2)}`);
    console.log(`Total Sell Volume: $${totalSellVolume.toFixed(2)}`);
    console.log(`Net Volume:        $${(totalBuyVolume - totalSellVolume).toFixed(2)}`);
    console.log('');
    console.log(`Average Buy Size:  $${avgBuySize.toFixed(2)}`);
    console.log(`Average Sell Size: $${avgSellSize.toFixed(2)}`);
    console.log(`Average Buy Price: $${avgBuyPrice.toFixed(3)}`);
    console.log('');

    // Find most traded markets
    const marketCounts: Record<string, number> = {};
    trades.forEach((trade) => {
        const market = trade.slug || 'Unknown';
        marketCounts[market] = (marketCounts[market] || 0) + 1;
    });

    const topMarkets = Object.entries(marketCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    console.log('Top 5 Most Traded Markets:');
    topMarkets.forEach(([market, count], index) => {
        console.log(`  ${index + 1}. ${market.substring(0, 50)} (${count} trades)`);
    });

    console.log('');
    console.log('═'.repeat(80));
    console.log('');
    console.log('💡 Tips:');
    console.log('  • To view different trader: npm run view-trader <address>');
    console.log('  • To see all traders: check your .env USER_ADDRESSES');
    console.log('  • To see live data: visit polymarket.com/profile/<address>');
    console.log('');
    console.log('═'.repeat(80));

    await mongoose.disconnect();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
