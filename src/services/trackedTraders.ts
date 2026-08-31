import TrackedTraderModel from '../models/trackedTrader';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import { isValidEthereumAddress } from '../config/env';
import Logger from '../utils/logger';

export interface TraderModelConfig {
    address: string;
    UserActivity: ReturnType<typeof getUserActivityModel>;
    UserPosition: ReturnType<typeof getUserPositionModel>;
}

/**
 * Pure diff between the addresses a service currently has models for and
 * the latest active list from the DB. No I/O — safe to unit test directly.
 */
export const diffTraderAddresses = (
    currentAddresses: string[],
    activeAddresses: string[]
): { toAdd: string[]; toRemove: string[] } => {
    const currentSet = new Set(currentAddresses);
    const activeSet = new Set(activeAddresses);

    const toAdd = activeAddresses.filter((addr) => !currentSet.has(addr));
    const toRemove = currentAddresses.filter((addr) => !activeSet.has(addr));

    return { toAdd, toRemove };
};

/**
 * Query tracked_traders for all active addresses (lowercase).
 */
export const getActiveTraderAddresses = async (): Promise<string[]> => {
    const rows = await TrackedTraderModel.find({ status: 'active' }).exec();
    return rows.map((row) => row.address);
};

/**
 * One-time migration: if tracked_traders is empty and envAddresses is
 * non-empty, seed the collection from it (source: 'manual', status: 'active').
 * No-op if tracked_traders already has any documents.
 */
export const seedFromEnvIfEmpty = async (envAddresses: string[]): Promise<void> => {
    const existingCount = await TrackedTraderModel.countDocuments();
    if (existingCount > 0) {
        return;
    }
    if (!envAddresses || envAddresses.length === 0) {
        return;
    }

    const now = new Date();
    await TrackedTraderModel.insertMany(
        envAddresses.map((address) => ({
            address: address.toLowerCase(),
            status: 'active' as const,
            source: 'manual' as const,
            addedAt: now,
        }))
    );
    Logger.success(
        `Seeded tracked_traders with ${envAddresses.length} address(es) from USER_ADDRESSES`
    );
};

/**
 * Build a fresh model-config map for the given addresses. Called with the
 * result of diffTraderAddresses().toAdd to create models only for newly
 * active addresses.
 */
export const buildTraderModelMap = (addresses: string[]): Map<string, TraderModelConfig> => {
    const map = new Map<string, TraderModelConfig>();
    for (const address of addresses) {
        map.set(address, {
            address,
            UserActivity: getUserActivityModel(address),
            UserPosition: getUserPositionModel(address),
        });
    }
    return map;
};

/**
 * Manually add a trader (e.g. via a Telegram /add command). Validates the
 * address format; throws if invalid or if the address is already tracked
 * with any status.
 */
export const addManualTrader = async (address: string, addedBy?: string): Promise<void> => {
    const normalized = address.toLowerCase();
    if (!isValidEthereumAddress(normalized)) {
        throw new Error(`Invalid Ethereum address: ${address}`);
    }

    const existing = await TrackedTraderModel.findOne({ address: normalized }).exec();
    if (existing) {
        if (existing.status === 'active') {
            throw new Error(`${address} is already actively tracked`);
        }
        existing.status = 'active';
        existing.addedBy = addedBy;
        existing.addedAt = new Date();
        await existing.save();
        return;
    }

    await TrackedTraderModel.create({
        address: normalized,
        status: 'active',
        source: 'manual',
        addedAt: new Date(),
        addedBy,
    });
};

/**
 * Remove (reject) a trader by address. No-op if not found.
 */
export const removeTrader = async (address: string): Promise<boolean> => {
    const normalized = address.toLowerCase();
    const result = await TrackedTraderModel.updateOne(
        { address: normalized },
        { $set: { status: 'rejected' } }
    );
    return result.modifiedCount > 0;
};

/**
 * List all traders with a given status (default: active).
 */
export const listTraders = async (status: 'active' | 'pending' | 'rejected' = 'active') => {
    return TrackedTraderModel.find({ status }).sort({ addedAt: -1 }).exec();
};
