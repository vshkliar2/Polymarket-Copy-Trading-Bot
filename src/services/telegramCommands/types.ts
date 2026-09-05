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
