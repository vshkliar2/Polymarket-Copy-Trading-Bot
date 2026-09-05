// src/services/telegramCommands/positions.ts
import type { CommandContext } from './types';
import { createEagerPager, PAGE_SIZE } from './pagination';
import publicClient, { ApiPosition } from '../../utils/publicClient';
import MY_EOA_ADDRESS from '../../utils/getMyEOA';
import { formatError } from '../../utils/errorHelpers';
import { escapeHtml } from './htmlEscape';

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
        `<b>${escapeHtml(p.title)}</b> — ${escapeHtml(p.outcome)}\n` +
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
    ctx.bot.onText(/^\/trader(?:\s+(.+))?$/, async (msg, match) => {
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
