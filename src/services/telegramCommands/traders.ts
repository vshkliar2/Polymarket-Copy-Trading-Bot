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
                await ctx.sendMessage('No active tracked traders.', {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
                return;
            }
            const lines = traders.map(
                (t) =>
                    `• <code>${t.address}</code> (${t.source}, added ${t.addedAt.toISOString().slice(0, 10)})`
            );
            await ctx.sendMessage(
                `<b>Active Traders (${traders.length})</b>\n\n${lines.join('\n')}`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        } catch (error) {
            await ctx.sendMessage(`❌ Error listing traders: ${formatError(error)}`, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
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
                await ctx.sendMessage('No pending trader candidates.', {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
                return;
            }
            const lines = traders.map(
                (t) =>
                    `• <code>${t.address}</code> (${t.source})${t.discoveryMeta ? `\n  ${t.discoveryMeta.reason}` : ''}`
            );
            await ctx.sendMessage(
                `<b>Pending Candidates (${traders.length})</b>\n\n${lines.join('\n')}`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        } catch (error) {
            await ctx.sendMessage(`❌ Error listing pending traders: ${formatError(error)}`, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        }
    });

    ctx.bot.onText(/\/add (.+)/, async (msg, match) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await ctx.sendMessage('Usage: /add 0xADDRESS', {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            return;
        }
        try {
            const { addManualTrader } = await import('../trackedTraders');
            await addManualTrader(address, String(msg.from?.id ?? 'telegram'));
            await ctx.sendMessage(`✅ Added <code>${address}</code> to active traders.`, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (error) {
            await ctx.sendMessage(`❌ ${formatError(error)}`, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        }
    });

    ctx.bot.onText(/\/remove (.+)/, async (msg, match) => {
        if (!ctx.isAuthorized(msg.chat.id)) {
            return;
        }
        const address = match?.[1]?.trim();
        if (!address) {
            await ctx.sendMessage('Usage: /remove 0xADDRESS', {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            return;
        }
        try {
            const { removeTrader } = await import('../trackedTraders');
            const removed = await removeTrader(address);
            await ctx.sendMessage(
                removed
                    ? `✅ Removed <code>${address}</code> from active traders.`
                    : `⚠️ <code>${address}</code> was not found or already inactive.`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        } catch (error) {
            await ctx.sendMessage(`❌ ${formatError(error)}`, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
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
