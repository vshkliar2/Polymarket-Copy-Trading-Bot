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
