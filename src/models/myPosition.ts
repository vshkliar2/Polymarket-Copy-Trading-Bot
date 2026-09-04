import mongoose, { Schema, Document } from 'mongoose';

export interface MyPositionInterface extends Document {
    conditionId: string;
    asset?: string;
    size: number;
    avgPrice: number;
    totalBought?: number;
}

const myPositionSchema = new Schema<MyPositionInterface>({
    conditionId: { type: String, required: true, unique: true },
    asset: { type: String, required: false },
    size: { type: Number, required: true, default: 0 },
    avgPrice: { type: Number, required: true, default: 0 },
    totalBought: { type: Number, required: false, default: 0 },
});

let cachedModel: mongoose.Model<MyPositionInterface> | null = null;

/**
 * Single collection ("my_positions") for the bot's own wallet's self-tracked
 * positions. Unlike getUserPositionModel/getUserActivityModel in
 * userHistory.ts (one dynamically-named collection per tracked trader
 * address), there is exactly one bot wallet, so this is not parameterized
 * and the collection name is a fixed constant.
 *
 * userHistory.ts's factories call mongoose.model(name, schema, name) fresh
 * on every invocation without caching; that's only safe there because each
 * distinct trader address produces a distinct model name, so repeat calls
 * for the *same* address would actually risk mongoose's OverwriteModelError
 * too (a latent issue in that file, out of scope here). Since this model
 * name is fixed and this factory can be called repeatedly (e.g. once per
 * trade), we cache the compiled model on first call to avoid re-registering
 * it under the same name.
 */
export const getMyPositionModel = (): mongoose.Model<MyPositionInterface> => {
    if (cachedModel) {
        return cachedModel;
    }
    cachedModel =
        (mongoose.models.my_positions as mongoose.Model<MyPositionInterface> | undefined) ||
        mongoose.model<MyPositionInterface>('my_positions', myPositionSchema, 'my_positions');
    return cachedModel;
};
