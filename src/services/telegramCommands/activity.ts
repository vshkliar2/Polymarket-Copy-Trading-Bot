// src/services/telegramCommands/activity.ts
import type { CommandContext } from './types';
import { createLazyPager, PAGE_SIZE } from './pagination';
import publicClient, { ApiActivity } from '../../utils/publicClient';
import MY_EOA_ADDRESS from '../../utils/getMyEOA';
import { formatError } from '../../utils/errorHelpers';
import { escapeHtml } from './htmlEscape';

export const renderActivity = (a: ApiActivity): string => {
    const date = new Date(a.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    return (
        `<b>${a.side}</b> ${a.size} <a href="https://polymarket.com/event/${escapeHtml(a.slug)}">${escapeHtml(a.title)}</a> @ $${a.price.toFixed(2)}\n` +
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
                        publicClient.getTradeActivity(MY_EOA_ADDRESS, {
                            pageSize: PAGE_SIZE,
                            cursor,
                        }),
                },
                firstPage
            );
            const text = firstPage.items.map(renderActivity).join('\n\n');
            await ctx.sendMessage(text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: firstPage.hasMore
                    ? {
                          inline_keyboard: [
                              [{ text: '▶️ Next', callback_data: `page:${key}:next` }],
                          ],
                      }
                    : undefined,
            });
        } catch (error) {
            await ctx.sendMessage(`❌ ${formatError(error)}`);
        }
    });
};
