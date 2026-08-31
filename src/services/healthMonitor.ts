import TelegramNotifier from './telegramNotifier';
import { performHealthCheck } from '../utils/healthCheck';
import Logger from '../utils/logger';
import mongoose from 'mongoose';
import { ethers } from 'ethers';
import { ENV } from '../config/env';

/**
 * Health Monitor Service
 * Periodically checks bot health and sends notifications
 */
class HealthMonitor {
    private interval: NodeJS.Timeout | null = null;
    private startTime: number = Date.now();
    private lastHealthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    /**
     * Start periodic health monitoring
     * @param intervalHours - How often to check (default: 6 hours)
     */
    start(intervalHours: number = 6): void {
        const intervalMs = intervalHours * 60 * 60 * 1000;

        Logger.info(`Starting health monitor (checking every ${intervalHours} hours)`);

        // Run initial health check after 5 minutes
        setTimeout(() => {
            this.checkHealth();
        }, 5 * 60 * 1000);

        // Then run periodically
        this.interval = setInterval(() => {
            this.checkHealth();
        }, intervalMs);
    }

    /**
     * Stop health monitoring
     */
    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            Logger.info('Health monitor stopped');
        }
    }

    /**
     * Perform health check and send notification
     */
    private async checkHealth(): Promise<void> {
        try {
            Logger.info('Performing scheduled health check...');

            const healthResult = await performHealthCheck();

            // Determine overall health status
            let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

            const mongoOk = healthResult.checks.database.status === 'ok';
            const rpcOk = healthResult.checks.rpc.status === 'ok';
            const balanceOk = healthResult.checks.balance.status === 'ok';
            const balanceWarning = healthResult.checks.balance.status === 'warning';

            if (!mongoOk || !rpcOk) {
                status = 'unhealthy';
            } else if (balanceWarning) {
                status = 'degraded';
            }

            // Get uptime
            const uptime = Math.floor((Date.now() - this.startTime) / 1000);

            // Get open positions count (simplified - you can enhance this)
            const openPositions = 0; // TODO: Query from database

            // Send notification
            await TelegramNotifier.notifyHealth({
                status,
                mongodb: mongoOk,
                rpc: rpcOk,
                balance: healthResult.checks.balance.balance || 0,
                openPositions,
                uptime,
            });

            // Alert on status change
            if (status !== this.lastHealthStatus) {
                if (status === 'unhealthy') {
                    await TelegramNotifier.notifyError({
                        title: 'Health Status Degraded',
                        message: `Bot health changed from ${this.lastHealthStatus} to ${status}`,
                        severity: 'high',
                    });
                } else if (status === 'healthy' && this.lastHealthStatus !== 'healthy') {
                    await TelegramNotifier.notify(
                        '✅ <b>Health Restored</b>\n\nBot is now healthy and operational.'
                    );
                }
                this.lastHealthStatus = status;
            }

            Logger.success('Health check completed');
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            Logger.error(`Health check failed: ${errorMsg}`);

            await TelegramNotifier.notifyError({
                title: 'Health Check Failed',
                message: errorMsg,
                severity: 'medium',
            });
        }
    }

    /**
     * Manually trigger health check
     */
    async checkNow(): Promise<void> {
        await this.checkHealth();
    }
}

// Export singleton instance
export default new HealthMonitor();
