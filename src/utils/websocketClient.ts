import WebSocket from 'ws';
import Logger from './logger';

/**
 * WebSocket Client Wrapper
 * Handles connection, reconnection, and message handling for Polymarket WebSocket API
 */
export class PolymarketWebSocketClient {
    private ws: WebSocket | null = null;
    private url: string;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;
    private reconnectDelay: number = 1000; // Start with 1 second
    private maxReconnectDelay: number = 60000; // Max 60 seconds
    private isIntentionallyClosed: boolean = false;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private messageHandlers: Set<(data: any) => void> = new Set();
    private connectionPromise: Promise<void> | null = null;

    constructor(url: string) {
        this.url = url;
    }

    /**
     * Connect to WebSocket server
     */
    async connect(): Promise<void> {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = new Promise((resolve, reject) => {
            try {
                Logger.info(`Connecting to WebSocket: ${this.url}`);
                this.ws = new WebSocket(this.url);

                this.ws.on('open', () => {
                    Logger.success('✅ WebSocket connected');
                    this.reconnectAttempts = 0;
                    this.reconnectDelay = 1000;
                    this.isIntentionallyClosed = false;
                    this.startPingInterval();
                    this.connectionPromise = null;
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMessage(message);
                    } catch (error) {
                        Logger.error(`Failed to parse WebSocket message: ${error}`);
                    }
                });

                this.ws.on('error', (error: Error) => {
                    Logger.error(`WebSocket error: ${error.message}`);
                    this.connectionPromise = null;
                    reject(error);
                });

                this.ws.on('close', (code: number, reason: string) => {
                    Logger.warning(`WebSocket closed: ${code} - ${reason || 'No reason provided'}`);
                    this.cleanup();
                    this.connectionPromise = null;

                    if (!this.isIntentionallyClosed) {
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('ping', () => {
                    if (this.ws) {
                        this.ws.pong();
                    }
                });
            } catch (error) {
                this.connectionPromise = null;
                reject(error);
            }
        });

        return this.connectionPromise;
    }

    /**
     * Start sending periodic pings to keep connection alive
     */
    private startPingInterval(): void {
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 30000); // Ping every 30 seconds
    }

    /**
     * Schedule reconnection with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            Logger.error(
                `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`
            );
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.maxReconnectDelay
        );

        Logger.info(
            `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
        );

        this.reconnectTimeout = setTimeout(() => {
            this.connect().catch((error) => {
                Logger.error(`Reconnection failed: ${error.message}`);
            });
        }, delay);
    }

    /**
     * Cleanup resources
     */
    private cleanup(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    /**
     * Send message to WebSocket server
     */
    send(data: any): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            Logger.error('Cannot send message: WebSocket not connected');
            return;
        }

        try {
            this.ws.send(JSON.stringify(data));
        } catch (error) {
            Logger.error(`Failed to send WebSocket message: ${error}`);
        }
    }

    /**
     * Subscribe to a channel
     */
    subscribe(channel: string, params: any = {}): void {
        this.send({
            type: 'subscribe',
            channel,
            ...params,
        });
    }

    /**
     * Unsubscribe from a channel
     */
    unsubscribe(channel: string, params: any = {}): void {
        this.send({
            type: 'unsubscribe',
            channel,
            ...params,
        });
    }

    /**
     * Handle incoming message
     */
    private handleMessage(message: any): void {
        // Call all registered message handlers
        this.messageHandlers.forEach((handler) => {
            try {
                handler(message);
            } catch (error) {
                Logger.error(`Message handler error: ${error}`);
            }
        });
    }

    /**
     * Register a message handler
     */
    onMessage(handler: (data: any) => void): () => void {
        this.messageHandlers.add(handler);

        // Return unsubscribe function
        return () => {
            this.messageHandlers.delete(handler);
        };
    }

    /**
     * Close WebSocket connection
     */
    close(): void {
        this.isIntentionallyClosed = true;
        this.cleanup();

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        Logger.info('WebSocket connection closed');
    }

    /**
     * Check if WebSocket is connected
     */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Get connection state
     */
    getState(): string {
        if (!this.ws) return 'DISCONNECTED';

        switch (this.ws.readyState) {
            case WebSocket.CONNECTING:
                return 'CONNECTING';
            case WebSocket.OPEN:
                return 'OPEN';
            case WebSocket.CLOSING:
                return 'CLOSING';
            case WebSocket.CLOSED:
                return 'CLOSED';
            default:
                return 'UNKNOWN';
        }
    }
}

export default PolymarketWebSocketClient;
