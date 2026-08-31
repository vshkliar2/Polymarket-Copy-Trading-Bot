import { ethers } from 'ethers';
import { ClobClient, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        // Using ethers v5 syntax
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const code = await provider.getCode(address);
        // If code is not "0x", then it's a contract (likely Gnosis Safe)
        return code !== '0x';
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

const createClobClient = async (): Promise<ClobClient> => {
    const chain = 137; // Polygon
    const host = CLOB_HTTP_URL as string;
    const wallet = new ethers.Wallet(PRIVATE_KEY as string);

    // Detect if the proxy wallet is a Gnosis Safe or EOA
    const isProxySafe = await isGnosisSafe(PROXY_WALLET as string);

    Logger.info(
        `Wallet type detected: ${isProxySafe ? 'Gnosis Safe' : 'EOA (Externally Owned Account)'}`
    );
    const signatureType = isProxySafe ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA;

    // V2 client uses options object instead of positional arguments
    let clobClient = new ClobClient({
        host,
        chain,
        signer: wallet,
        signatureType,
        ...(isProxySafe && { funderAddress: PROXY_WALLET as string }),
    });

    // Suppress console output during API key creation
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    // V2 uses createOrDeriveApiKey() instead of separate createApiKey/deriveApiKey
    const creds = await clobClient.createOrDeriveApiKey();

    // Create new client instance with credentials
    clobClient = new ClobClient({
        host,
        chain,
        signer: wallet,
        creds,
        signatureType,
        ...(isProxySafe && { funderAddress: PROXY_WALLET as string }),
    });

    // Restore console functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

export default createClobClient;
