import type { EagerPagerEntry, LazyPagerEntry, PagerEntry } from './types';

export const PAGE_SIZE = 5;
export const PAGER_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PAGER_ENTRIES = 50;

const pagers = new Map<string, PagerEntry<unknown>>();

const nextKey = (): string => Math.random().toString(36).slice(2, 10);

const evictOldestIfOverCapacity = (): void => {
    if (pagers.size <= MAX_PAGER_ENTRIES) {
        return;
    }
    const oldestKey = [...pagers.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]?.[0];
    if (oldestKey !== undefined) {
        pagers.delete(oldestKey);
    }
};

export const createEagerPager = <T>(
    items: T[],
    render: (item: T) => string
): { key: string; entry: EagerPagerEntry<T> } => {
    const entry: EagerPagerEntry<T> = {
        kind: 'eager',
        items,
        page: 0,
        render,
        createdAt: Date.now(),
    };
    const key = nextKey();
    pagers.set(key, entry as PagerEntry<unknown>);
    evictOldestIfOverCapacity();
    return { key, entry };
};

export const createLazyPager = <T>(
    seed: {
        render: (item: T) => string;
        fetchPage: (
            cursor: string | undefined
        ) => Promise<{ items: T[]; nextCursor?: string; hasMore: boolean }>;
    },
    firstPage: { items: T[]; nextCursor?: string; hasMore: boolean }
): { key: string; entry: LazyPagerEntry<T> } => {
    const entry: LazyPagerEntry<T> = {
        kind: 'lazy',
        items: firstPage.items,
        cursor: firstPage.nextCursor,
        hasMore: firstPage.hasMore,
        render: seed.render,
        fetchPage: seed.fetchPage,
        createdAt: Date.now(),
    };
    const key = nextKey();
    pagers.set(key, entry as PagerEntry<unknown>);
    evictOldestIfOverCapacity();
    return { key, entry };
};

export const getPagerEntry = (key: string): PagerEntry<unknown> | undefined => pagers.get(key);

const renderEagerPage = <T>(
    entry: EagerPagerEntry<T>
): { text: string; hasPrev: boolean; hasNext: boolean } => {
    const start = entry.page * PAGE_SIZE;
    const pageItems = entry.items.slice(start, start + PAGE_SIZE);
    return {
        text: pageItems.map(entry.render).join('\n\n'),
        hasPrev: entry.page > 0,
        hasNext: start + PAGE_SIZE < entry.items.length,
    };
};

/**
 * Advances the pager identified by `key` one page in `direction` and
 * returns the re-rendered text plus which buttons should show next.
 * Returns undefined if the key is unknown (expired/evicted/never existed)
 * or if `direction` would move past an end that has no more data — callers
 * treat undefined as "nothing to do" (eager: already at that end; lazy:
 * caller should not have offered a Next button here at all).
 */
export const advancePager = async (
    key: string,
    direction: 'next' | 'prev'
): Promise<{ text: string; hasPrev: boolean; hasNext: boolean } | undefined> => {
    const entry = pagers.get(key);
    if (!entry) {
        return undefined;
    }

    if (entry.kind === 'eager') {
        const maxPage = Math.max(0, Math.ceil(entry.items.length / PAGE_SIZE) - 1);
        const nextPageNum =
            direction === 'next' ? Math.min(maxPage, entry.page + 1) : Math.max(0, entry.page - 1);
        if (nextPageNum === entry.page) {
            return renderEagerPage(entry);
        }
        entry.page = nextPageNum;
        return renderEagerPage(entry);
    }

    // Lazy: no prev, and no-op if there's nothing more to fetch.
    if (direction === 'prev' || !entry.hasMore) {
        return undefined;
    }
    const page = await entry.fetchPage(entry.cursor);
    entry.items = page.items;
    entry.cursor = page.nextCursor;
    entry.hasMore = page.hasMore;
    return {
        text: page.items.map(entry.render).join('\n\n'),
        hasPrev: false,
        hasNext: page.hasMore,
    };
};

export const sweepExpiredPagers = (now: number): void => {
    for (const [key, entry] of pagers.entries()) {
        if (now - entry.createdAt > PAGER_TTL_MS) {
            pagers.delete(key);
        }
    }
};
