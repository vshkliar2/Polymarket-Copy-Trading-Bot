import fetchData from '../utils/fetchData';
import MY_EOA_ADDRESS from '../utils/getMyEOA';

// data-api's /activity endpoint is keyed by the signing EOA address, not
// PROXY_WALLET — see src/utils/getMyEOA.ts.
const WALLET = MY_EOA_ADDRESS;

interface Activity {
    proxyWallet: string;
    timestamp: number;
    conditionId: string;
    type: string;
    size: number;
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: 'BUY' | 'SELL';
    title?: string;
    market?: string;
}

const main = async () => {
    const url = `https://data-api.polymarket.com/activity?user=${WALLET}&type=TRADE`;
    const activities: Activity[] = await fetchData(url);

    if (!Array.isArray(activities) || activities.length === 0) {
        console.log('No trade data available');
        return;
    }

    // Redemption ended at 18:14:16 UTC (October 31, 2025)
    const redemptionEndTime = new Date('2025-10-31T18:14:16Z').getTime() / 1000;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📋 CLOSED POSITIONS (Redeemed October 31, 2025 at 18:00-18:14)');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log('💰 TOTAL RECEIVED FROM REDEMPTION: $66.37 USDC\n');

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🛒 PURCHASES AFTER REDEMPTION (after 18:14 UTC October 31)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const tradesAfterRedemption = activities.filter(
        (t) => t.timestamp > redemptionEndTime && t.side === 'BUY'
    );

    if (tradesAfterRedemption.length === 0) {
        console.log('✅ No purchases after redemption!\n');
        console.log('This means funds should be in the balance.');
        return;
    }

    let totalSpent = 0;

    tradesAfterRedemption.forEach((trade, i) => {
        const date = new Date(trade.timestamp * 1000);
        const value = trade.usdcSize;
        totalSpent += value;

        console.log(`${i + 1}. 🟢 BOUGHT: ${trade.title || trade.market || 'Unknown'}`);
        console.log(`   💸 Spent: $${value.toFixed(2)}`);
        console.log(`   📊 Size: ${trade.size.toFixed(2)} tokens @ $${trade.price.toFixed(4)}`);
        console.log(`   📅 Date: ${date.toLocaleString('en-US')}`);
        console.log(
            `   🔗 TX: https://polygonscan.com/tx/${trade.transactionHash.substring(0, 20)}...\n`
        );
    });

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📊 TOTAL PURCHASES AFTER REDEMPTION:');
    console.log(`   Number of trades: ${tradesAfterRedemption.length}`);
    console.log(`   💸 SPENT: $${totalSpent.toFixed(2)} USDC`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('💡 EXPLANATION OF WHERE THE MONEY WENT:\n');
    console.log(`   ✅ Received from redemption: +$66.37`);
    console.log(`   ❌ Spent on new purchases: -$${totalSpent.toFixed(2)}`);
    console.log(`   📊 Balance change: $${(66.37 - totalSpent).toFixed(2)}`);
    console.log('\n═══════════════════════════════════════════════════════════════\n');

    // Show recent sales too
    console.log('💵 RECENT SALES:\n');
    const recentSells = activities.filter((t) => t.side === 'SELL').slice(0, 10);

    let totalSold = 0;
    recentSells.forEach((trade, i) => {
        const date = new Date(trade.timestamp * 1000);
        const value = trade.usdcSize;
        totalSold += value;

        console.log(`${i + 1}. 🔴 SOLD: ${trade.title || trade.market || 'Unknown'}`);
        console.log(`   💰 Received: $${value.toFixed(2)}`);
        console.log(`   📅 Date: ${date.toLocaleString('en-US')}\n`);
    });

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`💵 Sold in recent trades: $${totalSold.toFixed(2)}`);
    console.log('═══════════════════════════════════════════════════════════════');
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
