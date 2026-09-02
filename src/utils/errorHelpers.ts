import { OrderResponseErrorCode } from '@polymarket/bindings/clob';

/**
 * @polymarket/client's OrderResponse is a discriminated union with a typed
 * `code: OrderResponseErrorCode` on rejection — an exact enum comparison
 * instead of clob-client-v2's fragile message string-matching.
 */
export const isInsufficientBalanceOrAllowanceCode = (
    code: OrderResponseErrorCode | undefined
): boolean => {
    return code === OrderResponseErrorCode.INSUFFICIENT_BALANCE_OR_ALLOWANCE;
};

/**
 * Format error for logging
 *
 * @param error - Error object or message
 * @returns Formatted error message
 */
export const formatError = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return String(error);
};

/**
 * Get error stack trace if available
 *
 * @param error - Error object
 * @returns Stack trace or undefined
 */
export const getErrorStack = (error: unknown): string | undefined => {
    if (error instanceof Error && error.stack) {
        return error.stack;
    }
    return undefined;
};
