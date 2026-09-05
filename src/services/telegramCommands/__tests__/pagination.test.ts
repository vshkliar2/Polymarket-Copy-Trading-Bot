import {
    createEagerPager,
    createLazyPager,
    getPagerEntry,
    advancePager,
    sweepExpiredPagers,
    PAGE_SIZE,
    PAGER_TTL_MS,
} from '../pagination';

describe('createEagerPager', () => {
    it('renders the first PAGE_SIZE items and reports hasNext when more remain', () => {
        const items = Array.from({ length: 12 }, (_, i) => i);
        const { key, entry } = createEagerPager(items, (n) => `item ${n}`);

        expect(entry.kind).toBe('eager');
        expect(getPagerEntry(key)).toBe(entry);
    });

    it('assigns a unique key per call', () => {
        const { key: key1 } = createEagerPager([1], (n) => `${n}`);
        const { key: key2 } = createEagerPager([1], (n) => `${n}`);
        expect(key1).not.toBe(key2);
    });
});

describe('advancePager (eager)', () => {
    it('advances to the next page and reports correct hasPrev/hasNext', async () => {
        const items = Array.from({ length: 12 }, (_, i) => i);
        const { key } = createEagerPager(items, (n) => `item ${n}`);

        const result = await advancePager(key, 'next');

        expect(result).toBeDefined();
        expect(result!.text).toContain('item 5');
        expect(result!.text).not.toContain('item 0');
        expect(result!.hasPrev).toBe(true);
        expect(result!.hasNext).toBe(true);
    });

    it('does not advance past the last page', async () => {
        const items = Array.from({ length: 3 }, (_, i) => i);
        const { key } = createEagerPager(items, (n) => `item ${n}`);

        const result = await advancePager(key, 'next');

        expect(result!.hasNext).toBe(false);
        expect(result!.hasPrev).toBe(false);
    });

    it('does not advance before the first page', async () => {
        const items = Array.from({ length: 12 }, (_, i) => i);
        const { key } = createEagerPager(items, (n) => `item ${n}`);

        const result = await advancePager(key, 'prev');

        expect(result!.text).toContain('item 0');
        expect(result!.hasPrev).toBe(false);
    });

    it('returns undefined for an unknown key', async () => {
        const result = await advancePager('does-not-exist', 'next');
        expect(result).toBeUndefined();
    });
});

describe('advancePager (lazy)', () => {
    it('fetches the next page via fetchPage and has no prev button', async () => {
        const fetchPage = jest
            .fn()
            .mockResolvedValueOnce({ items: [10, 11], nextCursor: 'c2', hasMore: true });
        const { key } = createLazyPager(
            { render: (n: number) => `item ${n}`, fetchPage },
            { items: [1, 2, 3, 4, 5], nextCursor: 'c1', hasMore: true }
        );

        const result = await advancePager(key, 'next');

        expect(fetchPage).toHaveBeenCalledWith('c1');
        expect(result!.text).toContain('item 10');
        expect(result!.text).toContain('item 11');
        expect(result!.hasPrev).toBe(false);
        expect(result!.hasNext).toBe(true);
    });

    it('reports hasNext false once the source reports no more pages', async () => {
        const fetchPage = jest.fn();
        const { key } = createLazyPager(
            { render: (n: number) => `item ${n}`, fetchPage },
            { items: [1], nextCursor: undefined, hasMore: false }
        );

        const result = await advancePager(key, 'next');

        expect(fetchPage).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });
});

describe('sweepExpiredPagers', () => {
    it('evicts entries older than PAGER_TTL_MS', () => {
        const { key } = createEagerPager([1, 2], (n) => `${n}`);
        expect(getPagerEntry(key)).toBeDefined();

        sweepExpiredPagers(Date.now() + PAGER_TTL_MS + 1000);

        expect(getPagerEntry(key)).toBeUndefined();
    });

    it('keeps entries younger than PAGER_TTL_MS', () => {
        const { key } = createEagerPager([1, 2], (n) => `${n}`);

        sweepExpiredPagers(Date.now());

        expect(getPagerEntry(key)).toBeDefined();
    });
});
