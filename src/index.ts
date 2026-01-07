import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import TelegramNotifier from './services/telegramNotifier';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

/**
 * Flag to prevent multiple shutdown attempts
 */
let isShuttingDown = false;

/**
 * Gracefully shuts down the application
 * Stops all services, closes database connections, and exits cleanly
 *
 * @param signal - The signal that triggered the shutdown (e.g., 'SIGTERM', 'SIGINT')
 */
const gracefulShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Send shutdown notification
        await TelegramNotifier.notifyShutdown();

        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`Error during shutdown: ${errorMessage}`);
        if (error instanceof Error && error.stack) {
            Logger.error(`Stack trace: ${error.stack}`);
        }
        process.exit(1);
    }
};

/**
 * Handle unhandled promise rejections
 * Logs the error but doesn't exit to allow the application to recover
 */
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    const reasonMessage = reason instanceof Error ? reason.message : String(reason);
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reasonMessage}`);
    if (reason instanceof Error && reason.stack) {
        Logger.error(`Stack trace: ${reason.stack}`);
    }
    // Don't exit immediately, let the application try to recover
});

/**
 * Handle uncaught exceptions
 * Exits immediately as the application is in an undefined state
 */
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    if (error.stack) {
        Logger.error(`Stack trace: ${error.stack}`);
    }
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

/**
 * Handle termination signals
 */
process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch(() => {
        process.exit(1);
    });
});
process.on('SIGINT', () => {
    gracefulShutdown('SIGINT').catch(() => {
        process.exit(1);
    });
});

/**
 * Main application entry point
 * Initializes database, performs health checks, and starts trading services
 *
 * @throws {Error} If initialization fails
 */
export const main = async (): Promise<void> => {
    try {
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
        };
        
        console.log(`\n${colors.yellow}💡 First time running the bot?${colors.reset}`);
        console.log(`   Read the guide: ${colors.cyan}GETTING_STARTED.md${colors.reset}`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);
        
        await connectDB();
        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        Logger.info('Initializing CLOB client...');
        const clobClient = await createClobClient();
        Logger.success('CLOB client ready');

        Logger.separator();
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        Logger.info('Starting trade executor...');
        tradeExecutor(clobClient);

        // Send startup notification
        await TelegramNotifier.notifyStartup();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`Fatal error during startup: ${errorMessage}`);
        if (error instanceof Error && error.stack) {
            Logger.error(`Stack trace: ${error.stack}`);
        }

        // Send error notification
        await TelegramNotifier.notifyError({
            title: 'Bot Startup Failed',
            message: errorMessage,
            severity: 'critical',
        });

        await gracefulShutdown('startup-error');
    }
};

main();
