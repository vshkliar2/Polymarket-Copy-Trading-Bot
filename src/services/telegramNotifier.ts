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
            this.bot = new TelegramBot(token, { polling: false });
            this.chatId = chatId;
            this.enabled = true;
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
    }): Promise<void> {
        const emoji = trade.side === 'BUY' ? '🟢' : '🔴';
        const status = trade.success ? '✅' : '❌';

        const message = `
${emoji} <b>${trade.side} Order ${status}</b>

Market: <code>${trade.market.substring(0, 50)}</code>
Side: <b>${trade.side}</b>
Amount: <b>$${trade.amount.toFixed(2)}</b>
Price: <b>$${trade.price.toFixed(3)}</b>

Copied from: <code>${trade.traderAddress.substring(0, 10)}...</code>
Time: ${new Date().toISOString().replace('T', ' ').substring(0, 19)}
        `.trim();

        await this.sendMessage(message);
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
