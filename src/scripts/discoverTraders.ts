/**
 * Trader Discovery & Analysis Script
 *
 * This script helps you find and evaluate profitable traders to copy.
 * It analyzes the Polymarket leaderboard, calculates performance metrics,
 * and scores traders based on multiple criteria.
 *
 * Usage:
 *   npm run discover-traders
 *   npm run discover-traders -- --min-pnl=10000 --min-winrate=60
 */

import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface LeaderboardEntry {
    address: string;
    username?: string;
    total_pnl: number;
    total_volume: number;
    markets_traded: number;
    win_rate?: number;
    average_position_size?: number;
    largest_win?: number;
    largest_loss?: number;
    recent_activity?: boolean;
}

interface TraderPosition {
    conditionId: string;
    asset: string;
    title: string;
    size: number;
    currentValue: number;
    initialValue: number;
    cashPnl: number;
    percentPnl: number;
}

interface TraderTrade {
    timestamp: number;
    market: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
}

interface TraderScore {
    address: string;
    username?: string;
    totalScore: number;
    scores: {
        profitability: number;     // 0-25 points
        consistency: number;        // 0-25 points
        activity: number;           // 0-20 points
        riskManagement: number;     // 0-15 points
        diversification: number;    // 0-15 points
    };
    metrics: {
        totalPnl: number;
        winRate: number;
        marketsTraded: number;
        avgPositionSize: number;
        sharpeRatio?: number;
        maxDrawdown?: number;
        profitFactor?: number;
    };
    recommendation: 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'POOR' | 'AVOID';
    reasons: string[];
}

interface DiscoveryOptions {
    minPnl?: number;              // Minimum total PnL
    minWinRate?: number;          // Minimum win rate (%)
    minMarketsTraded?: number;    // Minimum number of markets
    minVolume?: number;           // Minimum total volume
    maxDaysSinceActive?: number;  // Maximum days since last trade
    limit?: number;               // Number of traders to analyze
    whalesOnly?: boolean;         // Only find whale traders (>$100k volume)
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Fetch leaderboard data from Polymarket
 */
async function fetchLeaderboard(limit: number = 100): Promise<LeaderboardEntry[]> {
    try {
        const url = `https://data-api.polymarket.com/leaderboard?window=all&limit=${limit}`;
        Logger.info(`Fetching leaderboard (top ${limit})...`);

        const data = await fetchData(url) as any[];

        return data.map((entry: any) => ({
            address: entry.user || entry.address,
            username: entry.username || undefined,
            total_pnl: parseFloat(entry.total_pnl || entry.pnl || 0),
            total_volume: parseFloat(entry.total_volume || entry.volume || 0),
            markets_traded: parseInt(entry.markets_traded || entry.markets || 0),
        }));
    } catch (error) {
        Logger.error(`Failed to fetch leaderboard: ${error}`);
        return [];
    }
}

/**
 * Fetch trader's positions
 */
async function fetchTraderPositions(address: string): Promise<TraderPosition[]> {
    try {
        const url = `https://data-api.polymarket.com/positions?user=${address}`;
        const data = await fetchData(url) as any[];

        if (!Array.isArray(data)) {
            return [];
        }

        return data.map((pos: any) => ({
            conditionId: pos.conditionId,
            asset: pos.asset,
            title: pos.title,
            size: parseFloat(pos.size || 0),
            currentValue: parseFloat(pos.currentValue || 0),
            initialValue: parseFloat(pos.initialValue || 0),
            cashPnl: parseFloat(pos.cashPnl || 0),
            percentPnl: parseFloat(pos.percentPnl || 0),
        }));
    } catch (error) {
        Logger.error(`Failed to fetch positions for ${address}: ${error}`);
        return [];
    }
}

/**
 * Fetch trader's recent trades
 */
async function fetchTraderTrades(address: string, limit: number = 100): Promise<TraderTrade[]> {
    try {
        const url = `https://data-api.polymarket.com/trades?user=${address}&limit=${limit}`;
        const data = await fetchData(url) as any[];

        if (!Array.isArray(data)) {
            return [];
        }

        return data.map((trade: any) => ({
            timestamp: parseInt(trade.timestamp || 0),
            market: trade.market || trade.title || 'Unknown',
            side: (trade.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
            size: parseFloat(trade.size || 0),
            price: parseFloat(trade.price || 0),
        }));
    } catch (error) {
        Logger.error(`Failed to fetch trades for ${address}: ${error}`);
        return [];
    }
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Calculate trader metrics from positions and trades
 */
function calculateTraderMetrics(
    positions: TraderPosition[],
    trades: TraderTrade[]
): {
    winRate: number;
    avgPositionSize: number;
    profitFactor: number;
    maxDrawdown: number;
    daysSinceLastTrade: number;
    totalProfitablePositions: number;
    totalLosingPositions: number;
} {
    // Win rate calculation
    const profitablePositions = positions.filter(p => p.cashPnl > 0).length;
    const losingPositions = positions.filter(p => p.cashPnl < 0).length;
    const totalPositions = profitablePositions + losingPositions;
    const winRate = totalPositions > 0 ? (profitablePositions / totalPositions) * 100 : 0;

    // Average position size
    const avgPositionSize = positions.length > 0
        ? positions.reduce((sum, p) => sum + p.initialValue, 0) / positions.length
        : 0;

    // Profit factor (total profits / total losses)
    const totalProfits = positions
        .filter(p => p.cashPnl > 0)
        .reduce((sum, p) => sum + p.cashPnl, 0);
    const totalLosses = Math.abs(
        positions
            .filter(p => p.cashPnl < 0)
            .reduce((sum, p) => sum + p.cashPnl, 0)
    );
    const profitFactor = totalLosses > 0 ? totalProfits / totalLosses : totalProfits > 0 ? 999 : 0;

    // Max drawdown estimation (simplified)
    const maxLoss = positions.length > 0
        ? Math.min(...positions.map(p => p.cashPnl), 0)
        : 0;
    const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
    const maxDrawdown = totalValue > 0 ? Math.abs(maxLoss / totalValue) * 100 : 0;

    // Days since last trade
    const lastTradeTimestamp = trades.length > 0
        ? Math.max(...trades.map(t => t.timestamp))
        : 0;
    const daysSinceLastTrade = lastTradeTimestamp > 0
        ? (Date.now() - lastTradeTimestamp * 1000) / (1000 * 60 * 60 * 24)
        : 999;

    return {
        winRate,
        avgPositionSize,
        profitFactor,
        maxDrawdown,
        daysSinceLastTrade,
        totalProfitablePositions: profitablePositions,
        totalLosingPositions: losingPositions,
    };
}

/**
 * Score a trader based on multiple criteria (0-100 points)
 */
function scoreTrader(
    entry: LeaderboardEntry,
    positions: TraderPosition[],
    trades: TraderTrade[]
): TraderScore {
    const metrics = calculateTraderMetrics(positions, trades);

    const scores = {
        profitability: 0,     // 0-25 points
        consistency: 0,       // 0-25 points
        activity: 0,          // 0-20 points
        riskManagement: 0,    // 0-15 points
        diversification: 0,   // 0-15 points
    };

    const reasons: string[] = [];

    // 1. Profitability Score (0-25)
    if (entry.total_pnl > 100000) {
        scores.profitability = 25;
        reasons.push('💰 Exceptional profits ($100k+)');
    } else if (entry.total_pnl > 50000) {
        scores.profitability = 20;
        reasons.push('💰 High profits ($50k+)');
    } else if (entry.total_pnl > 20000) {
        scores.profitability = 15;
        reasons.push('💵 Good profits ($20k+)');
    } else if (entry.total_pnl > 10000) {
        scores.profitability = 10;
        reasons.push('💵 Moderate profits ($10k+)');
    } else if (entry.total_pnl > 5000) {
        scores.profitability = 5;
        reasons.push('💵 Small profits ($5k+)');
    } else if (entry.total_pnl < 0) {
        scores.profitability = 0;
        reasons.push('❌ Negative total PnL');
    }

    // 2. Consistency Score (0-25)
    if (metrics.winRate >= 70) {
        scores.consistency = 25;
        reasons.push(`🎯 Excellent win rate (${metrics.winRate.toFixed(1)}%)`);
    } else if (metrics.winRate >= 60) {
        scores.consistency = 20;
        reasons.push(`🎯 Good win rate (${metrics.winRate.toFixed(1)}%)`);
    } else if (metrics.winRate >= 55) {
        scores.consistency = 15;
        reasons.push(`✅ Above-average win rate (${metrics.winRate.toFixed(1)}%)`);
    } else if (metrics.winRate >= 50) {
        scores.consistency = 10;
        reasons.push(`⚖️ Average win rate (${metrics.winRate.toFixed(1)}%)`);
    } else {
        scores.consistency = 0;
        reasons.push(`⚠️ Below-average win rate (${metrics.winRate.toFixed(1)}%)`);
    }

    // Profit factor bonus
    if (metrics.profitFactor > 3.0) {
        scores.consistency = Math.min(25, scores.consistency + 5);
        reasons.push(`📈 Excellent profit factor (${metrics.profitFactor.toFixed(2)})`);
    } else if (metrics.profitFactor > 2.0) {
        scores.consistency = Math.min(25, scores.consistency + 3);
    }

    // 3. Activity Score (0-20)
    if (metrics.daysSinceLastTrade <= 1) {
        scores.activity = 20;
        reasons.push('🔥 Very active (traded today)');
    } else if (metrics.daysSinceLastTrade <= 3) {
        scores.activity = 15;
        reasons.push('✅ Active (traded this week)');
    } else if (metrics.daysSinceLastTrade <= 7) {
        scores.activity = 10;
        reasons.push('📊 Moderately active');
    } else if (metrics.daysSinceLastTrade <= 30) {
        scores.activity = 5;
        reasons.push('⏰ Low activity (last trade >1 week ago)');
    } else {
        scores.activity = 0;
        reasons.push('❌ Inactive (no recent trades)');
    }

    // 4. Risk Management Score (0-15)
    if (metrics.maxDrawdown < 10) {
        scores.riskManagement = 15;
        reasons.push(`🛡️ Excellent risk control (${metrics.maxDrawdown.toFixed(1)}% max DD)`);
    } else if (metrics.maxDrawdown < 20) {
        scores.riskManagement = 10;
        reasons.push(`✅ Good risk control (${metrics.maxDrawdown.toFixed(1)}% max DD)`);
    } else if (metrics.maxDrawdown < 35) {
        scores.riskManagement = 5;
        reasons.push(`⚠️ Moderate risk (${metrics.maxDrawdown.toFixed(1)}% max DD)`);
    } else {
        scores.riskManagement = 0;
        reasons.push(`🚨 High risk (${metrics.maxDrawdown.toFixed(1)}% max DD)`);
    }

    // 5. Diversification Score (0-15)
    if (entry.markets_traded >= 100) {
        scores.diversification = 15;
        reasons.push(`🌐 Highly diversified (${entry.markets_traded} markets)`);
    } else if (entry.markets_traded >= 50) {
        scores.diversification = 12;
        reasons.push(`🌐 Well diversified (${entry.markets_traded} markets)`);
    } else if (entry.markets_traded >= 25) {
        scores.diversification = 8;
        reasons.push(`📊 Moderately diversified (${entry.markets_traded} markets)`);
    } else if (entry.markets_traded >= 10) {
        scores.diversification = 4;
        reasons.push(`⚠️ Limited diversification (${entry.markets_traded} markets)`);
    } else {
        scores.diversification = 0;
        reasons.push(`🚨 Very concentrated (${entry.markets_traded} markets)`);
    }

    const totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);

    // Determine recommendation
    let recommendation: TraderScore['recommendation'];
    if (totalScore >= 80) {
        recommendation = 'EXCELLENT';
    } else if (totalScore >= 65) {
        recommendation = 'GOOD';
    } else if (totalScore >= 50) {
        recommendation = 'AVERAGE';
    } else if (totalScore >= 35) {
        recommendation = 'POOR';
    } else {
        recommendation = 'AVOID';
    }

    return {
        address: entry.address,
        username: entry.username,
        totalScore,
        scores,
        metrics: {
            totalPnl: entry.total_pnl,
            winRate: metrics.winRate,
            marketsTraded: entry.markets_traded,
            avgPositionSize: metrics.avgPositionSize,
            profitFactor: metrics.profitFactor,
            maxDrawdown: metrics.maxDrawdown,
        },
        recommendation,
        reasons,
    };
}

/**
 * Filter traders based on options
 */
function filterTraders(
    entries: LeaderboardEntry[],
    options: DiscoveryOptions
): LeaderboardEntry[] {
    let filtered = entries;

    if (options.minPnl) {
        filtered = filtered.filter(e => e.total_pnl >= options.minPnl!);
    }

    if (options.minMarketsTraded) {
        filtered = filtered.filter(e => e.markets_traded >= options.minMarketsTraded!);
    }

    if (options.minVolume) {
        filtered = filtered.filter(e => e.total_volume >= options.minVolume!);
    }

    if (options.whalesOnly) {
        filtered = filtered.filter(e => e.total_volume >= 100000);
    }

    return filtered;
}

// ============================================================================
// MAIN DISCOVERY FUNCTION
// ============================================================================

/**
 * Discover and analyze traders
 */
export async function discoverTraders(options: DiscoveryOptions = {}): Promise<TraderScore[]> {
    const defaults: DiscoveryOptions = {
        minPnl: 5000,
        minWinRate: 50,
        minMarketsTraded: 10,
        minVolume: 10000,
        maxDaysSinceActive: 30,
        limit: 50,
        whalesOnly: false,
    };

    const opts = { ...defaults, ...options };

    Logger.header('🔍 TRADER DISCOVERY SYSTEM');
    Logger.info(`Analyzing top ${opts.limit} traders from leaderboard...`);
    Logger.info('');

    // Step 1: Fetch leaderboard
    const leaderboard = await fetchLeaderboard(opts.limit);

    if (leaderboard.length === 0) {
        Logger.error('Failed to fetch leaderboard data');
        return [];
    }

    Logger.success(`✅ Found ${leaderboard.length} traders on leaderboard`);

    // Step 2: Filter traders
    const filtered = filterTraders(leaderboard, opts);
    Logger.info(`📊 ${filtered.length} traders match your criteria`);
    Logger.info('');

    // Step 3: Analyze each trader in detail
    Logger.info('🔬 Analyzing traders in detail...');
    Logger.info('');

    const scores: TraderScore[] = [];

    for (let i = 0; i < Math.min(filtered.length, 20); i++) {
        const entry = filtered[i]!;

        Logger.info(`[${i + 1}/${Math.min(filtered.length, 20)}] Analyzing ${entry.address.substring(0, 10)}...`);

        // Fetch detailed data
        const [positions, trades] = await Promise.all([
            fetchTraderPositions(entry.address),
            fetchTraderTrades(entry.address, 100),
        ]);

        // Score the trader
        const score = scoreTrader(entry, positions, trades);
        scores.push(score);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Sort by score
    scores.sort((a, b) => b.totalScore - a.totalScore);

    Logger.info('');
    Logger.success('✅ Analysis complete!');
    Logger.info('');

    return scores;
}

// ============================================================================
// REPORTING FUNCTIONS
// ============================================================================

/**
 * Print detailed report
 */
export function printTraderReport(scores: TraderScore[], topN: number = 10): void {
    Logger.header('📊 TRADER DISCOVERY REPORT');
    Logger.info('');

    const topTraders = scores.slice(0, topN);

    Logger.info(`Top ${topN} Traders:`);
    Logger.info('═'.repeat(80));
    Logger.info('');

    topTraders.forEach((trader, idx) => {
        const emoji = trader.recommendation === 'EXCELLENT' ? '🌟'
            : trader.recommendation === 'GOOD' ? '✅'
            : trader.recommendation === 'AVERAGE' ? '📊'
            : trader.recommendation === 'POOR' ? '⚠️'
            : '❌';

        Logger.info(`${emoji} #${idx + 1} - ${trader.recommendation} (Score: ${trader.totalScore}/100)`);
        Logger.info(`Address: ${trader.address}`);
        if (trader.username) {
            Logger.info(`Username: ${trader.username}`);
        }
        Logger.info('');

        Logger.info('📈 Metrics:');
        Logger.info(`  Total PnL: $${trader.metrics.totalPnl.toFixed(2)}`);
        Logger.info(`  Win Rate: ${trader.metrics.winRate.toFixed(1)}%`);
        Logger.info(`  Markets Traded: ${trader.metrics.marketsTraded}`);
        Logger.info(`  Avg Position: $${trader.metrics.avgPositionSize.toFixed(2)}`);
        Logger.info(`  Profit Factor: ${trader.metrics.profitFactor?.toFixed(2) || 'N/A'}`);
        Logger.info(`  Max Drawdown: ${trader.metrics.maxDrawdown?.toFixed(1) || 'N/A'}%`);
        Logger.info('');

        Logger.info('🎯 Score Breakdown:');
        Logger.info(`  Profitability: ${trader.scores.profitability}/25`);
        Logger.info(`  Consistency: ${trader.scores.consistency}/25`);
        Logger.info(`  Activity: ${trader.scores.activity}/20`);
        Logger.info(`  Risk Management: ${trader.scores.riskManagement}/15`);
        Logger.info(`  Diversification: ${trader.scores.diversification}/15`);
        Logger.info('');

        Logger.info('💡 Key Points:');
        trader.reasons.forEach(reason => {
            Logger.info(`  ${reason}`);
        });
        Logger.info('');
        Logger.info('─'.repeat(80));
        Logger.info('');
    });

    // Summary recommendations
    Logger.header('🎯 RECOMMENDATIONS');
    Logger.info('');

    const excellent = scores.filter(s => s.recommendation === 'EXCELLENT');
    const good = scores.filter(s => s.recommendation === 'GOOD');

    if (excellent.length > 0) {
        Logger.success(`🌟 ${excellent.length} EXCELLENT traders found - highly recommended to copy!`);
        Logger.info('   Suggested allocation: 30-40% of capital per trader');
        Logger.info('   Addresses:');
        excellent.slice(0, 5).forEach(t => {
            Logger.info(`   - ${t.address}`);
        });
        Logger.info('');
    }

    if (good.length > 0) {
        Logger.info(`✅ ${good.length} GOOD traders found - suitable for copying`);
        Logger.info('   Suggested allocation: 15-25% of capital per trader');
        Logger.info('   Addresses:');
        good.slice(0, 5).forEach(t => {
            Logger.info(`   - ${t.address}`);
        });
        Logger.info('');
    }

    Logger.info('💡 Next Steps:');
    Logger.info('  1. Add top traders to your .env file (USER_ADDRESSES)');
    Logger.info('  2. Start with small copy percentage (5-10%)');
    Logger.info('  3. Monitor performance for 2-4 weeks');
    Logger.info('  4. Increase allocation on proven performers');
    Logger.info('  5. Remove underperformers after 1-2 months');
    Logger.info('');

    // Generate .env snippet
    if (excellent.length > 0 || good.length > 0) {
        Logger.header('📝 SUGGESTED .ENV CONFIGURATION');
        Logger.info('');

        const topAddresses = [...excellent, ...good]
            .slice(0, 5)
            .map(t => t.address)
            .join(',');

        Logger.info(`USER_ADDRESSES='${topAddresses}'`);
        Logger.info('');
    }
}

/**
 * Export to JSON file
 */
export function exportToJSON(scores: TraderScore[], filename: string = 'trader-discovery.json'): void {
    const fs = require('fs');
    const path = require('path');

    const filepath = path.join(process.cwd(), filename);

    const report = {
        timestamp: new Date().toISOString(),
        totalAnalyzed: scores.length,
        recommendations: {
            excellent: scores.filter(s => s.recommendation === 'EXCELLENT').length,
            good: scores.filter(s => s.recommendation === 'GOOD').length,
            average: scores.filter(s => s.recommendation === 'AVERAGE').length,
            poor: scores.filter(s => s.recommendation === 'POOR').length,
            avoid: scores.filter(s => s.recommendation === 'AVOID').length,
        },
        traders: scores,
    };

    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    Logger.success(`✅ Report exported to: ${filepath}`);
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const options: DiscoveryOptions = {};

    args.forEach(arg => {
        if (arg.startsWith('--min-pnl=')) {
            options.minPnl = parseFloat(arg.split('=')[1]!);
        } else if (arg.startsWith('--min-winrate=')) {
            options.minWinRate = parseFloat(arg.split('=')[1]!);
        } else if (arg.startsWith('--min-markets=')) {
            options.minMarketsTraded = parseInt(arg.split('=')[1]!);
        } else if (arg.startsWith('--min-volume=')) {
            options.minVolume = parseFloat(arg.split('=')[1]!);
        } else if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]!);
        } else if (arg === '--whales') {
            options.whalesOnly = true;
        }
    });

    // Run discovery
    const scores = await discoverTraders(options);

    // Print report
    printTraderReport(scores, 10);

    // Export to JSON
    exportToJSON(scores);
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        Logger.error(`Script failed: ${error}`);
        process.exit(1);
    });
}
