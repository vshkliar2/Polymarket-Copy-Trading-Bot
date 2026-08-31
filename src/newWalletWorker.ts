import { RealTimeDataClient, Message } from '@polymarket/real-time-data-client';
import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import SeenWalletModel from './models/seenWallet';
import TrackedTraderModel from './models/trackedTrader';
import TelegramNotifier from './services/telegramNotifier';
import Logger from './utils/logger';
import { formatError } from './utils/errorHelpers';

let client: RealTimeDataClient | null = null;
let isRunning = true;

const handleTradeMessage = async (message: Message): Promise<void> => {
    if (message.topic !== 'activity' || message.type !== 'trades') {
        return;
    }

    const trade = message.payload as Record<string, unknown>;
    const address = String(trade.proxyWallet ?? '').toLowerCase();
    if (!address) {
        return;
    }

    try {
        const alreadySeen = await SeenWalletModel.findOne({ address }).exec();
        if (alreadySeen) {
            return; // Not this wallet's first trade in the rolling window
        }

        await SeenWalletModel.create({ address, firstSeenAt: new Date() });

        const tradeSize = typeof trade.usdcSize === 'number' ? trade.usdcSize : 0;
        if (tradeSize < ENV.NEW_WALLET_MIN_TRADE_USD) {
            return;
        }

        const existingTracked = await TrackedTraderModel.findOne({ address }).exec();
        if (existingTracked) {
            return; // Already tracked/pending/rejected — don't re-alert
        }

        const reason = `First observed trade was $${tradeSize.toFixed(0)} (threshold: $${ENV.NEW_WALLET_MIN_TRADE_USD})`;

        await TrackedTraderModel.create({
            address,
            status: 'pending',
            source: 'discovered_new_wallet',
            addedAt: new Date(),
            discoveryMeta: { firstTradeSize: tradeSize, reason },
        });

        Logger.info(`🆕 New wallet with large first trade: ${address} ($${tradeSize.toFixed(0)})`);

        await TelegramNotifier.notifyDiscoveredTrader({
            address,
            source: 'discovered_new_wallet',
            reason,
        });
    } catch (error) {
        Logger.error(`Error handling trade for new-wallet detection: ${formatError(error)}`);
    }
};

const gracefulShutdown = async (): Promise<void> => {
    isRunning = false;
    if (client) {
        client.disconnect();
    }
    await closeDB();
    process.exit(0);
};

process.on('SIGTERM', () => void gracefulShutdown());
process.on('SIGINT', () => void gracefulShutdown());

const main = async (): Promise<void> => {
    await connectDB();
    Logger.success(
        `New-wallet worker started — min trade size $${ENV.NEW_WALLET_MIN_TRADE_USD}, ${ENV.NEW_WALLET_SEEN_TTL_DAYS}-day rolling window`
    );

    client = new RealTimeDataClient({
        autoReconnect: true,
        onConnect: (rtdc) => {
            Logger.success('✅ Connected to Polymarket real-time data stream');
            rtdc.subscribe({ subscriptions: [{ topic: 'activity', type: 'trades' }] });
            Logger.success('✅ Subscribed to activity/trades firehose');
        },
        onMessage: (_rtdc, message) => {
            if (isRunning) {
                void handleTradeMessage(message);
            }
        },
    });

    client.connect();
};

main();
