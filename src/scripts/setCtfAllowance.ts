import { ethers } from 'ethers';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL || 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Polymarket CTF Exchange contracts
const CTF_EXCHANGE = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

async function main() {
    console.log('🔧 Setting USDC Allowance for Polymarket CTF Exchanges');
    console.log('═'.repeat(60));
    console.log(`Wallet: ${PROXY_WALLET}`);
    console.log(`USDC Contract: ${USDC_ADDRESS}`);
    console.log('');

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`Signer: ${wallet.address}`);
    console.log('');

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

    // Check current balance
    const balance = await usdc.balanceOf(wallet.address);
    const decimals = await usdc.decimals();
    const balanceFormatted = ethers.utils.formatUnits(balance, decimals);
    console.log(`💰 Current USDC Balance: $${balanceFormatted}`);
    console.log('');

    // Check current allowances
    console.log('📊 Current Allowances:');
    const ctfAllowance = await usdc.allowance(wallet.address, CTF_EXCHANGE);
    const negRiskAllowance = await usdc.allowance(wallet.address, NEG_RISK_CTF_EXCHANGE);

    console.log(
        `   CTF Exchange (${CTF_EXCHANGE}): $${ethers.utils.formatUnits(ctfAllowance, decimals)}`
    );
    console.log(
        `   NegRisk CTF (${NEG_RISK_CTF_EXCHANGE}): $${ethers.utils.formatUnits(negRiskAllowance, decimals)}`
    );
    console.log('');

    // Set unlimited allowance for both
    const MAX_UINT256 = ethers.constants.MaxUint256;

    console.log('🔓 Setting unlimited allowances...');
    console.log('');

    // Get current gas price from network
    const feeData = await provider.getFeeData();
    let gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

    if (!gasPrice) {
        gasPrice = ethers.utils.parseUnits('50', 'gwei');
    } else {
        // Add 20% buffer to ensure transaction goes through
        gasPrice = gasPrice.mul(120).div(100);
    }

    console.log(`⛽ Gas Price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} Gwei`);
    console.log('');

    // CTF Exchange
    if (ctfAllowance.lt(ethers.utils.parseUnits('1000', decimals))) {
        console.log('1️⃣  Approving CTF Exchange...');
        const tx1 = await usdc.approve(CTF_EXCHANGE, MAX_UINT256, {
            gasPrice: gasPrice,
            gasLimit: 100000,
        });
        console.log(`   Transaction: ${tx1.hash}`);
        console.log('   Waiting for confirmation...');
        await tx1.wait();
        console.log('   ✅ CTF Exchange approved!');
        console.log('');
    } else {
        console.log('1️⃣  CTF Exchange already has sufficient allowance');
        console.log('');
    }

    // NegRisk CTF Exchange
    if (negRiskAllowance.lt(ethers.utils.parseUnits('1000', decimals))) {
        console.log('2️⃣  Approving NegRisk CTF Exchange...');
        const tx2 = await usdc.approve(NEG_RISK_CTF_EXCHANGE, MAX_UINT256, {
            gasPrice: gasPrice,
            gasLimit: 100000,
        });
        console.log(`   Transaction: ${tx2.hash}`);
        console.log('   Waiting for confirmation...');
        await tx2.wait();
        console.log('   ✅ NegRisk CTF Exchange approved!');
        console.log('');
    } else {
        console.log('2️⃣  NegRisk CTF Exchange already has sufficient allowance');
        console.log('');
    }

    // Verify new allowances
    console.log('✅ Final Allowances:');
    const newCtfAllowance = await usdc.allowance(wallet.address, CTF_EXCHANGE);
    const newNegRiskAllowance = await usdc.allowance(wallet.address, NEG_RISK_CTF_EXCHANGE);

    console.log(
        `   CTF Exchange: ${newCtfAllowance.eq(MAX_UINT256) ? 'UNLIMITED ♾️' : '$' + ethers.utils.formatUnits(newCtfAllowance, decimals)}`
    );
    console.log(
        `   NegRisk CTF: ${newNegRiskAllowance.eq(MAX_UINT256) ? 'UNLIMITED ♾️' : '$' + ethers.utils.formatUnits(newNegRiskAllowance, decimals)}`
    );
    console.log('');
    console.log('═'.repeat(60));
    console.log('🎉 Allowances set successfully!');
    console.log('You can now trade on Polymarket.');
    console.log('═'.repeat(60));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
