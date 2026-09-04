import mongoose from 'mongoose';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { fetchMyPositionsAndBalance } from '../utils/positionHelpers';
import { getMyPositionModel } from '../models/myPosition';

/**
 * One-time backfill: my_positions starts empty, so any position the bot
 * already held before this feature shipped would otherwise be invisible
 * to postSellOrder's `if (!myPosition)` bailout — wrongly treated as "no
 * position to sell" for a market we're actually holding. Run this once,
 * manually, right before/after deploying the self-tracked position
 * feature. Safe to re-run: it fully overwrites my_positions from the live
 * API each time, same as the periodic reconciliation tick does.
 */
const seedMyPositions = async (): Promise<void> => {
    await mongoose.connect(ENV.MONGO_URI as string);
    Logger.info('Connected to MongoDB');

    const { positions } = await fetchMyPositionsAndBalance();
    Logger.info(`Fetched ${positions.length} live position(s) from the API`);

    const MyPosition = getMyPositionModel();

    for (const position of positions) {
        await MyPosition.findOneAndUpdate(
            { conditionId: position.conditionId },
            {
                $set: {
                    conditionId: position.conditionId,
                    asset: position.asset,
                    size: position.size,
                    avgPrice: position.avgPrice,
                    totalBought: position.totalBought,
                },
            },
            { upsert: true }
        );
    }

    Logger.success(`Seeded ${positions.length} position(s) into my_positions`);
    await mongoose.disconnect();
};

seedMyPositions()
    .then(() => process.exit(0))
    .catch((error) => {
        Logger.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
