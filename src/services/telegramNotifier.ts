import TelegramBot from 'node-telegram-bot-api';
import { ENV } from '../config/env';
import Logger from '../utils/logger';

/**
 * Telegram Notifier Service
 * Sends alerts and notifications to Telegram
 */
class TelegramNotifier {
    private bot: TelegramBot | null = null;
    private chatId: string | null = null;
    private enabled: boolean = false;

    constructor() {
        this.initialize();
    }

    /**
     * Initialize Telegram bot
     */
    private initialize(): void {
        const token = ENV.TELEGRAM_BOT_TOKEN;
        const chatId = ENV.TELEGRAM_CHAT_ID;
        const enabled = ENV.TELEGRAM_ALERTS_ENABLED;

        if (!enabled) {
            Logger.info('Telegram alerts disabled');
            return;
        }

        if (!token || !chatId) {
            Logger.warning(
                'Telegram alerts enabled but TOKEN or CHAT_ID missing. Alerts will be disabled.'
            );
            return;
        }

        try {
            this.bot = new TelegramBot(token, { polling: true });
            this.chatId = chatId;
            this.enabled = true;
            this.registerCommandHandlers();
            Logger.info('✅ Telegram notifier initialized');
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            Logger.error(`Failed to initialize Telegram bot: ${errorMsg}`);
        }
    }

    /**
     * Send a message to Telegram
     */
    private async sendMessage(message: string): Promise<void> {
        if (!this.enabled || !this.bot || !this.chatId) {
            return;
        }

        try {
            await this.bot.sendMessage(this.chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            Logger.error(`Failed to send Telegram message: ${errorMsg}`);
        }
    }

    private isAuthorized(chatId: number | string): boolean {
        return String(chatId) === this.chatId;
    }

    private registerCommandHandlers(): void {
        if (!this.bot) {
            return;
        }

        this.bot.onText(/\/list/, async (msg) => {
            if (!this.isAuthorized(msg.chat.id)) {
                return;
            }
            try {
                const { listTraders } = await import('./trackedTraders');
                const traders = await listTraders('active');
                if (traders.length === 0) {
                    await this.sendMessage('No active tracked traders.');
                    return;
                }
                const lines = traders.map(
                    (t) =>
                        `• <code>${t.address}</code> (${t.source}, added ${t.addedAt.toISOString().slice(0, 10)})`
                );
                await this.sendMessage(
                    `<b>Active Traders (${traders.length})</b>\n\n${lines.join('\n')}`
                );
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                await this.sendMessage(`❌ Error listing traders: ${errorMsg}`);
            }
        });

        this.bot.onText(/\/pending/, async (msg) => {
            if (!this.isAuthorized(msg.chat.id)) {
                return;
            }
            try {
                const { listTraders } = await import('./trackedTraders');
                const traders = await listTraders('pending');
                if (traders.length === 0) {
                    await this.sendMessage('No pending trader candidates.');
                    return;
                }
                const lines = traders.map(
                    (t) =>
                        `• <code>${t.address}</code> (${t.source})${t.discoveryMeta ? `\n  ${t.discoveryMeta.reason}` : ''}`
                );
                await this.sendMessage(
                    `<b>Pending Candidates (${traders.length})</b>\n\n${lines.join('\n')}`
                );
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                await this.sendMessage(`❌ Error listing pending traders: ${errorMsg}`);
            }
        });

        this.bot.onText(/\/add (.+)/, async (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) {
                return;
            }
            const address = match?.[1]?.trim();
            if (!address) {
                await this.sendMessage('Usage: /add 0xADDRESS');
                return;
            }
            try {
                const { addManualTrader } = await import('./trackedTraders');
                await addManualTrader(address, String(msg.from?.id ?? 'telegram'));
                await this.sendMessage(`✅ Added <code>${address}</code> to active traders.`);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                await this.sendMessage(`❌ ${errorMsg}`);
            }
        });

        this.bot.onText(/\/remove (.+)/, async (msg, match) => {
            if (!this.isAuthorized(msg.chat.id)) {
                return;
            }
            const address = match?.[1]?.trim();
            if (!address) {
                await this.sendMessage('Usage: /remove 0xADDRESS');
                return;
            }
            try {
                const { removeTrader } = await import('./trackedTraders');
                const removed = await removeTrader(address);
                await this.sendMessage(
                    removed
                        ? `✅ Removed <code>${address}</code> from active traders.`
                        : `⚠️ <code>${address}</code> was not found or already inactive.`
                );
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                await this.sendMessage(`❌ ${errorMsg}`);
            }
        });

        this.bot.on('callback_query', async (query) => {
            if (!query.message || !this.isAuthorized(query.message.chat.id)) {
                return;
            }
            const data = query.data ?? '';
            const [action, address] = data.split(':');
            if (!address || (action !== 'approve' && action !== 'reject')) {
                return;
            }

            try {
                const { addManualTrader, removeTrader } = await import('./trackedTraders');
                if (action === 'approve') {
                    await addManualTrader(address, String(query.from.id));
                    await this.bot!.answerCallbackQuery(query.id, { text: `Approved ${address}` });
                    await this.bot!.sendMessage(
                        this.chatId!,
                        `✅ Approved <code>${address}</code>`,
                        {
                            parse_mode: 'HTML',
                        }
                    );
                } else {
                    await removeTrader(address);
                    await this.bot!.answerCallbackQuery(query.id, { text: `Rejected ${address}` });
                    await this.bot!.sendMessage(
                        this.chatId!,
                        `❌ Rejected <code>${address}</code>`,
                        {
                            parse_mode: 'HTML',
                        }
                    );
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                await this.bot!.answerCallbackQuery(query.id, { text: `Error: ${errorMsg}` });
            }
        });
    }

    /**
     * Send bot startup notification
     */
    async notifyStartup(): Promise<void> {
        const message = `
🤖 <b>Bot Started</b>

Status: <code>Online</code>
Time: ${new Date().toISOString()}
Wallet: <code>${ENV.PROXY_WALLET?.substring(0, 10)}...</code>

The bot is now monitoring trades.
        `.trim();

        await this.sendMessage(message);
    }

    /**
     * Send bot shutdown notification
     */
    async notifyShutdown(): Promise<void> {
        const message = `
🛑 <b>Bot Stopped</b>

Status: <code>Offline</code>
Time: ${new Date().toISOString()}

The bot has been shut down.
        `.trim();

        await this.sendMessage(message);
    }

    /**
     * Send trade execution notification
     */
    async notifyTrade(trade: {
        market: string;
        side: 'BUY' | 'SELL';
        amount: number;
        price: number;
        traderAddress: string;
        success: boolean;
        reason?: string;
        retryAttempts?: number;
        traderAmount?: number;
        yourBalance?: number;
        transactionHash?: string;
        dryRun?: boolean;
    }): Promise<void> {
        const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
        const status = trade.success ? '✅ SUCCESS' : '❌ FAILED';
        const dryRunPrefix = trade.dryRun ? '🧪 [DRY RUN — no real order placed] ' : '';

        let message = `
${dryRunPrefix}${emoji} <b>${trade.side} Order ${status}</b>

<b>Market:</b> ${trade.market.substring(0, 60)}
<b>Side:</b> ${trade.side}
<b>Your Amount:</b> $${trade.amount.toFixed(2)}
<b>Price:</b> $${trade.price.toFixed(3)}`;

        // Add trader's original amount if available
        if (trade.traderAmount) {
            message += `\n<b>Trader Amount:</b> $${trade.traderAmount.toFixed(2)}`;
        }

        // Add your balance
        if (trade.yourBalance) {
            message += `\n<b>Your Balance:</b> $${trade.yourBalance.toFixed(2)}`;
        }

        // Add failure reason if failed
        if (!trade.success && trade.reason) {
            message += `\n\n<b>❌ Reason:</b> ${trade.reason}`;
        }

        // Add retry information
        if (trade.retryAttempts && trade.retryAttempts > 0) {
            message += `\n<b>Attempts:</b> ${trade.retryAttempts}`;
        }

        // Add transaction hash if successful
        if (trade.success && trade.transactionHash) {
            message += `\n\n<b>TX:</b> <code>${trade.transactionHash}</code>`;
        }

        message += `\n\n<b>Trader:</b> <code>${trade.traderAddress.substring(0, 10)}...</code>
<b>Time:</b> ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`;

        await this.sendMessage(message.trim());
    }

    /**
     * Send a discovery alert with inline Approve/Reject buttons
     */
    async notifyDiscoveredTrader(candidate: {
        address: string;
        source: 'discovered_leaderboard' | 'discovered_new_wallet';
        reason: string;
    }): Promise<void> {
        if (!this.enabled || !this.bot || !this.chatId) {
            return;
        }

        const sourceLabel =
            candidate.source === 'discovered_leaderboard' ? '📊 Leaderboard' : '🆕 New Wallet';
        const message = `
${sourceLabel} <b>Trader Candidate Found</b>

<b>Address:</b> <code>${candidate.address}</code>
<b>Reason:</b> ${candidate.reason}
    `.trim();

        try {
            await this.bot.sendMessage(this.chatId, message, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Approve', callback_data: `approve:${candidate.address}` },
                            { text: '❌ Reject', callback_data: `reject:${candidate.address}` },
                        ],
                    ],
                },
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            Logger.error(`Failed to send discovery alert: ${errorMsg}`);
        }
    }

    /**
     * Send error notification
     */
    async notifyError(error: {
        title: string;
        message: string;
        severity: 'low' | 'medium' | 'high' | 'critical';
    }): Promise<void> {
        const emojiMap = {
            low: '⚠️',
            medium: '⚠️',
            high: '🚨',
            critical: '❌',
        };

        const emoji = emojiMap[error.severity];

        const message = `
${emoji} <b>${error.title}</b>

Severity: <code>${error.severity.toUpperCase()}</code>
Message: ${error.message}

Time: ${new Date().toISOString().replace('T', ' ').substring(0, 19)}
        `.trim();

        await this.sendMessage(message);
    }

    /**
     * Send health check notification
     */
    async notifyHealth(health: {
        status: 'healthy' | 'degraded' | 'unhealthy';
        mongodb: boolean;
        rpc: boolean;
        balance: number;
        openPositions: number;
        uptime: number;
    }): Promise<void> {
        const statusEmoji =
            health.status === 'healthy' ? '✅' : health.status === 'degraded' ? '⚠️' : '❌';

        const mongoEmoji = health.mongodb ? '✅' : '❌';
        const rpcEmoji = health.rpc ? '✅' : '❌';

        const uptimeHours = Math.floor(health.uptime / 3600);
        const uptimeMins = Math.floor((health.uptime % 3600) / 60);

        const message = `
📊 <b>Health Check</b>

Overall: ${statusEmoji} <b>${health.status.toUpperCase()}</b>

Services:
${mongoEmoji} MongoDB
${rpcEmoji} RPC Connection

Wallet:
💰 Balance: <b>$${health.balance.toFixed(2)}</b>
📈 Open Positions: <b>${health.openPositions}</b>

Uptime: <code>${uptimeHours}h ${uptimeMins}m</code>
Time: ${new Date().toISOString().replace('T', ' ').substring(0, 19)}
        `.trim();

        await this.sendMessage(message);
    }

    /**
     * Send daily summary notification
     */
    async notifyDailySummary(summary: {
        date: string;
        trades: number;
        volume: number;
        pnl: number;
        winRate: number;
        openPositions: number;
        balance: number;
    }): Promise<void> {
        const pnlEmoji = summary.pnl >= 0 ? '📈' : '📉';
        const pnlSign = summary.pnl >= 0 ? '+' : '';

        const message = `
📊 <b>Daily Summary</b>
${summary.date}

Trading:
• Trades: <b>${summary.trades}</b>
• Volume: <b>$${summary.volume.toFixed(2)}</b>
• Win Rate: <b>${summary.winRate.toFixed(1)}%</b>

Performance:
${pnlEmoji} P&L: <b>${pnlSign}$${summary.pnl.toFixed(2)}</b>

Current:
• Open Positions: <b>${summary.openPositions}</b>
• Balance: <b>$${summary.balance.toFixed(2)}</b>
        `.trim();

        await this.sendMessage(message);
    }

    /**
     * Send deployment notification
     */
    async notifyDeployment(deployment: {
        status: 'started' | 'completed' | 'failed';
        version?: string;
        error?: string;
    }): Promise<void> {
        let message: string;

        if (deployment.status === 'started') {
            message = `
🚀 <b>Deployment Started</b>

Status: <code>Pulling latest changes...</code>
Time: ${new Date().toISOString().replace('T', ' ').substring(0, 19)}
            `.trim();
        } else if (deployment.status === 'completed') {
            message = `
✅ <b>Deployment Complete</b>

Status: <code>Bot restarted successfully</code>
Version: <code>${deployment.version || 'unknown'}</code>
Time: ${new Date().toISOString().replace('T', ' ').substring(0, 19)}
            `.trim();
        } else {
            message = `
❌ <b>Deployment Failed</b>

Status: <code>Deployment error</code>
Error: ${deployment.error || 'Unknown error'}
Time: ${new Date().toISOString().replace('T', ' ').substring(0, 19)}

Action required!
            `.trim();
        }

        await this.sendMessage(message);
    }

    /**
     * Send custom notification
     */
    async notify(message: string): Promise<void> {
        await this.sendMessage(message);
    }

    /**
     * Check if Telegram is enabled
     */
    isEnabled(): boolean {
        return this.enabled;
    }
}

// Export singleton instance
export default new TelegramNotifier();
