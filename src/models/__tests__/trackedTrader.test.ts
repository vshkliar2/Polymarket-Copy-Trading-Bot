import mongoose from 'mongoose';
import TrackedTraderModel from '../trackedTrader';

describe('TrackedTraderModel schema', () => {
    it('should build a valid document with required fields only', () => {
        const doc = new TrackedTraderModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            status: 'active',
            source: 'manual',
            addedAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeUndefined();
    });

    it('should fail validation without a required field', () => {
        const doc = new TrackedTraderModel({
            status: 'active',
            source: 'manual',
            addedAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.address).toBeDefined();
    });

    it('should reject an invalid status enum value', () => {
        const doc = new TrackedTraderModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            status: 'not-a-real-status',
            source: 'manual',
            addedAt: new Date(),
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.status).toBeDefined();
    });

    it('should accept an optional discoveryMeta subdocument', () => {
        const doc = new TrackedTraderModel({
            address: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
            status: 'pending',
            source: 'discovered_leaderboard',
            addedAt: new Date(),
            discoveryMeta: { score: 87, reason: 'High win rate, low drawdown' },
        });
        const err = doc.validateSync();
        expect(err).toBeUndefined();
        expect(doc.discoveryMeta?.score).toBe(87);
    });
});
