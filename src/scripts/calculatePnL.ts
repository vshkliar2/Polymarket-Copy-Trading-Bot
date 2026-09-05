import { ENV } from '../config/env';
import publicClient from '../utils/publicClient';
import getMyBalance from '../utils/getMyBalance';
import MY_EOA_ADDRESS from '../utils/getMyEOA';

const PROXY_WALLET = ENV.PROXY_WALLET;

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
    slug?: string;
    outcome?: string;
}

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
    redeemable: boolean;
    title?: string;
    slug?: string;
    outcome?: string;
}

interface PnLSummary {
    totalInvested: number;
    currentPortfolioValue: number;
    usdcBalance: number;
    totalBalance: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    totalPnlPercent: number;
    openPositions: number;
    closedPositions: number;
    totalTrades: number;
    buyVolume: number;
    sellVolume: number;
    netVolume: number;
}

const calculatePnL = async (): Promise<void> => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💰 ALL-TIME PROFIT & LOSS CALCULATOR');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`Wallet: ${PROXY_WALLET}\n`);

    try {
        // Fetch all data
        console.log('📊 Fetching data from Polymarket API...\n');

        const [openPositions, closedPositions, activities, usdcBalance] = await Promise.all([
            publicClient.getPositions(MY_EOA_ADDRESS) as unknown as Promise<Position[]>,
            publicClient.getClosedPositions(MY_EOA_ADDRESS) as unknown as Promise<Position[]>,
            publicClient.getTradeActivity(MY_EOA_ADDRESS) as unknown as Promise<Activity[]>,
            getMyBalance(PROXY_WALLET),
        ]);

        // Use the data directly - API already separates them
        const positions = [...openPositions, ...closedPositions];

        // Calculate unrealized P&L from open positions
        let unrealizedPnl = 0;
        let openPositionsValue = 0;
        let openPositionsInitial = 0;

        openPositions.forEach((pos) => {
            unrealizedPnl += pos.cashPnl || 0;
            openPositionsValue += pos.currentValue || 0;
            openPositionsInitial += pos.initialValue || 0;
        });

        // Calculate realized P&L from all positions (open + closed)
        let realizedPnlFromPositions = 0;
        positions.forEach((pos) => {
            realizedPnlFromPositions += pos.realizedPnl || 0;
        });

        // Calculate from trade history (alternative method for verification)
        const buyTrades = activities.filter((a) => a.side === 'BUY');
        const sellTrades = activities.filter((a) => a.side === 'SELL');
        const totalBuyVolume = buyTrades.reduce((sum, t) => sum + t.usdcSize, 0);
        const totalSellVolume = sellTrades.reduce((sum, t) => sum + t.usdcSize, 0);

        // Total invested = all buys - all sells + current open positions initial value
        const totalInvested = totalBuyVolume - totalSellVolume + openPositionsInitial;

        // Current portfolio value = open positions + USDC balance
        const currentPortfolioValue = openPositionsValue;
        const totalBalance = currentPortfolioValue + usdcBalance;

        // Total P&L = Realized + Unrealized
        const totalPnl = realizedPnlFromPositions + unrealizedPnl;

        // Calculate P&L percentage
        const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

        const summary: PnLSummary = {
            totalInvested,
            currentPortfolioValue,
            usdcBalance,
            totalBalance,
            realizedPnl: realizedPnlFromPositions,
            unrealizedPnl,
            totalPnl,
            totalPnlPercent,
            openPositions: openPositions.length,
            closedPositions: closedPositions.length,
            totalTrades: activities.length,
            buyVolume: totalBuyVolume,
            sellVolume: totalSellVolume,
            netVolume: totalBuyVolume + totalSellVolume,
        };

        // Display results
        displayPnLSummary(summary);
        displayOpenPositionsBreakdown(openPositions);
        displayClosedPositionsBreakdown(closedPositions);
        displayTradingActivity(activities);
        displayTopPerformers(openPositions, closedPositions);

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('✅ P&L calculation completed!\n');
        console.log(`📱 View your profile: https://polymarket.com/profile/${PROXY_WALLET}\n`);
    } catch (error) {
        console.error('❌ Error calculating P&L:', error);
        process.exit(1);
    }
};

const displayPnLSummary = (summary: PnLSummary): void => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📈 ALL-TIME P&L SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Portfolio overview
    console.log('💼 PORTFOLIO OVERVIEW:');
    console.log(`   • USDC Balance:              $${summary.usdcBalance.toFixed(2)}`);
    console.log(`   • Open Positions Value:      $${summary.currentPortfolioValue.toFixed(2)}`);
    console.log(`   • Total Balance:             $${summary.totalBalance.toFixed(2)}`);
    console.log(`   • Total Invested:            $${summary.totalInvested.toFixed(2)}\n`);

    // P&L breakdown
    console.log('💰 PROFIT & LOSS:');
    const realizedIcon = summary.realizedPnl >= 0 ? '✅' : '❌';
    const unrealizedIcon = summary.unrealizedPnl >= 0 ? '📈' : '📉';
    const totalIcon = summary.totalPnl >= 0 ? '🎉' : '⚠️';

    console.log(`   ${realizedIcon} Realized P&L:           $${summary.realizedPnl.toFixed(2)}`);
    console.log(
        `   ${unrealizedIcon} Unrealized P&L:         $${summary.unrealizedPnl.toFixed(2)}`
    );
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
        `   ${totalIcon} TOTAL P&L:              $${summary.totalPnl.toFixed(2)} (${summary.totalPnlPercent >= 0 ? '+' : ''}${summary.totalPnlPercent.toFixed(2)}%)\n`
    );

    // Trading activity
    console.log('📊 TRADING ACTIVITY:');
    console.log(`   • Total Trades:              ${summary.totalTrades}`);
    console.log(`   • Open Positions:            ${summary.openPositions}`);
    console.log(`   • Closed Positions:          ${summary.closedPositions}`);
    console.log(`   • Buy Volume:                $${summary.buyVolume.toFixed(2)}`);
    console.log(`   • Sell Volume:               $${summary.sellVolume.toFixed(2)}`);
    console.log(`   • Total Volume:              $${summary.netVolume.toFixed(2)}\n`);
};

const displayOpenPositionsBreakdown = (positions: Position[]): void => {
    if (positions.length === 0) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 OPEN POSITIONS: None\n');
        return;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 OPEN POSITIONS (${positions.length}):`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let totalValue = 0;
    let totalInitial = 0;
    let totalUnrealized = 0;

    positions.forEach((pos, idx) => {
        totalValue += pos.currentValue || 0;
        totalInitial += pos.initialValue || 0;
        totalUnrealized += pos.cashPnl || 0;

        const pnlIcon = (pos.percentPnl || 0) >= 0 ? '📈' : '📉';
        console.log(`${idx + 1}. ${pnlIcon} ${pos.title || 'Unknown Market'}`);
        console.log(`   Outcome: ${pos.outcome || 'N/A'}`);
        console.log(
            `   Size: ${(pos.size || 0).toFixed(2)} tokens @ avg $${(pos.avgPrice || 0).toFixed(3)}`
        );
        console.log(`   Current Price: $${(pos.curPrice || 0).toFixed(3)}`);
        console.log(`   Initial Value: $${(pos.initialValue || 0).toFixed(2)}`);
        console.log(`   Current Value: $${(pos.currentValue || 0).toFixed(2)}`);
        console.log(
            `   P&L: $${(pos.cashPnl || 0).toFixed(2)} (${(pos.percentPnl || 0).toFixed(2)}%)`
        );
        if (pos.realizedPnl && Math.abs(pos.realizedPnl) > 0.01) {
            console.log(`   Realized P&L: $${pos.realizedPnl.toFixed(2)}`);
        }
        if (pos.slug) {
            console.log(`   🔗 https://polymarket.com/event/${pos.slug}`);
        }
        console.log('');
    });

    console.log(`TOTALS:`);
    console.log(`   • Initial Value: $${totalInitial.toFixed(2)}`);
    console.log(`   • Current Value: $${totalValue.toFixed(2)}`);
    console.log(
        `   • Unrealized P&L: $${totalUnrealized.toFixed(2)} (${totalInitial > 0 ? ((totalUnrealized / totalInitial) * 100).toFixed(2) : '0.00'}%)\n`
    );
};

const displayClosedPositionsBreakdown = (positions: Position[]): void => {
    if (positions.length === 0) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ CLOSED POSITIONS: None\n');
        return;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ CLOSED POSITIONS (${positions.length}):`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let totalRealized = 0;
    let totalInitial = 0;

    positions.forEach((pos, idx) => {
        totalRealized += pos.realizedPnl || 0;
        totalInitial += pos.initialValue || 0;

        const pnlIcon = (pos.realizedPnl || 0) >= 0 ? '✅' : '❌';
        console.log(`${idx + 1}. ${pnlIcon} ${pos.title || 'Unknown Market'}`);
        console.log(`   Outcome: ${pos.outcome || 'N/A'}`);
        console.log(`   Initial Value: $${(pos.initialValue || 0).toFixed(2)}`);
        console.log(
            `   Realized P&L: $${(pos.realizedPnl || 0).toFixed(2)} (${(pos.percentRealizedPnl || 0).toFixed(2)}%)`
        );
        if (pos.redeemable) {
            console.log(`   ⚠️  Redeemable - run 'npm run redeem-resolved' to claim winnings`);
        }
        if (pos.slug) {
            console.log(`   🔗 https://polymarket.com/event/${pos.slug}`);
        }
        console.log('');
    });

    console.log(`TOTALS:`);
    console.log(`   • Initial Value: $${totalInitial.toFixed(2)}`);
    console.log(
        `   • Realized P&L: $${totalRealized.toFixed(2)} (${totalInitial > 0 ? ((totalRealized / totalInitial) * 100).toFixed(2) : '0.00'}%)\n`
    );
};

const displayTradingActivity = (activities: Activity[]): void => {
    if (activities.length === 0) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📜 RECENT TRADES: None\n');
        return;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📜 RECENT TRADES (Last 10 of ${activities.length}):`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const recentTrades = activities.slice(0, 10);

    recentTrades.forEach((trade, idx) => {
        const date = new Date((trade.timestamp || 0) * 1000);
        const sideIcon = trade.side === 'BUY' ? '🟢' : '🔴';
        console.log(`${idx + 1}. ${sideIcon} ${trade.side} - ${date.toLocaleString('en-US')}`);
        console.log(`   ${trade.title || 'Unknown Market'}`);
        console.log(`   ${trade.outcome || 'N/A'}`);
        console.log(
            `   Volume: $${(trade.usdcSize || 0).toFixed(2)} @ $${(trade.price || 0).toFixed(3)}`
        );
        if (trade.transactionHash) {
            console.log(
                `   TX: ${trade.transactionHash.slice(0, 10)}...${trade.transactionHash.slice(-8)}`
            );
            console.log(`   🔗 https://polygonscan.com/tx/${trade.transactionHash}`);
        }
        console.log('');
    });
};

const displayTopPerformers = (openPositions: Position[], closedPositions: Position[]): void => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🏆 TOP PERFORMERS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Top 5 open positions by P&L percentage
    const topOpen = [...openPositions]
        .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
        .slice(0, 5);

    if (topOpen.length > 0) {
        console.log('📈 Top Open Positions by P&L %:\n');
        topOpen.forEach((pos, idx) => {
            const pnlIcon = (pos.percentPnl || 0) >= 0 ? '📈' : '📉';
            console.log(
                `   ${idx + 1}. ${pnlIcon} ${(pos.percentPnl || 0).toFixed(2)}% - ${pos.title || 'Unknown'}`
            );
            console.log(`      ${pos.outcome || 'N/A'}`);
            console.log(
                `      P&L: $${(pos.cashPnl || 0).toFixed(2)} (${(pos.percentPnl || 0).toFixed(2)}%)`
            );
            console.log('');
        });
    }

    // Top 5 closed positions by realized P&L
    const topClosed = [...closedPositions]
        .sort((a, b) => (b.realizedPnl || 0) - (a.realizedPnl || 0))
        .slice(0, 5);

    if (topClosed.length > 0) {
        console.log('✅ Top Closed Positions by Realized P&L:\n');
        topClosed.forEach((pos, idx) => {
            const pnlIcon = (pos.realizedPnl || 0) >= 0 ? '✅' : '❌';
            console.log(
                `   ${idx + 1}. ${pnlIcon} $${(pos.realizedPnl || 0).toFixed(2)} - ${pos.title || 'Unknown'}`
            );
            console.log(`      ${pos.outcome || 'N/A'}`);
            console.log(
                `      P&L: $${(pos.realizedPnl || 0).toFixed(2)} (${(pos.percentRealizedPnl || 0).toFixed(2)}%)`
            );
            console.log('');
        });
    }

    // Worst 5 positions (all combined)
    const allPositions = [
        ...openPositions.map((p) => ({
            ...p,
            pnl: p.cashPnl || 0,
            percent: p.percentPnl || 0,
            type: 'open',
        })),
        ...closedPositions.map((p) => ({
            ...p,
            pnl: p.realizedPnl || 0,
            percent: p.percentRealizedPnl || 0,
            type: 'closed',
        })),
    ];
    const worstPositions = [...allPositions]
        .sort((a, b) => a.pnl - b.pnl)
        .slice(0, 5)
        .filter((p) => p.pnl < 0);

    if (worstPositions.length > 0) {
        console.log('📉 Worst Performing Positions:\n');
        worstPositions.forEach((pos, idx) => {
            const typeIcon = pos.type === 'open' ? '📊' : '✅';
            console.log(
                `   ${idx + 1}. ${typeIcon} $${pos.pnl.toFixed(2)} - ${pos.title || 'Unknown'} (${pos.type})`
            );
            console.log(`      ${pos.outcome || 'N/A'}`);
            console.log(`      P&L: $${pos.pnl.toFixed(2)} (${pos.percent.toFixed(2)}%)`);
            console.log('');
        });
    }
};

calculatePnL();
