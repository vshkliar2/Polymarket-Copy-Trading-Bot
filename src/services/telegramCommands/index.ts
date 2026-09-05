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
            if (!pagerKey || (direction !== 'next' && direction !== 'prev')) {
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
