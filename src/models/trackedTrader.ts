import mongoose, { Schema, Document } from 'mongoose';

export type TrackedTraderStatus = 'active' | 'pending' | 'rejected';
export type TrackedTraderSource = 'manual' | 'discovered_leaderboard' | 'discovered_new_wallet';

export interface TrackedTraderInterface extends Document {
    address: string;
    status: TrackedTraderStatus;
    source: TrackedTraderSource;
    addedAt: Date;
    addedBy?: string;
    discoveryMeta?: {
        score?: number;
        firstTradeSize?: number;
        reason: string;
    };
}

const trackedTraderSchema = new Schema<TrackedTraderInterface>({
    address: { type: String, required: true, unique: true, lowercase: true },
    status: { type: String, required: true, enum: ['active', 'pending', 'rejected'] },
    source: {
        type: String,
        required: true,
        enum: ['manual', 'discovered_leaderboard', 'discovered_new_wallet'],
    },
    addedAt: { type: Date, required: true },
    addedBy: { type: String, required: false },
    discoveryMeta: {
        type: new Schema(
            {
                score: { type: Number, required: false },
                firstTradeSize: { type: Number, required: false },
                reason: { type: String, required: true },
            },
            { _id: false }
        ),
        required: false,
    },
});

const TrackedTraderModel = mongoose.model<TrackedTraderInterface>(
    'tracked_traders',
    trackedTraderSchema,
    'tracked_traders'
);

export default TrackedTraderModel;
