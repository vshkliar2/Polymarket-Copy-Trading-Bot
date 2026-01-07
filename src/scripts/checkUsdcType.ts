import { ethers } from 'ethers';
import { ENV } from '../config/env';

const WALLET = ENV.PROXY_WALLET;
const RPC_URL = ENV.RPC_URL || 'https://polygon-rpc.com';

// USDC.e (bridged from Ethereum) - what Polymarket uses
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Native USDC (different token, NOT supported by Polymarket)
const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

async function main() {
    console.log('');
    console.log('═'.repeat(60));
    console.log('🔍 USDC Token Type Check');
    console.log('═'.repeat(60));
    console.log(`Wallet: ${WALLET}`);
    console.log('');

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

    const usdcE = new ethers.Contract(USDC_E, ERC20_ABI, provider);
    const nativeUsdc = new ethers.Contract(NATIVE_USDC, ERC20_ABI, provider);

    const balanceE = await usdcE.balanceOf(WALLET);
    const balanceNative = await nativeUsdc.balanceOf(WALLET);

    const decimalsE = await usdcE.decimals();
    const decimalsNative = await nativeUsdc.decimals();

    console.log('💎 USDC.e (bridged - REQUIRED for Polymarket):');
    console.log(`   Address: ${USDC_E}`);
    console.log(`   Balance: $${ethers.utils.formatUnits(balanceE, decimalsE)}`);
    console.log('');
    console.log('🆕 Native USDC (NOT supported by Polymarket):');
    console.log(`   Address: ${NATIVE_USDC}`);
    console.log(`   Balance: $${ethers.utils.formatUnits(balanceNative, decimalsNative)}`);
    console.log('');
    console.log('═'.repeat(60));

    if (balanceE.gt(0)) {
        console.log('✅ You have USDC.e - this is CORRECT for Polymarket');
        console.log('');
        console.log('Your balance should work for trading!');
    } else if (balanceNative.gt(0)) {
        console.log('❌ PROBLEM FOUND: You have Native USDC, not USDC.e!');
        console.log('');
        console.log('Polymarket ONLY accepts USDC.e (bridged USDC from Ethereum)');
        console.log('');
        console.log('📋 How to fix:');
        console.log('');
        console.log('Option 1: Swap on DEX');
        console.log('   1. Go to QuickSwap: https://quickswap.exchange/');
        console.log('   2. Swap Native USDC → USDC.e');
        console.log('   3. Cost: Small swap fee (~0.3%)');
        console.log('');
        console.log('Option 2: Bridge from Ethereum');
        console.log('   1. Go to Polygon Bridge: https://wallet.polygon.technology/');
        console.log('   2. Bridge USDC from Ethereum to Polygon');
        console.log('   3. Bridged USDC automatically becomes USDC.e');
        console.log('   4. Cost: Ethereum gas fees');
    } else {
        console.log('❌ No USDC found in wallet');
        console.log('');
        console.log('You need to deposit USDC.e to trade on Polymarket');
    }

    console.log('═'.repeat(60));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
