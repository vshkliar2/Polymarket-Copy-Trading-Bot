import { ethers } from 'ethers';
import { ENV } from '../config/env';

/**
 * The signing EOA address derived from PRIVATE_KEY.
 *
 * data-api.polymarket.com's /positions and /activity endpoints are keyed by
 * this address, not PROXY_WALLET (Polymarket's deployed proxy contract that
 * actually holds funds and is used for CLOB balance/allowance checks).
 * Querying those endpoints with PROXY_WALLET silently returns empty results
 * whenever the two addresses differ.
 */
const MY_EOA_ADDRESS = new ethers.Wallet(ENV.PRIVATE_KEY).address;

export default MY_EOA_ADDRESS;
