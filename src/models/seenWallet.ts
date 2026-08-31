import mongoose, { Schema, Document } from 'mongoose';
import { ENV } from '../config/env';

export interface SeenWalletInterface extends Document {
    address: string;
    firstSeenAt: Date;
}

const seenWalletSchema = new Schema<SeenWalletInterface>({
    address: { type: String, required: true, unique: true, lowercase: true },
    firstSeenAt: {
        type: Date,
        required: true,
        expires: ENV.NEW_WALLET_SEEN_TTL_DAYS * 24 * 60 * 60,
    },
});

const SeenWalletModel = mongoose.model<SeenWalletInterface>(
    'seen_wallets',
    seenWalletSchema,
    'seen_wallets'
);

export default SeenWalletModel;
