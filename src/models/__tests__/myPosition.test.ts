import { getMyPositionModel } from '../myPosition';

describe('MyPositionModel schema', () => {
    it('should build a valid document with required fields', () => {
        const MyPosition = getMyPositionModel();
        const doc = new MyPosition({
            conditionId: '0xabc',
            asset: '123',
            size: 10.5,
            avgPrice: 0.42,
            totalBought: 10.5,
        });
        const err = doc.validateSync();
        expect(err).toBeUndefined();
        expect(doc.get('conditionId')).toBe('0xabc');
        expect(doc.get('size')).toBe(10.5);
        expect(doc.get('avgPrice')).toBe(0.42);
    });

    it('should fail validation without conditionId', () => {
        const MyPosition = getMyPositionModel();
        const doc = new MyPosition({ asset: '1', size: 1, avgPrice: 1, totalBought: 1 });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err?.errors.conditionId).toBeDefined();
    });

    it('should mark conditionId as a unique index', () => {
        const MyPosition = getMyPositionModel();
        const conditionIdPath = MyPosition.schema.path('conditionId') as unknown as {
            options: { unique?: boolean };
        };
        expect(conditionIdPath.options.unique).toBe(true);
    });

    it('should return the same collection name across calls', () => {
        const a = getMyPositionModel();
        const b = getMyPositionModel();
        expect(a.collection.name).toBe('my_positions');
        expect(b.collection.name).toBe('my_positions');
        expect(a).toBe(b);
    });
});
