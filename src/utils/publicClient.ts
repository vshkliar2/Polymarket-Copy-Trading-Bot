import { ActivityType, createPublicClient } from '@polymarket/client';
import type { ClosedPosition, Position, TradeActivity } from '@polymarket/client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';

// UserPositionInterface/UserActivityInterface (interfaces/User.ts) model
// Mongoose DOCUMENTS, so they require `_id`. API responses have no `_id` —
// one is assigned only once a trade/position is saved to Mongo — so every
// method below returns this narrower shape instead of lying about having an
// `_id` that doesn't exist yet.
export type ApiPosition = Omit<UserPositionInterface, '_id'>;
export type ApiActivity = Omit<UserActivityInterface, '_id'>;

/**
 * Typed wrapper around @polymarket/client's createPublicClient() — the SDK's
 * unauthenticated read client for positions, activity, closed positions,
 * trades, and leaderboard data. Distinct from secureClient.ts, which
 * authenticates against the CLOB for order placement.
 *
 * Every method here maps the SDK's response shape back to this repo's
 * existing UserPositionInterface/UserActivityInterface (the shape MongoDB's
 * schemas in models/userHistory.ts store, mirroring the raw
 * data-api.polymarket.com REST response this repo was built against) rather
 * than exposing the SDK's shape directly, since they differ in both field
 * names and types:
 *   - `wallet` (SDK) vs `proxyWallet` (this repo's interfaces)
 *   - `assetId`/`tokenId` (SDK) vs `asset` (this repo's interfaces)
 *   - decimal fields as strings (SDK, e.g. size: "250") vs number (this
 *     repo's interfaces, throughout — matching the raw REST API's JSON
 *     numbers) — Number(...) here is safe because these are the same
 *     decimal-string values `JSON.parse` would otherwise have already
 *     parsed as a `number` from the raw endpoint, just formatted as a
 *     string by the SDK's zod schema instead.
 *   - Activity's `shares`/`amount` (SDK) vs `size`/`usdcSize` (this repo's
 *     interfaces) — same semantics (token count / dollar amount), renamed.
 *
 * The SDK's own pagination (`Paginated<T>`, cursor-based via `firstPage()`/
 * `.from(cursor)`) replaces this file's previous hand-rolled offset-based
 * paging loop entirely — callers that need every page now just iterate
 * `for await (const page of paginated)` (see getAllPositions below) instead
 * of positionHelpers.ts driving its own limit/offset loop.
 */

const client = createPublicClient();

// Position's fields are typed nullable throughout (the SDK models them as
// possibly absent even though a normal /positions response always
// populates them) — `?? fallback` on every field keeps this a straight
// mapping rather than letting `null`/`undefined` leak into a shape whose
// consumers (Mongo schemas, arithmetic on size/price, etc.) never handled
// missing values.
const toUserPosition = (p: Position): ApiPosition => ({
    proxyWallet: p.wallet ?? '',
    asset: p.assetId ?? p.tokenId ?? '',
    conditionId: p.conditionId ?? '',
    size: Number(p.size ?? 0),
    avgPrice: Number(p.avgPrice ?? 0),
    initialValue: Number(p.initialValue ?? 0),
    currentValue: Number(p.currentValue ?? 0),
    cashPnl: Number(p.cashPnl ?? 0),
    percentPnl: p.percentPnl ?? 0,
    totalBought: Number(p.totalBought ?? 0),
    realizedPnl: Number(p.realizedPnl ?? 0),
    percentRealizedPnl: p.percentRealizedPnl ?? 0,
    curPrice: Number(p.curPrice ?? 0),
    redeemable: p.redeemable ?? false,
    mergeable: p.mergeable ?? false,
    title: p.title ?? '',
    slug: p.slug ?? '',
    icon: p.icon ?? '',
    eventSlug: p.eventSlug ?? '',
    outcome: p.outcome ?? '',
    outcomeIndex: p.outcomeIndex ?? 0,
    oppositeOutcome: p.oppositeOutcome ?? '',
    oppositeAsset: p.oppositeAssetId ?? p.oppositeTokenId ?? '',
    endDate: p.endDate ?? '',
    negativeRisk: p.negativeRisk ?? false,
});

/**
 * Maps a single-market TradeActivity item back to ApiActivity.
 *
 * TradeActivity is itself a union of the single-market trade shape and
 * ComboTradeActivity (multi-outcome combo trades), which lacks assetId/
 * tokenId/slug/eventSlug/outcome/outcomeIndex entirely — this repo has no
 * combo-market support anywhere else (positions, sizing, order placement
 * all assume one binary market per trade), so combo trades are filtered out
 * by the `isCombo === false` guard below rather than mapped with fabricated
 * fields. `a.isCombo === false` is what TypeScript needs to actually narrow
 * the union (checked directly, not inferred from the request's `type`
 * filter, which the SDK can't reflect statically either).
 */
const toUserActivity = (a: TradeActivity): ApiActivity | undefined => {
    if (a.isCombo !== false) {
        return undefined;
    }
    return {
        proxyWallet: a.wallet ?? '',
        timestamp: a.timestamp ?? 0,
        conditionId: a.conditionId ?? '',
        type: a.type,
        size: Number(a.shares ?? 0),
        usdcSize: Number(a.amount ?? 0),
        transactionHash: a.transactionHash ?? '',
        price: Number(a.price ?? 0),
        asset: a.assetId ?? a.tokenId ?? '',
        side: a.side ?? '',
        outcomeIndex: a.outcomeIndex ?? 0,
        title: a.title ?? '',
        slug: a.slug ?? '',
        icon: a.icon ?? '',
        eventSlug: a.eventSlug ?? '',
        outcome: a.outcome ?? '',
        name: a.name ?? '',
        pseudonym: a.pseudonym ?? '',
        bio: a.bio ?? '',
        profileImage: a.profileImage ?? '',
        profileImageOptimized: a.profileImageOptimized ?? '',
        bot: false,
        botExcutedTime: 0,
    };
};

export interface LeaderboardEntry {
    [key: string]: unknown;
}

export interface TradeEntry {
    [key: string]: unknown;
}

export interface UserProfile {
    [key: string]: unknown;
}

/**
 * Fetches one page of a user's positions. Pass `market` to scope to a
 * single condition ID (see fetchPositionForMarket's usage in
 * positionHelpers.ts); omit `pageSize`/`cursor` for the SDK's default page.
 */
const getPositions = async (
    userAddress: string,
    options?: { pageSize?: number; market?: string }
): Promise<ApiPosition[]> => {
    const page = await client
        .listPositions({
            user: userAddress,
            pageSize: options?.pageSize,
            market: options?.market ? [options.market] : undefined,
        })
        .firstPage();
    return page.items.map(toUserPosition);
};

/**
 * Fetches every position for a user, paging through the SDK's cursor-based
 * pagination until exhausted. Replaces the previous hand-rolled
 * limit/offset loop in positionHelpers.ts's fetchAllPositions.
 */
const getAllPositions = async (userAddress: string): Promise<ApiPosition[]> => {
    const all: ApiPosition[] = [];
    const paginated = client.listPositions({ user: userAddress, pageSize: 500 });
    for await (const page of paginated) {
        all.push(...page.items.map(toUserPosition));
    }
    return all;
};

/**
 * Fetches a user's closed (resolved/settled) positions.
 */
const toClosedApiPosition = (c: ClosedPosition): ApiPosition => ({
    proxyWallet: c.wallet ?? '',
    asset: c.assetId ?? c.tokenId ?? '',
    conditionId: c.conditionId ?? '',
    size: 0,
    avgPrice: Number(c.avgPrice),
    initialValue: 0,
    currentValue: 0,
    cashPnl: 0,
    percentPnl: 0,
    totalBought: Number(c.totalBought),
    realizedPnl: Number(c.realizedPnl),
    percentRealizedPnl: 0,
    curPrice: Number(c.curPrice),
    redeemable: false,
    mergeable: false,
    title: c.title ?? '',
    slug: c.slug ?? '',
    icon: c.icon ?? '',
    eventSlug: c.eventSlug ?? '',
    outcome: c.outcome ?? '',
    outcomeIndex: c.outcomeIndex ?? 0,
    oppositeOutcome: '',
    oppositeAsset: c.oppositeAssetId ?? c.oppositeTokenId ?? '',
    endDate: c.endDate ?? '',
    negativeRisk: false,
});

/**
 * Fetches a user's closed (resolved/settled) positions.
 *
 * ClosedPosition lacks a few live-position-only fields (currentValue,
 * cashPnl, percentPnl, redeemable, mergeable, oppositeOutcome, negativeRisk)
 * — defaulted in toClosedApiPosition above since ApiPosition has no optional
 * fields and callers of getClosedPositions historically read this same
 * shape from the raw REST API, which included them as 0/false for closed
 * positions too.
 */
const getClosedPositions = async (userAddress: string): Promise<ApiPosition[]> => {
    const page = await client.listClosedPositions({ user: userAddress }).firstPage();
    return page.items.map(toClosedApiPosition);
};

/**
 * Fetches a user's TRADE activity. Pass `pageSize` to page through full
 * history, or omit it for a single default-sized page.
 */
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

/**
 * Fetches the all-time trader leaderboard. Returned rows are intentionally
 * loosely typed (`LeaderboardEntry`) rather than cast to a fixed interface —
 * callers (e.g. discoverTraders.ts) already reshape rows into their own
 * local types with defensive fallbacks for inconsistent field naming.
 */
const getLeaderboard = async (limit: number): Promise<LeaderboardEntry[]> => {
    const page = await client
        .listTraderLeaderboard({ orderBy: 'PNL', pageSize: limit, timePeriod: 'ALL' })
        .firstPage();
    return page.items as unknown as LeaderboardEntry[];
};

/**
 * Fetches trades either for a user or for a specific market — exactly one
 * of `userAddress`/`market` should be passed, matching listTrades' own
 * mutually-exclusive request shape.
 */
const getTrades = async (
    filter: { userAddress: string; limit?: number } | { market: string; limit?: number }
): Promise<TradeEntry[]> => {
    const request =
        'userAddress' in filter
            ? { user: filter.userAddress, pageSize: filter.limit }
            : { market: [filter.market], pageSize: filter.limit };
    const page = await client.listTrades(request).firstPage();
    return page.items as unknown as TradeEntry[];
};

/**
 * Fetches a user's public profile (username, bio, etc.) by address.
 */
const getUserProfile = async (address: string): Promise<UserProfile | undefined> => {
    const profile = await client.fetchPublicProfile({ address });
    return (profile as UserProfile | null) ?? undefined;
};

const publicClient = {
    getPositions,
    getAllPositions,
    getClosedPositions,
    getTradeActivity,
    getLeaderboard,
    getTrades,
    getUserProfile,
};

export default publicClient;
