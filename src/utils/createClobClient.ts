import { createSecureClient } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;

// @polymarket/client's privateKey() helper requires a 0x-prefixed,
// 66-character (0x + 64 hex chars) string — it validates via
// @polymarket/types' isPrivateKey() and throws
// `UserInputError: Expected a hex-encoded 32-byte private key.` otherwise.
// This repo's .env stores PRIVATE_KEY WITHOUT the 0x prefix (matching
// @polymarket/clob-client-v2's convention), so it must be prefixed here.
// Guard against a value that might already have the prefix.
const PRIVATE_KEY_WITH_PREFIX = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;

/**
 * Creates an authenticated SecureClient for order placement.
 *
 * createSecureClient resolves the account's wallet type (EOA, Poly Proxy,
 * Poly Safe, or the newer Poly Deposit Wallet) internally from the `wallet`
 * address alone — unlike @polymarket/clob-client-v2, no manual bytecode
 * probing or SignatureTypeV2 selection is needed here.
 */
const createClobClient = async () => {
    return createSecureClient({
        wallet: PROXY_WALLET,
        signer: privateKey(PRIVATE_KEY_WITH_PREFIX),
    });
};

export default createClobClient;
