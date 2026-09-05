import { createPublicClient } from '@polymarket/client';
import type { Market } from '@polymarket/client';
import type { CommandContext } from './types';
import { formatError } from '../../utils/errorHelpers';
import { escapeHtml } from './htmlEscape';

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
        `<b>${escapeHtml(m.question ?? '')}</b>\n` +
        `Yes: ${formatPrice(m.outcomes.yes.price)} | No: ${formatPrice(m.outcomes.no.price)} | Spread: ${formatPrice(m.prices?.spread)}\n` +
        `24h Volume: ${formatUsd(m.metrics?.volume24hr)} | Total Volume: ${formatUsd(m.metrics?.volume)}\n` +
        `Liquidity: ${formatUsd(m.metrics?.liquidity)}\n` +
        `Status: <code>${status}</code>\n` +
        `🔗 https://polymarket.com/event/${m.slug}`
    );
};

export const registerMarketCommand = (ctx: CommandContext): void => {
    ctx.bot.onText(/^\/market(?:\s+(.+))?$/, async (msg, match) => {
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
