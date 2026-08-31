import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import { discoverTraders } from './scripts/discoverTraders';
import TrackedTraderModel from './models/trackedTrader';
import TelegramNotifier from './services/telegramNotifier';
import Logger from './utils/logger';
import { formatError } from './utils/errorHelpers';

let isRunning = true;
let intervalHandle: NodeJS.Timeout | null = null;

const runDiscoveryScan = async (): Promise<void> => {
    Logger.info('Starting leaderboard discovery scan...');
    try {
        const scores = await discoverTraders({ limit: 100 });
        const candidates = scores.filter((s) => s.totalScore >= ENV.DISCOVERY_MIN_SCORE);

        Logger.info(
            `Found ${candidates.length} candidate(s) scoring >= ${ENV.DISCOVERY_MIN_SCORE}`
        );

        for (const candidate of candidates) {
            const normalized = candidate.address.toLowerCase();
            const existing = await TrackedTraderModel.findOne({ address: normalized }).exec();
            if (existing) {
                continue; // Already tracked, pending, or previously rejected — don't re-alert
            }

            await TrackedTraderModel.create({
                address: normalized,
                status: 'pending',
                source: 'discovered_leaderboard',
                addedAt: new Date(),
                discoveryMeta: {
                    score: candidate.totalScore,
                    reason: `Score ${candidate.totalScore}/100 (${candidate.recommendation}) — win rate ${candidate.metrics.winRate.toFixed(1)}%, PnL $${candidate.metrics.totalPnl.toFixed(0)}`,
                },
            });

            await TelegramNotifier.notifyDiscoveredTrader({
                address: normalized,
                source: 'discovered_leaderboard',
                reason: `Score ${candidate.totalScore}/100 (${candidate.recommendation}) — win rate ${candidate.metrics.winRate.toFixed(1)}%, PnL $${candidate.metrics.totalPnl.toFixed(0)}`,
            });
        }

        Logger.success('Discovery scan complete');
    } catch (error) {
        Logger.error(`Discovery scan failed: ${formatError(error)}`);
    }
};

const gracefulShutdown = async (): Promise<void> => {
    isRunning = false;
    if (intervalHandle) {
        clearInterval(intervalHandle);
    }
    await closeDB();
    process.exit(0);
};

process.on('SIGTERM', () => void gracefulShutdown());
process.on('SIGINT', () => void gracefulShutdown());

const main = async (): Promise<void> => {
    await connectDB();
    Logger.success(
        `Discovery worker started — scanning every ${ENV.DISCOVERY_INTERVAL_HOURS}h, min score ${ENV.DISCOVERY_MIN_SCORE}`
    );

    await runDiscoveryScan();

    intervalHandle = setInterval(
        () => {
            if (isRunning) {
                void runDiscoveryScan();
            }
        },
        ENV.DISCOVERY_INTERVAL_HOURS * 60 * 60 * 1000
    );
};

main();
