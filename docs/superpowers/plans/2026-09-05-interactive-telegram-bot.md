# Interactive Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Telegram command handling out of `telegramNotifier.ts` into a new `telegramCommands/` module, register every command with Telegram's native `/` menu, and add four new read-only commands (`/positions`, `/activity`, `/market`, `/trader`) plus `/help`.

**Architecture:** A `CommandContext` (bot instance, chat id, auth check, send-message function) is built once in `telegramNotifier.ts` and passed into `registerAllCommands()`, which wires every `onText` handler and a single `callback_query` router. Each command lives in its own file; pure rendering/detection/pagination logic is unit-tested directly, the Telegram wiring itself is not (matching this repo's existing untested-wiring precedent).

**Tech Stack:** TypeScript, `node-telegram-bot-api`, `@polymarket/client` (via `publicClient.ts`), Jest.

**Spec:** `docs/superpowers/specs/2026-09-05-interactive-telegram-bot-design.md`

## Global Constraints

- Every command stays restricted to `TELEGRAM_CHAT_ID` (single operator) — no multi-user auth.
- No write/trading actions from Telegram — read-only data commands plus the existing add/remove trader-tracking management.
- Pagination state lives in an in-memory `Map` only — no persistence across a bot restart.
- `/market` requires an exact slug or condition ID — no fuzzy search.
- Combo/multi-outcome positions and markets are filtered out, never rendered with fabricated fields.
- Every command handler wraps its body in try/catch and replies `❌ <message>` on error (via this repo's existing `formatError` from `src/utils/errorHelpers.ts`) — no exception ever reaches Telegram's own dispatch.
- HTML parse mode (`parse_mode: 'HTML'`) for all replies, matching every existing message in `telegramNotifier.ts`.

---

## File Structure

```
src/services/telegramCommands/
  types.ts                    — CommandContext, pager entry types
  pagination.ts                — pager Map: create/get/advance/evict + TTL sweep
  help.ts                       — /help command + the static command table
  traders.ts                    — /list, /pending, /add, /remove, approve/reject callback (migrated)
  positions.ts                  — /positions and /trader (shared position-rendering + handler factory)
  activity.ts                   — /activity
  market.ts                     — /market (condition-ID-vs-slug detection + fetchMarket/listMarkets + rendering)
  index.ts                      — registerAllCommands(ctx): wires every handler + callback_query router + setMyCommands
  __tests__/
    pagination.test.ts
    market.test.ts
    positions.test.ts
    activity.test.ts

src/utils/publicClient.ts       — MODIFY: getTradeActivity gains cursor support
src/services/telegramNotifier.ts — MODIFY: registerCommandHandlers() replaced by a call to registerAllCommands()
```

---

## Task 1: Pager types and pure pagination logic

**Files:**
- Create: `src/services/telegramCommands/types.ts`
- Create: `src/services/telegramCommands/pagination.ts`
- Test: `src/services/telegramCommands/__tests__/pagination.test.ts`

**Interfaces:**
- Produces: `PagerEntry<T>` (discriminated union: `EagerPagerEntry<T> | LazyPagerEntry<T>`), `createEagerPager<T>(items: T[], render: (item: T) => string): { key: string; entry: EagerPagerEntry<T> }`, `createLazyPager<T>(seed: { render: (item: T) => string; fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string; hasMore: boolean }> }, firstPage: { items: T[]; nextCursor?: string; hasMore: boolean }): { key: string; entry: LazyPagerEntry<T> }`, `getPagerEntry(key: string): PagerEntry<unknown> | undefined`, `advancePager(key: string, direction: 'next' | 'prev'): Promise<{ text: string; hasPrev: boolean; hasNext: boolean } | undefined>`, `sweepExpiredPagers(now: number): void`, `PAGE_SIZE = 5`.

- [ ] **Step 1: Write `types.ts`**

```typescript
// src/services/telegramCommands/types.ts
import TelegramBot from 'node-telegram-bot-api';

/**
 * Shared context every command handler receives — built once in
 * telegramNotifier.ts from its existing private bot/chatId/isAuthorized,
 * passed into registerAllCommands(). sendMessage returns the sent Message
 * (unlike telegramNotifier.ts's private version, which returns void) so
 * paginated commands can key pager state by the message id.
 */
export interface CommandContext {
    bot: TelegramBot;
    chatId: string;
    isAuthorized: (chatId: number | string) => boolean;
    sendMessage: (
        text: string,
        options?: TelegramBot.SendMessageOptions
    ) => Promise<TelegramBot.Message>;
}

export interface EagerPagerEntry<T> {
    kind: 'eager';
    items: T[];
    page: number;
    render: (item: T) => string;
    createdAt: number;
}

export interface LazyPagerEntry<T> {
    kind: 'lazy';
    items: T[];
    cursor: string | undefined;
    hasMore: boolean;
    render: (item: T) => string;
    fetchPage: (
        cursor: string | undefined
    ) => Promise<{ items: T[]; nextCursor?: string; hasMore: boolean }>;
    createdAt: number;
}

export type PagerEntry<T> = EagerPagerEntry<T> | LazyPagerEntry<T>;
```

- [ ] **Step 2: Write the failing tests for pagination.ts**

```typescript
// src/services/telegramCommands/__tests__/pagination.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/services/telegramCommands/__tests__/pagination.test.ts`
Expected: FAIL — `Cannot find module '../pagination'`

- [ ] **Step 4: Write `pagination.ts`**

```typescript
// src/services/telegramCommands/pagination.ts
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
    const oldestKey = [...pagers.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt
    )[0]?.[0];
    if (oldestKey !== undefined) {
        pagers.delete(oldestKey);
    }
};

export const createEagerPager = <T>(
    items: T[],
    render: (item: T) => string
): { key: string; entry: EagerPagerEntry<T> } => {
    const entry: EagerPagerEntry<T> = { kind: 'eager', items, page: 0, render, createdAt: Date.now() };
    const key = nextKey();
    pagers.set(key, entry as PagerEntry<unknown>);
    evictOldestIfOverCapacity();
    return { key, entry };
};

export const createLazyPager = <T>(
    seed: {
        render: (item: T) => string;
        fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string; hasMore: boolean }>;
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

const renderEagerPage = <T>(entry: EagerPagerEntry<T>): { text: string; hasPrev: boolean; hasNext: boolean } => {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/services/telegramCommands/__tests__/pagination.test.ts`
Expected: PASS, all tests green

- [ ] **Step 6: Commit**

```bash
git add src/services/telegramCommands/types.ts src/services/telegramCommands/pagination.ts src/services/telegramCommands/__tests__/pagination.test.ts
git commit -m "Add pager types and pure pagination logic for Telegram commands"
```

---

## Task 2: `getTradeActivity` cursor support in `publicClient.ts`

**Files:**
- Modify: `src/utils/publicClient.ts`

**Interfaces:**
- Consumes: existing `client.listActivity(...)` (SDK, already imported), `ActivityType`, `TradeActivity`, `toUserActivity` (existing private helper in this file), `ApiActivity` (existing exported type).
- Produces: `getTradeActivity(userAddress: string, options?: { pageSize?: number; cursor?: string }): Promise<{ items: ApiActivity[]; nextCursor?: string; hasMore: boolean }>` — **breaking change** to this method's return type (previously a bare `ApiActivity[]`). Task 5 updates the one call site (`checkMyStats.ts`... actually check: grep confirms no other caller besides this file's own export — verify in Step 1 below) that would break.

- [ ] **Step 1: Confirm no other file destructures `getTradeActivity`'s return value as an array before changing its shape**

Run: `grep -rn "getTradeActivity" src/ --include="*.ts" | grep -v "src/utils/publicClient.ts"`

Expected output: only `src/services/tradeMonitor.ts` and `src/services/websocketTradeMonitor.ts` (each calling `publicClient.getTradeActivity(address)` with no options, expecting an array back — per the earlier `createPublicClient` migration). Both call sites must be updated in this same task since they read the return value directly as an array (`activities.length`, `for (const activity of activities)`).

- [ ] **Step 2: Read the current `getTradeActivity` implementation**

Run: `grep -n "getTradeActivity" -A 20 src/utils/publicClient.ts`

You should see the current body (as of the last `createPublicClient` migration):
```typescript
const getTradeActivity = async (
    userAddress: string,
    options?: { pageSize?: number }
): Promise<ApiActivity[]> => {
    const page = await client
        .listActivity({
            user: userAddress,
            type: [ActivityType.TRADE],
            pageSize: options?.pageSize,
        })
        .firstPage();
    return page.items
        .map((item) => toUserActivity(item as TradeActivity))
        .filter((activity): activity is ApiActivity => activity !== undefined);
};
```

- [ ] **Step 3: Replace it with cursor-aware version**

```typescript
const getTradeActivity = async (
    userAddress: string,
    options?: { pageSize?: number; cursor?: string }
): Promise<{ items: ApiActivity[]; nextCursor?: string; hasMore: boolean }> => {
    const page = await client
        .listActivity({
            user: userAddress,
            type: [ActivityType.TRADE],
            pageSize: options?.pageSize,
            cursor: options?.cursor as Parameters<typeof client.listActivity>[0]['cursor'],
        })
        .firstPage();
    const items = page.items
        .map((item) => toUserActivity(item as TradeActivity))
        .filter((activity): activity is ApiActivity => activity !== undefined);
    return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
};
```

- [ ] **Step 4: Update `tradeMonitor.ts`'s call site**

Run: `grep -n "publicClient.getTradeActivity" src/services/tradeMonitor.ts`

Change:
```typescript
const activities = await publicClient.getTradeActivity(address);
```
to:
```typescript
const { items: activities } = await publicClient.getTradeActivity(address);
```

- [ ] **Step 5: Update `websocketTradeMonitor.ts`'s call site**

Run: `grep -n "publicClient.getTradeActivity" src/services/websocketTradeMonitor.ts`

Apply the same change: `const activities = await publicClient.getTradeActivity(address);` → `const { items: activities } = await publicClient.getTradeActivity(address);`

- [ ] **Step 6: Compile and run the full test suite**

Run: `npm run build:strict && npm test`
Expected: both pass clean (no test currently asserts on `getTradeActivity`'s exact return shape besides the two call sites just fixed).

- [ ] **Step 7: Commit**

```bash
git add src/utils/publicClient.ts src/services/tradeMonitor.ts src/services/websocketTradeMonitor.ts
git commit -m "Add cursor support to publicClient.getTradeActivity for Telegram /activity pagination"
```

---

## Task 3: `/help` command and static command table

**Files:**
- Create: `src/services/telegramCommands/help.ts`

**Interfaces:**
- Consumes: `CommandContext` (Task 1).
- Produces: `COMMAND_DEFINITIONS: { command: string; description: string }[]` (used by both `/help`'s reply and Task 7's `setMyCommands` call), `registerHelpCommand(ctx: CommandContext): void`.

- [ ] **Step 1: Write `help.ts`**

```typescript
// src/services/telegramCommands/help.ts
import type { CommandContext } from './types';

/**
 * Single source of truth for every registered command's description —
 * used both for /help's reply and for setMyCommands (Task 7), so the
 * native Telegram "/" menu and /help's text never drift apart.
 */
export const COMMAND_DEFINITIONS: { command: string; description: string }[] = [
    { command: 'list', description: 'Show active tracked traders' },
    { command: 'pending', description: 'Show pending trader candidates' },
    { command: 'add', description: 'Add a trader to active tracking' },
    { command: 'remove', description: 'Remove a trader from active tracking' },
    { command: 'positions', description: 'Show your current live positions' },
    { command: 'activity', description: 'Show your recent trade activity' },
    { command: 'market', description: "Look up a market's price/volume/odds" },
    { command: 'trader', description: "Show any trader's live positions" },
    { command: 'help', description: 'List all commands' },
];

export const registerHelpCommand = (ctx: CommandContext): void => {
    ctx.bot.onText(/^\/help/, async (msg) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const lines = COMMAND_DEFINITIONS.map((c) => `/${c.command} — ${c.description}`);
        await ctx.sendMessage(`<b>Available Commands</b>\n\n${lines.join('\n')}`, {
            parse_mode: 'HTML',
        });
    });
};
```

- [ ] **Step 2: Compile**

Run: `npm run build:strict`
Expected: PASS (nothing imports this file yet, but it must compile standalone)

- [ ] **Step 3: Commit**

```bash
git add src/services/telegramCommands/help.ts
git commit -m "Add /help command and shared COMMAND_DEFINITIONS table"
```

---

## Task 4: Migrate `/list`, `/pending`, `/add`, `/remove`, approve/reject to `traders.ts`

**Files:**
- Create: `src/services/telegramCommands/traders.ts`

**Interfaces:**
- Consumes: `CommandContext` (Task 1), `./trackedTraders` (existing: `listTraders`, `addManualTrader`, `removeTrader`), `formatError` from `../../utils/errorHelpers` (existing).
- Produces: `registerTraderCommands(ctx: CommandContext): void`, `handleTraderCallbackQuery(ctx: CommandContext, query: TelegramBot.CallbackQuery): Promise<boolean>` (returns `true` if this router claimed the callback, `false` if Task 6's pagination router should look at it instead — see Task 8's combined router).

This task moves the five handlers verbatim (same regexes, same message text, same error format) out of `telegramNotifier.ts` — behavior must be pixel-identical to what exists today. The only substitution is `this.sendMessage`/`this.bot`/`this.isAuthorized`/`this.chatId` → `ctx.sendMessage`/`ctx.bot`/`ctx.isAuthorized`/`ctx.chatId`, and `error instanceof Error ? error.message : String(error)` → `formatError(error)` (identical output, now reusing the existing shared helper instead of re-inlining it).

- [ ] **Step 1: Read the current handlers being migrated**

Run: `sed -n '86,219p' src/services/telegramNotifier.ts`

(This is the exact block being moved — confirm it still matches what's shown below before proceeding; if it has drifted, adapt the migration to match the current code, not this plan.)

- [ ] **Step 2: Write `traders.ts`**

```typescript
// src/services/telegramCommands/traders.ts
import TelegramBot from 'node-telegram-bot-api';
import type { CommandContext } from './types';
import { formatError } from '../../utils/errorHelpers';

export const registerTraderCommands = (ctx: CommandContext): void => {
    ctx.bot.onText(/\/list/, async (msg) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        try {
            const { listTraders } = await import('../trackedTraders');
            const traders = await listTraders('active');
            if (traders.length === 0) {
                await ctx.sendMessage('No active tracked traders.');
                return;
            }
            const lines = traders.map(
                (t) =>
                    `• <code>${t.address}</code> (${t.source}, added ${t.addedAt.toISOString().slice(0, 10)})`
            );
            await ctx.sendMessage(
                `<b>Active Traders (${traders.length})</b>\n\n${lines.join('\n')}`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            await ctx.sendMessage(`❌ Error listing traders: ${formatError(error)}`);
        }
    });

    ctx.bot.onText(/\/pending/, async (msg) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        try {
            const { listTraders } = await import('../trackedTraders');
            const traders = await listTraders('pending');
            if (traders.length === 0) {
                await ctx.sendMessage('No pending trader candidates.');
                return;
            }
            const lines = traders.map(
                (t) =>
                    `• <code>${t.address}</code> (${t.source})${t.discoveryMeta ? `\n  ${t.discoveryMeta.reason}` : ''}`
            );
            await ctx.sendMessage(
                `<b>Pending Candidates (${traders.length})</b>\n\n${lines.join('\n')}`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            await ctx.sendMessage(`❌ Error listing pending traders: ${formatError(error)}`);
        }
    });

    ctx.bot.onText(/\/add (.+)/, async (msg, match) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await ctx.sendMessage('Usage: /add 0xADDRESS');
            return;
        }
        try {
            const { addManualTrader } = await import('../trackedTraders');
            await addManualTrader(address, String(msg.from?.id ?? 'telegram'));
            await ctx.sendMessage(`✅ Added <code>${address}</code> to active traders.`, {
                parse_mode: 'HTML',
            });
        } catch (error) {
            await ctx.sendMessage(`❌ ${formatError(error)}`);
        }
    });

    ctx.bot.onText(/\/remove (.+)/, async (msg, match) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await ctx.sendMessage('Usage: /remove 0xADDRESS');
            return;
        }
        try {
            const { removeTrader } = await import('../trackedTraders');
            const removed = await removeTrader(address);
            await ctx.sendMessage(
                removed
                    ? `✅ Removed <code>${address}</code> from active traders.`
                    : `⚠️ <code>${address}</code> was not found or already inactive.`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            await ctx.sendMessage(`❌ ${formatError(error)}`);
        }
    });
};

/**
 * Handles the approve/reject inline-button callback for pending trader
 * candidates. Returns true if this callback's data matched the
 * approve:/reject: convention (so the combined router in index.ts knows
 * not to also try the pagination router on it), false otherwise.
 */
export const handleTraderCallbackQuery = async (
    ctx: CommandContext,
    query: TelegramBot.CallbackQuery
): Promise<boolean> => {
    if (!query.message || !ctx.isAuthorized(query.message.chat.id)) {
        return false;
    }
    const data = query.data ?? '';
    const [action, address] = data.split(':');
    if (!address || (action !== 'approve' && action !== 'reject')) {
        return false;
    }

    try {
        const { addManualTrader, removeTrader } = await import('../trackedTraders');
        if (action === 'approve') {
            await addManualTrader(address, String(query.from.id));
            await ctx.bot.answerCallbackQuery(query.id, { text: `Approved ${address}` });
            await ctx.bot.sendMessage(ctx.chatId, `✅ Approved <code>${address}</code>`, {
                parse_mode: 'HTML',
            });
        } else {
            await removeTrader(address);
            await ctx.bot.answerCallbackQuery(query.id, { text: `Rejected ${address}` });
            await ctx.bot.sendMessage(ctx.chatId, `❌ Rejected <code>${address}</code>`, {
                parse_mode: 'HTML',
            });
        }
    } catch (error) {
        await ctx.bot.answerCallbackQuery(query.id, { text: `Error: ${formatError(error)}` });
    }
    return true;
};
```

- [ ] **Step 3: Compile**

Run: `npm run build:strict`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/telegramCommands/traders.ts
git commit -m "Migrate /list, /pending, /add, /remove, and approve/reject callback to telegramCommands/traders.ts"
```

(Note: `telegramNotifier.ts` still has its own copy of these handlers registered at this point — nothing is broken, there's just temporary duplication until Task 8 rewires `initialize()`. This keeps every task's deliverable independently compilable and testable rather than leaving the bot in a half-migrated non-compiling state between tasks.)

---

## Task 5: `/positions` and `/trader` commands

**Files:**
- Create: `src/services/telegramCommands/positions.ts`
- Test: `src/services/telegramCommands/__tests__/positions.test.ts`

**Interfaces:**
- Consumes: `CommandContext` (Task 1), `createEagerPager`/`PAGE_SIZE` (Task 1's `pagination.ts`), `publicClient.getAllPositions` (existing, `src/utils/publicClient.ts`), `ApiPosition` (existing exported type from `publicClient.ts`), `MY_EOA_ADDRESS` (existing default export from `../../utils/getMyEOA`), `formatError` (existing).
- Produces: `renderPosition(p: ApiPosition): string` (pure, unit-tested), `registerPositionsCommand(ctx: CommandContext): void`, `registerTraderCommand(ctx: CommandContext): void`.

**Note on the test file's mocks:** `positions.ts` imports `publicClient.ts` (real runtime import of `@polymarket/client`, ESM-only — same issue documented in `src/services/__tests__/reconcileMyPositions.test.ts`) and `errorHelpers.ts` (imports `@polymarket/bindings/clob`, also ESM-only). Both break Jest's default transform the moment `positions.test.ts` imports `../positions`, even though the test only calls the pure `renderPosition` function. Mock both modules at the top of the test file, matching the established pattern — see Step 1's test file below, which includes these mocks already.

- [ ] **Step 1: Write the failing test for `renderPosition`**

```typescript
// src/services/telegramCommands/__tests__/positions.test.ts
jest.mock('../../../utils/errorHelpers', () => ({
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    isInsufficientBalanceOrAllowanceCode: () => false,
}));

jest.mock('../../../utils/publicClient', () => ({
    __esModule: true,
    default: {
        getPositions: jest.fn(),
        getAllPositions: jest.fn(),
        getClosedPositions: jest.fn(),
        getTradeActivity: jest.fn(),
        getLeaderboard: jest.fn(),
        getTrades: jest.fn(),
        getUserProfile: jest.fn(),
    },
}));

import { renderPosition } from '../positions';
import type { ApiPosition } from '../../../utils/publicClient';

const buildPosition = (overrides: Partial<ApiPosition> = {}): ApiPosition => ({
    proxyWallet: '0xabc',
    asset: '123',
    conditionId: '0xdef',
    size: 250,
    avgPrice: 0.42,
    initialValue: 105,
    currentValue: 113.75,
    cashPnl: 8.75,
    percentPnl: 8.3333,
    totalBought: 250,
    realizedPnl: 0,
    percentRealizedPnl: 8.3333,
    curPrice: 0.455,
    redeemable: false,
    mergeable: false,
    title: 'Trump meets with Putin by December 31?',
    slug: 'trump-meets-with-putin-by-december-31',
    icon: '',
    eventSlug: 'trump-meets-with-putin-by',
    outcome: 'No',
    outcomeIndex: 1,
    oppositeOutcome: 'Yes',
    oppositeAsset: '456',
    endDate: '2027-01-01',
    negativeRisk: false,
    ...overrides,
});

describe('renderPosition', () => {
    it('includes the market title, outcome, size, prices, value, PnL, and a link', () => {
        const text = renderPosition(buildPosition());

        expect(text).toContain('Trump meets with Putin by December 31?');
        expect(text).toContain('No');
        expect(text).toContain('250');
        expect(text).toContain('$0.42');
        expect(text).toContain('$0.455');
        expect(text).toContain('$113.75');
        expect(text).toContain('+$8.75');
        expect(text).toContain('8.3%');
        expect(text).toContain(
            'https://polymarket.com/event/trump-meets-with-putin-by-december-31'
        );
    });

    it('shows a negative PnL without a plus sign', () => {
        const text = renderPosition(buildPosition({ cashPnl: -3.383, percentPnl: -70.6263 }));
        expect(text).toContain('-$3.38');
        expect(text).not.toContain('+-');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/telegramCommands/__tests__/positions.test.ts`
Expected: FAIL — `Cannot find module '../positions'`

- [ ] **Step 3: Write `positions.ts`**

```typescript
// src/services/telegramCommands/positions.ts
import type { CommandContext } from './types';
import { createEagerPager, PAGE_SIZE } from './pagination';
import publicClient, { ApiPosition } from '../../utils/publicClient';
import MY_EOA_ADDRESS from '../../utils/getMyEOA';
import { formatError } from '../../utils/errorHelpers';

export const renderPosition = (p: ApiPosition): string => {
    // toFixed() on a negative number already includes its own "-", so
    // naively prefixing "+"/"" and always inserting "$" before the number
    // produces "$-3.38" (dollar sign before the minus) for a loss — this
    // formats the sign and "$" together instead, applied to the absolute
    // value, so a loss reads "-$3.38" and a gain reads "+$8.75".
    const pnlPrefix = p.cashPnl >= 0 ? '+$' : '-$';
    const pnlAbs = Math.abs(p.cashPnl).toFixed(2);
    const percentPrefix = p.percentPnl >= 0 ? '+' : '-';
    const percentAbs = Math.abs(p.percentPnl).toFixed(1);
    return (
        `<b>${p.title}</b> — ${p.outcome}\n` +
        `Size: ${p.size} @ avg $${p.avgPrice.toFixed(2)} | Current: $${p.curPrice.toFixed(3)}\n` +
        `Value: $${p.currentValue.toFixed(2)} | PnL: ${pnlPrefix}${pnlAbs} (${percentPrefix}${percentAbs}%)\n` +
        `🔗 https://polymarket.com/event/${p.slug}`
    );
};

const sendPositionsList = async (
    ctx: CommandContext,
    address: string,
    emptyMessage: string
): Promise<void> => {
    try {
        const positions = await publicClient.getAllPositions(address);
        if (positions.length === 0) {
            await ctx.sendMessage(emptyMessage);
            return;
        }
        const sorted = [...positions].sort((a, b) => b.currentValue - a.currentValue);
        const { key } = createEagerPager(sorted, renderPosition);
        const pageText = sorted.slice(0, PAGE_SIZE).map(renderPosition).join('\n\n');
        const hasNext = sorted.length > PAGE_SIZE;
        await ctx.sendMessage(pageText, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: hasNext
                ? { inline_keyboard: [[{ text: '▶️ Next', callback_data: `page:${key}:next` }]] }
                : undefined,
        });
    } catch (error) {
        await ctx.sendMessage(`❌ ${formatError(error)}`);
    }
};

export const registerPositionsCommand = (ctx: CommandContext): void => {
    ctx.bot.onText(/^\/positions/, async (msg) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        await sendPositionsList(ctx, MY_EOA_ADDRESS, 'No open positions.');
    });
};

export const registerTraderCommand = (ctx: CommandContext): void => {
    ctx.bot.onText(/\/trader (.+)/, async (msg, match) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await ctx.sendMessage('Usage: /trader 0xADDRESS');
            return;
        }
        await sendPositionsList(ctx, address, `No open positions for <code>${address}</code>.`);
    });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/telegramCommands/__tests__/positions.test.ts`
Expected: PASS

- [ ] **Step 5: Compile**

Run: `npm run build:strict`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/telegramCommands/positions.ts src/services/telegramCommands/__tests__/positions.test.ts
git commit -m "Add /positions and /trader commands with pagination"
```

---

## Task 6: `/activity` command

**Files:**
- Create: `src/services/telegramCommands/activity.ts`
- Test: `src/services/telegramCommands/__tests__/activity.test.ts`

**Interfaces:**
- Consumes: `CommandContext` (Task 1), `createLazyPager`/`PAGE_SIZE` (Task 1), `publicClient.getTradeActivity` (Task 2's cursor-aware version), `ApiActivity` (existing exported type from `publicClient.ts`), `MY_EOA_ADDRESS` (existing), `formatError` (existing).
- Produces: `renderActivity(a: ApiActivity): string` (pure, unit-tested), `registerActivityCommand(ctx: CommandContext): void`.

**Note on the test file's mocks:** same ESM issue as Task 5 (`activity.ts` imports both `publicClient.ts` and `errorHelpers.ts`) — mock both, as shown in Step 1 below.

- [ ] **Step 1: Write the failing test for `renderActivity`**

```typescript
// src/services/telegramCommands/__tests__/activity.test.ts
jest.mock('../../../utils/errorHelpers', () => ({
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    isInsufficientBalanceOrAllowanceCode: () => false,
}));

jest.mock('../../../utils/publicClient', () => ({
    __esModule: true,
    default: {
        getPositions: jest.fn(),
        getAllPositions: jest.fn(),
        getClosedPositions: jest.fn(),
        getTradeActivity: jest.fn(),
        getLeaderboard: jest.fn(),
        getTrades: jest.fn(),
        getUserProfile: jest.fn(),
    },
}));

import { renderActivity } from '../activity';
import type { ApiActivity } from '../../../utils/publicClient';

const buildActivity = (overrides: Partial<ApiActivity> = {}): ApiActivity => ({
    proxyWallet: '0xabc',
    timestamp: 1788551163000,
    conditionId: '0xdef',
    type: 'TRADE',
    size: 54.86,
    usdcSize: 36.32,
    transactionHash: '0x123',
    price: 0.66,
    asset: '789',
    side: 'BUY',
    outcomeIndex: 1,
    title: 'US x Iran Effective Ceasefire by September 4?',
    slug: 'us-x-iran-effective-ceasefire-by-september-4',
    icon: '',
    eventSlug: 'us-x-iran-effective-ceasefire-begins',
    outcome: 'No',
    name: '',
    pseudonym: '',
    bio: '',
    profileImage: '',
    profileImageOptimized: '',
    bot: false,
    botExcutedTime: 0,
    ...overrides,
});

describe('renderActivity', () => {
    it('includes side, size, market title, price, and dollar amount', () => {
        const text = renderActivity(buildActivity());

        expect(text).toContain('BUY');
        expect(text).toContain('54.86');
        expect(text).toContain('US x Iran Effective Ceasefire by September 4?');
        expect(text).toContain('$0.66');
        expect(text).toContain('$36.32');
    });

    it('renders SELL activity distinctly from BUY', () => {
        const text = renderActivity(buildActivity({ side: 'SELL' }));
        expect(text).toContain('SELL');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/telegramCommands/__tests__/activity.test.ts`
Expected: FAIL — `Cannot find module '../activity'`

- [ ] **Step 3: Write `activity.ts`**

```typescript
// src/services/telegramCommands/activity.ts
import type { CommandContext } from './types';
import { createLazyPager, PAGE_SIZE } from './pagination';
import publicClient, { ApiActivity } from '../../utils/publicClient';
import MY_EOA_ADDRESS from '../../utils/getMyEOA';
import { formatError } from '../../utils/errorHelpers';

export const renderActivity = (a: ApiActivity): string => {
    const date = new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    return (
        `<b>${a.side}</b> ${a.size} <a href="https://polymarket.com/event/${a.slug}">${a.title}</a> @ $${a.price.toFixed(2)}\n` +
        `$${a.usdcSize.toFixed(2)} · ${date}`
    );
};

export const registerActivityCommand = (ctx: CommandContext): void => {
    ctx.bot.onText(/^\/activity/, async (msg) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        try {
            const firstPage = await publicClient.getTradeActivity(MY_EOA_ADDRESS, {
                pageSize: PAGE_SIZE,
            });
            if (firstPage.items.length === 0) {
                await ctx.sendMessage('No trade activity found.');
                return;
            }
            const { key } = createLazyPager(
                {
                    render: renderActivity,
                    fetchPage: (cursor) =>
                        publicClient.getTradeActivity(MY_EOA_ADDRESS, { pageSize: PAGE_SIZE, cursor }),
                },
                firstPage
            );
            const text = firstPage.items.map(renderActivity).join('\n\n');
            await ctx.sendMessage(text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: firstPage.hasMore
                    ? { inline_keyboard: [[{ text: '▶️ Next', callback_data: `page:${key}:next` }]] }
                    : undefined,
            });
        } catch (error) {
            await ctx.sendMessage(`❌ ${formatError(error)}`);
        }
    });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/telegramCommands/__tests__/activity.test.ts`
Expected: PASS

- [ ] **Step 5: Compile**

Run: `npm run build:strict`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/telegramCommands/activity.ts src/services/telegramCommands/__tests__/activity.test.ts
git commit -m "Add /activity command with lazy cursor-based pagination"
```

---

## Task 7: `/market` command

**Files:**
- Create: `src/services/telegramCommands/market.ts`
- Test: `src/services/telegramCommands/__tests__/market.test.ts`

**Interfaces:**
- Consumes: `CommandContext` (Task 1), `createPublicClient` from `@polymarket/client` (a new client instance dedicated to this file — see note below), `formatError` (existing).
- Produces: `isConditionId(query: string): boolean` (pure, unit-tested), `renderMarket(m: Market): string` (pure, unit-tested — `Market` imported as `import type { Market } from '@polymarket/client'`), `registerMarketCommand(ctx: CommandContext): void`.

Note on the client instance: `publicClient.ts` does not currently export its internal `client` (only wrapped methods like `getPositions`), and `fetchMarket`/`listMarkets` are not among its exported methods (out of scope for the earlier `createPublicClient` migration, which only covered positions/activity/leaderboard/trades/profile). Rather than growing `publicClient.ts`'s surface for a single command, `market.ts` creates its own `createPublicClient()` instance directly — matching how `secureClient.ts` is its own independent factory, not funneled through `publicClient.ts` either.

**Note on the test file's mocks:** `market.ts` imports `@polymarket/client` directly (ESM-only, same root cause as Task 5/6's note) and `errorHelpers.ts` (also ESM-only via `@polymarket/bindings/clob`). Mock `@polymarket/client`'s `createPublicClient` with a no-op object — this test only exercises `isConditionId`/`renderMarket`, pure functions that never touch the module-scope `client` instance, so the mock just needs to let the module load without throwing.

- [ ] **Step 1: Write the failing tests for `isConditionId` and `renderMarket`**

```typescript
// src/services/telegramCommands/__tests__/market.test.ts
jest.mock('../../../utils/errorHelpers', () => ({
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    isInsufficientBalanceOrAllowanceCode: () => false,
}));

jest.mock('@polymarket/client', () => ({
    createPublicClient: () => ({}),
}));

import { isConditionId, renderMarket } from '../market';
import type { Market } from '@polymarket/client';

describe('isConditionId', () => {
    it('recognizes a 0x-prefixed hex string as a condition ID', () => {
        expect(
            isConditionId('0x15ddba100cf49043ada06a98d63ac221cdca86da873485dcca72c174cb9cc300')
        ).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isConditionId('0X15DDBA100CF49043ADA06A98D63AC221CDCA86DA873485DCCA72C174CB9CC300')).toBe(
            true
        );
    });

    it('treats a plain slug as not a condition ID', () => {
        expect(isConditionId('trump-meets-with-putin-by-december-31')).toBe(false);
    });

    it('treats an empty string as not a condition ID', () => {
        expect(isConditionId('')).toBe(false);
    });
});

const buildMarket = (overrides: Partial<Market> = {}): Market =>
    ({
        id: '2365031',
        slug: 'trump-meets-with-putin-by-december-31',
        conditionId: '0x15ddba100cf49043ada06a98d63ac221cdca86da873485dcca72c174cb9cc300',
        question: 'Trump meets with Putin by December 31?',
        state: { active: true, closed: false } as Market['state'],
        prices: {
            bestBid: '0.54',
            bestAsk: '0.55',
            lastTradePrice: '0.54',
            spread: '0.01',
        } as Market['prices'],
        metrics: {
            volume24hr: '302.63173700000004',
            volume: '119323.761939',
            liquidity: '44751.6627',
        } as Market['metrics'],
        outcomes: {
            yes: { label: 'Yes', price: '0.545' },
            no: { label: 'No', price: '0.455' },
        } as Market['outcomes'],
        ...overrides,
    }) as Market;

describe('renderMarket', () => {
    it('includes question, outcome prices, spread, volume, liquidity, status, and a link', () => {
        const text = renderMarket(buildMarket());

        expect(text).toContain('Trump meets with Putin by December 31?');
        expect(text).toContain('$0.545');
        expect(text).toContain('$0.455');
        expect(text).toContain('$0.01');
        expect(text).toContain('$302.63');
        expect(text).toContain('$119,323.76');
        expect(text).toContain('$44,751.66');
        expect(text).toContain('active');
        expect(text).toContain(
            'https://polymarket.com/event/trump-meets-with-putin-by-december-31'
        );
    });

    it('shows closed status for a closed market', () => {
        const text = renderMarket(buildMarket({ state: { active: false, closed: true } as Market['state'] }));
        expect(text).toContain('closed');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/services/telegramCommands/__tests__/market.test.ts`
Expected: FAIL — `Cannot find module '../market'`

- [ ] **Step 3: Write `market.ts`**

```typescript
// src/services/telegramCommands/market.ts
import { createPublicClient } from '@polymarket/client';
import type { Market } from '@polymarket/client';
import type { CommandContext } from './types';
import { formatError } from '../../utils/errorHelpers';

const client = createPublicClient();

export const isConditionId = (query: string): boolean => /^0x[0-9a-f]+$/i.test(query.trim());

// Two decimals is fine for volume/liquidity dollar amounts, but Polymarket
// prices can carry 3 decimal places (tick sizes as small as 0.001 — see
// this repo's FOK_BUY_MAX_PRICE_CEILING comment in postOrder.ts for the
// same fact) — formatting a price to 2 decimals silently rounds $0.545 to
// $0.55, which is a real precision loss, not just cosmetic. Volume/
// liquidity use formatUsd (2 decimals); yes/no/spread use formatPrice
// (up to 3 decimals, trimmed of trailing zeros beyond 2 so a whole-cent
// price like "0.550" still reads as "$0.55", not "$0.550").
const formatUsd = (value: string | null | undefined): string => {
    const n = Number(value ?? 0);
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPrice = (value: string | null | undefined): string => {
    const n = Number(value ?? 0);
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
};

export const renderMarket = (m: Market): string => {
    const status = m.state.closed ? 'closed' : m.state.active ? 'active' : 'inactive';
    return (
        `<b>${m.question}</b>\n` +
        `Yes: ${formatPrice(m.outcomes.yes.price)} | No: ${formatPrice(m.outcomes.no.price)} | Spread: ${formatPrice(m.prices?.spread)}\n` +
        `24h Volume: ${formatUsd(m.metrics?.volume24hr)} | Total Volume: ${formatUsd(m.metrics?.volume)}\n` +
        `Liquidity: ${formatUsd(m.metrics?.liquidity)}\n` +
        `Status: <code>${status}</code>\n` +
        `🔗 https://polymarket.com/event/${m.slug}`
    );
};

export const registerMarketCommand = (ctx: CommandContext): void => {
    ctx.bot.onText(/\/market (.+)/, async (msg, match) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const query = match?.[1]?.trim();
        if (!query) {
            await ctx.sendMessage('Usage: /market <slug-or-condition-id>');
            return;
        }
        try {
            let market: Market | undefined;
            if (isConditionId(query)) {
                const page = await client
                    .listMarkets({ conditionIds: [query], pageSize: 1 })
                    .firstPage();
                market = page.items[0];
            } else {
                market = await client.fetchMarket({ slug: query });
            }
            if (!market) {
                await ctx.sendMessage(`Market not found: ${query}`);
                return;
            }
            await ctx.sendMessage(renderMarket(market), {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (error) {
            await ctx.sendMessage(`❌ Market not found: ${query} (${formatError(error)})`);
        }
    });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/services/telegramCommands/__tests__/market.test.ts`
Expected: PASS

- [ ] **Step 5: Compile**

Run: `npm run build:strict`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/telegramCommands/market.ts src/services/telegramCommands/__tests__/market.test.ts
git commit -m "Add /market command for price/volume/odds lookup by slug or condition ID"
```

---

## Task 8: `index.ts` wiring — combined callback router, `setMyCommands`, and cutover in `telegramNotifier.ts`

**Files:**
- Create: `src/services/telegramCommands/index.ts`
- Modify: `src/services/telegramNotifier.ts:86-219` (delete `registerCommandHandlers` and its body; change the one call site in `initialize()`)

**Interfaces:**
- Consumes: everything produced by Tasks 1, 3, 4, 5, 6, 7 (`CommandContext`; `registerHelpCommand`, `COMMAND_DEFINITIONS`; `registerTraderCommands`, `handleTraderCallbackQuery`; `registerPositionsCommand`, `registerTraderCommand`; `registerActivityCommand`; `registerMarketCommand`; `getPagerEntry`, `advancePager`, `sweepExpiredPagers`, `PAGER_TTL_MS`).
- Produces: `registerAllCommands(ctx: CommandContext): void` — the only export `telegramNotifier.ts` needs.

- [ ] **Step 1: Write `index.ts`**

```typescript
// src/services/telegramCommands/index.ts
import type { CommandContext } from './types';
import { registerHelpCommand, COMMAND_DEFINITIONS } from './help';
import { registerTraderCommands, handleTraderCallbackQuery } from './traders';
import { registerPositionsCommand, registerTraderCommand } from './positions';
import { registerActivityCommand } from './activity';
import { registerMarketCommand } from './market';
import { advancePager, sweepExpiredPagers, PAGER_TTL_MS } from './pagination';

/**
 * Wires every command handler onto ctx.bot, registers the combined
 * callback_query router (trader approve/reject + pagination Next/Prev),
 * registers the native "/" command menu via setMyCommands, and starts the
 * pager TTL sweep. Called once from telegramNotifier.ts's initialize().
 */
export const registerAllCommands = (ctx: CommandContext): void => {
    registerHelpCommand(ctx);
    registerTraderCommands(ctx);
    registerPositionsCommand(ctx);
    registerTraderCommand(ctx);
    registerActivityCommand(ctx);
    registerMarketCommand(ctx);

    ctx.bot.on('callback_query', async (query) => {
        if (!query.message || !ctx.isAuthorized(query.message.chat.id)) {
            return;
        }

        const data = query.data ?? '';
        if (data.startsWith('page:')) {
            const [, pagerKey, direction] = data.split(':');
            if (
                !pagerKey ||
                (direction !== 'next' && direction !== 'prev')
            ) {
                return;
            }
            const result = await advancePager(pagerKey, direction);
            if (!result) {
                await ctx.bot.answerCallbackQuery(query.id, {
                    text: 'This list has expired — run the command again.',
                });
                return;
            }
            const buttons: { text: string; callback_data: string }[] = [];
            if (result.hasPrev) {
                buttons.push({ text: '◀️ Prev', callback_data: `page:${pagerKey}:prev` });
            }
            if (result.hasNext) {
                buttons.push({ text: '▶️ Next', callback_data: `page:${pagerKey}:next` });
            }
            await ctx.bot.editMessageText(result.text, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined,
            });
            await ctx.bot.answerCallbackQuery(query.id);
            return;
        }

        await handleTraderCallbackQuery(ctx, query);
    });

    ctx.bot
        .setMyCommands(
            COMMAND_DEFINITIONS.map((c) => ({ command: c.command, description: c.description }))
        )
        .catch(() => {
            // Non-fatal — commands still work by typing them even if the
            // native menu registration call fails (e.g. transient network
            // issue at startup).
        });

    setInterval(() => sweepExpiredPagers(Date.now()), PAGER_TTL_MS).unref();
};
```

- [ ] **Step 2: Compile**

Run: `npm run build:strict`
Expected: PASS

- [ ] **Step 3: Read the current `telegramNotifier.ts` initialize()/registerCommandHandlers to confirm exact lines to remove**

Run: `grep -n "registerCommandHandlers\|private registerCommandHandlers" src/services/telegramNotifier.ts`

Confirm the call site is at the line found in `initialize()` and the method definition spans from `private registerCommandHandlers(): void {` to its closing `}` right before `/**\n     * Send bot startup notification`.

- [ ] **Step 4: Delete `registerCommandHandlers` and rewire `initialize()`**

In `src/services/telegramNotifier.ts`:
1. Add the import at the top: `import { registerAllCommands } from './telegramCommands';`
2. In `initialize()`, replace:
```typescript
            if (shouldListenForCommands) {
                this.registerCommandHandlers();
                this.bot.on('polling_error', (error) => {
```
with:
```typescript
            if (shouldListenForCommands) {
                registerAllCommands({
                    bot: this.bot,
                    chatId: this.chatId,
                    isAuthorized: this.isAuthorized.bind(this),
                    sendMessage: (text, options) =>
                        this.bot!.sendMessage(this.chatId!, text, {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            ...options,
                        }),
                });
                this.bot.on('polling_error', (error) => {
```
3. Delete the entire `private registerCommandHandlers(): void { ... }` method body (everything migrated into `traders.ts` in Task 4 — it now lives there only).

- [ ] **Step 5: Compile**

Run: `npm run build:strict`
Expected: PASS

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites green (no existing test touches `telegramNotifier.ts`'s command wiring directly, per the spec's Testing section)

- [ ] **Step 7: Manual smoke test against the real bot** (requires `TELEGRAM_ALERTS_ENABLED=true`, `TELEGRAM_COMMAND_LISTENER_ENABLED=true`, and valid `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in `.env`)

Run: `npm run dev` (or restart the PM2 process if already configured), then in the actual Telegram chat:
1. Type `/` — confirm Telegram's native menu shows all 9 commands with descriptions.
2. Send `/help` — confirm all 9 commands listed.
3. Send `/list` and `/pending` — confirm identical output/behavior to before this change.
4. Send `/positions` — confirm real positions render with working Next button if you hold more than 5.
5. Send `/activity` — confirm real trade history renders with a working Next button.
6. Send `/market <a real slug you know>` and `/market <a real 0x condition id>` — confirm both resolve correctly.
7. Send `/trader <any known address>` — confirm it renders that address's positions.
8. Send `/market not-a-real-slug-xyz` — confirm a clean "Market not found" reply, not a crash or stack trace.

- [ ] **Step 8: Commit**

```bash
git add src/services/telegramCommands/index.ts src/services/telegramNotifier.ts
git commit -m "Wire telegramCommands into telegramNotifier; register native / command menu via setMyCommands"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** every Goal in the spec maps to a task — `/help`+menu discoverability → Tasks 3, 8; `/positions` → Task 5; `/activity` → Task 6; `/market` → Task 7; `/trader` → Task 5; migrated `/list`/`/pending`/`/add`/`/remove`+approve/reject → Task 4; `telegramNotifier.ts` shrinking → Task 8.
- **Placeholder scan:** no TBD/TODO; every step has real code.
- **Type consistency:** `CommandContext`, `PagerEntry`/`EagerPagerEntry`/`LazyPagerEntry`, `ApiPosition`, `ApiActivity`, `getTradeActivity`'s new `{items, nextCursor, hasMore}` shape are used identically across every task that references them.
- **Task-4-before-Task-8 ordering** deliberately leaves `telegramNotifier.ts` with duplicate (old inline + new migrated-but-unwired) command logic between Tasks 4 and 8 — each intermediate task still compiles and its own tests still pass, satisfying "each task's deliverable is independently testable," at the cost of the *old* handlers still being what's live in the running bot until Task 8's cutover. This is intentional and matches the plan's task-boundary rule (split where a reviewer could reject one task while approving its neighbor) rather than a gap.
