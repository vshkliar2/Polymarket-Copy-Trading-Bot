import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Module-level singletons: this function runs on every BUY/SELL in the hot
// trade-execution path (tradeExecutor.ts's prepareTradeData), so constructing
// a fresh JsonRpcProvider (and Contract) per call was paying connection setup
// cost on every single trade instead of once at process start.
const rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);

const getMyBalance = async (address: string): Promise<number> => {
    const balance_usdc = await usdcContract.balanceOf(address);
    const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
    return parseFloat(balance_usdc_real);
};

export default getMyBalance;
