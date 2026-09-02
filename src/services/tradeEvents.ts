import { EventEmitter } from 'events';

/**
 * Shared in-process event bus between the trade monitors (HTTP polling or
 * WebSocket) and the trade executor. Both monitor and executor run in the
 * same Node process (started together from src/index.ts), so this avoids
 * the executor having to poll MongoDB on a fixed timer to notice new work —
 * it can react the instant a monitor writes a new trade.
 */
export interface NewTradePayload {
    id: string;
    userAddress: string;
    /** Date.now() at the moment the monitor saved the trade — lets the
     * executor measure detection-to-execution latency. */
    detectedAt: number;
}

class TradeEvents extends EventEmitter {}

const tradeEvents = new TradeEvents();

// A single process runs one trade monitor and one executor, but many
// tracked traders — trades can arrive in bursts (e.g. a WebSocket reconnect
// catch-up fetch). Raise the default limit to avoid a spurious
// MaxListenersExceededWarning; this is not indicative of a leak here.
tradeEvents.setMaxListeners(50);

export const emitNewTrade = (payload: NewTradePayload): void => {
    tradeEvents.emit('newTrade', payload);
};

export const onNewTrade = (listener: (payload: NewTradePayload) => void): void => {
    tradeEvents.on('newTrade', listener);
};

export default tradeEvents;
