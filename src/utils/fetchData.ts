import axios, { AxiosError } from 'axios';
import { ENV } from '../config/env';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (error: unknown): boolean => {
    if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const code = axiosError.code;
        const status = axiosError.response?.status;

        // Network timeout/connection errors
        const isNetworkError =
            code === 'ETIMEDOUT' ||
            code === 'ENETUNREACH' ||
            code === 'ECONNRESET' ||
            code === 'ECONNREFUSED' ||
            !axiosError.response;

        // HTTP errors that should be retried
        const isRetryableHttpError =
            status === 408 || // Request Timeout
            status === 429 || // Too Many Requests
            status === 502 || // Bad Gateway
            status === 503 || // Service Unavailable
            status === 504;   // Gateway Timeout

        return isNetworkError || isRetryableHttpError;
    }
    return false;
};

const getErrorDetails = (error: unknown, url: string): string => {
    if (!axios.isAxiosError(error)) {
        return `Unknown error: ${error}`;
    }

    const axiosError = error as AxiosError;
    const parts: string[] = [];

    // Add URL (truncate if too long)
    const truncatedUrl = url.length > 80 ? url.substring(0, 80) + '...' : url;
    parts.push(`URL: ${truncatedUrl}`);

    // Add status code and status text
    if (axiosError.response) {
        parts.push(`Status: ${axiosError.response.status} ${axiosError.response.statusText}`);

        // Add response headers if present
        if (axiosError.response.headers) {
            const contentType = axiosError.response.headers['content-type'];
            if (contentType) {
                parts.push(`Content-Type: ${contentType}`);
            }
        }

        // Add response data (truncate if too large)
        if (axiosError.response.data) {
            const dataStr = typeof axiosError.response.data === 'string'
                ? axiosError.response.data
                : JSON.stringify(axiosError.response.data);
            const truncatedData = dataStr.length > 200
                ? dataStr.substring(0, 200) + '...'
                : dataStr;
            parts.push(`Response: ${truncatedData}`);
        }
    } else if (axiosError.code) {
        // Network error without response
        parts.push(`Error Code: ${axiosError.code}`);
        parts.push(`Message: ${axiosError.message}`);
    }

    return parts.join(' | ');
};

const fetchData = async (url: string) => {
    const retries = ENV.NETWORK_RETRY_LIMIT;
    const timeout = ENV.REQUEST_TIMEOUT_MS;
    const retryDelay = 2000; // 2 second base delay (increased from 1s)

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, {
                timeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                // Force IPv4 to avoid IPv6 connectivity issues
                family: 4,
            });
            return response.data;
        } catch (error) {
            const isLastAttempt = attempt === retries;
            const shouldRetry = isRetryableError(error);

            if (shouldRetry && !isLastAttempt) {
                // Exponential backoff: 2s, 4s, 8s
                const delay = retryDelay * Math.pow(2, attempt - 1);

                // Get error type for logging
                const errorType = axios.isAxiosError(error)
                    ? (error.response?.status ? `HTTP ${error.response.status}` : error.code)
                    : 'Unknown error';

                console.warn(
                    `⚠️  ${errorType} error (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s...`
                );
                console.warn(`   ${getErrorDetails(error, url)}`);
                await sleep(delay);
                continue;
            }

            // If it's the last attempt and retryable, log the failure with full details
            if (isLastAttempt && shouldRetry) {
                const errorType = axios.isAxiosError(error)
                    ? (error.response?.status ? `HTTP ${error.response.status}` : error.code)
                    : 'Unknown error';
                console.error(
                    `❌ ${errorType} - Failed after ${retries} attempts`
                );
                console.error(`   ${getErrorDetails(error, url)}`);
            } else if (!shouldRetry) {
                // Non-retryable error - log details immediately
                console.error(`❌ Non-retryable error occurred:`);
                console.error(`   ${getErrorDetails(error, url)}`);
            }
            throw error;
        }
    }
};

export default fetchData;
