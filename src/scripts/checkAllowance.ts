import { ethers } from 'ethers';
import { AssetType } from '@polymarket/bindings/clob';
import { fetchBalanceAllowance, updateBalanceAllowance } from '@polymarket/client/actions';
import { ENV } from '../config/env';
import secureClient from '../utils/secureClient';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const POLYMARKET_EXCHANGE_LOWER = POLYMARKET_EXCHANGE.toLowerCase();
// Polygon mainnet USDC.e (Polymarket's collateral token). This was
// previously read via @polymarket/clob-client-v2's getContractConfig(137)
// .collateral, which has no equivalent in @polymarket/client or
// @polymarket/bindings — it is a static lookup table, not an API call.
// Hardcoded here the same way POLYMARKET_EXCHANGE and NATIVE_USDC_ADDRESS
// already are in this file.
const POLYMARKET_COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const POLYMARKET_COLLATERAL_LOWER = POLYMARKET_COLLATERAL.toLowerCase();
const NATIVE_USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const NATIVE_USDC_LOWER = NATIVE_USDC_ADDRESS.toLowerCase();

// USDC ABI (only the functions we need)
const USDC_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
];

const formatClobAmount = (raw: string, decimals: number): string => {
    try {
        return ethers.utils.formatUnits(raw, decimals);
    } catch {
        const numeric = parseFloat(raw);
        if (!Number.isFinite(numeric)) {
            return raw;
        }
        return numeric.toFixed(Math.min(decimals, 6));
    }
};

const syncPolymarketAllowanceCache = async (decimals: number) => {
    try {
        console.log('🔄 Syncing Polymarket allowance cache...');

        let clobClient;
        try {
            clobClient = await secureClient();
        } catch (error) {
            console.log(
                `⚠️  Unable to create authenticated client: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }

        const requestParams = {
            assetType: AssetType.COLLATERAL,
        } as const;

        // updateBalanceAllowance is a write/cache-refresh call: it asks
        // Polymarket to re-read the on-chain allowance/balance and update
        // its own cached record, returning that same cached snapshot.
        const updateResult = await updateBalanceAllowance(clobClient, requestParams);
        console.log(
            'ℹ  Polymarket cache update response:',
            JSON.stringify(updateResult, (_key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            )
        );

        // fetchBalanceAllowance is the standalone read-only action-function —
        // it is NOT bound on the client instance in @polymarket/client, so it
        // must be imported and called separately (confirmed via a live probe
        // during Task 1: `Object.keys(client)` has zero matches for it).
        const balanceResponse = await fetchBalanceAllowance(clobClient, requestParams);

        const { balance, allowances } = balanceResponse;

        // allowances is a Record<EvmAddress, bigint> — native bigint, not a
        // string or number. Prefer the legacy v1 exchange address if
        // present, but the allowances map is keyed by whichever operator
        // contracts are relevant to this account (exchangeV2, negRiskAdapter,
        // negRiskExchangeV2, and others that may be added later) — none of
        // which is guaranteed to be POLYMARKET_EXCHANGE. Once
        // updateBalanceAllowance sets an unlimited approval, every operator
        // contract carries the same value, so falling back to "any present
        // allowance" is accurate, not just a guess.
        let allowanceValue: bigint | undefined;
        for (const [address, value] of Object.entries(allowances)) {
            if (address.toLowerCase() === POLYMARKET_EXCHANGE_LOWER) {
                allowanceValue = value;
                break;
            }
        }
        if (allowanceValue === undefined) {
            allowanceValue = Object.values(allowances)[0];
        }

        if (balance === undefined || allowanceValue === undefined) {
            console.log(
                '⚠️  Polymarket did not provide balance/allowance data. Raw response:',
                JSON.stringify(balanceResponse, (_key, value) =>
                    typeof value === 'bigint' ? value.toString() : value
                )
            );
            return;
        }

        const syncedBalance = formatClobAmount(balance, decimals);
        const syncedAllowance = formatClobAmount(allowanceValue.toString(), decimals);
        console.log(`💾 Polymarket Recorded Balance: ${syncedBalance} USDC`);
        console.log(`💾 Polymarket Recorded Allowance: ${syncedAllowance} USDC\n`);
    } catch (syncError: any) {
        console.log(`⚠️  Unable to sync Polymarket cache: ${syncError?.message || syncError}`);
    }
};

async function checkAndSetAllowance() {
    console.log('🔍 Checking USDC balance and allowance...\n');

    // Connect to Polygon
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    // Create USDC contract instance
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, wallet);

    try {
        // Get USDC decimals
        const decimals = await usdcContract.decimals();
        console.log(`💵 USDC Decimals: ${decimals}`);

        const usesPolymarketCollateral =
            USDC_CONTRACT_ADDRESS.toLowerCase() === POLYMARKET_COLLATERAL_LOWER;

        // Local token balance & allowance (whatever is configured in .env)
        const localBalance = await usdcContract.balanceOf(PROXY_WALLET);
        const localAllowance = await usdcContract.allowance(PROXY_WALLET, POLYMARKET_EXCHANGE);
        const localBalanceFormatted = ethers.utils.formatUnits(localBalance, decimals);
        const localAllowanceFormatted = ethers.utils.formatUnits(localAllowance, decimals);

        console.log(
            `💰 Your USDC Balance (${USDC_CONTRACT_ADDRESS}): ${localBalanceFormatted} USDC`
        );
        console.log(
            `✅ Current Allowance (${USDC_CONTRACT_ADDRESS}): ${localAllowanceFormatted} USDC`
        );
        console.log(`📍 Polymarket Exchange: ${POLYMARKET_EXCHANGE}\n`);

        if (USDC_CONTRACT_ADDRESS.toLowerCase() !== NATIVE_USDC_LOWER) {
            try {
                const nativeContract = new ethers.Contract(NATIVE_USDC_ADDRESS, USDC_ABI, wallet);
                const nativeDecimals = await nativeContract.decimals();
                const nativeBalance = await nativeContract.balanceOf(PROXY_WALLET);
                if (!nativeBalance.isZero()) {
                    const nativeFormatted = ethers.utils.formatUnits(nativeBalance, nativeDecimals);
                    console.log('ℹ️  Detected native USDC (Polygon PoS) balance:');
                    console.log(`    ${nativeFormatted} tokens at ${NATIVE_USDC_ADDRESS}`);
                    console.log(
                        '    Polymarket does not recognize this token. Swap to USDC.e (0x2791...) to trade.\n'
                    );
                }
            } catch (nativeError) {
                console.log(`⚠️  Unable to check native USDC balance: ${nativeError}`);
            }
        }

        // Determine the contract Polymarket actually reads from (USDC.e)
        const polymarketContract = usesPolymarketCollateral
            ? usdcContract
            : new ethers.Contract(POLYMARKET_COLLATERAL, USDC_ABI, wallet);
        const polymarketDecimals = usesPolymarketCollateral
            ? decimals
            : await polymarketContract.decimals();
        const polymarketBalance = usesPolymarketCollateral
            ? localBalance
            : await polymarketContract.balanceOf(PROXY_WALLET);
        const polymarketAllowance = usesPolymarketCollateral
            ? localAllowance
            : await polymarketContract.allowance(PROXY_WALLET, POLYMARKET_EXCHANGE);

        if (!usesPolymarketCollateral) {
            const polymarketBalanceFormatted = ethers.utils.formatUnits(
                polymarketBalance,
                polymarketDecimals
            );
            const polymarketAllowanceFormatted = ethers.utils.formatUnits(
                polymarketAllowance,
                polymarketDecimals
            );
            console.log('⚠️  Polymarket collateral token is USDC.e (bridged) at address');
            console.log(`    ${POLYMARKET_COLLATERAL}`);
            console.log(`⚠️  Polymarket-tracked USDC balance: ${polymarketBalanceFormatted} USDC`);
            console.log(`⚠️  Polymarket-tracked allowance: ${polymarketAllowanceFormatted} USDC\n`);
            console.log(
                '👉  Swap native USDC to USDC.e or update your .env to point at the collateral token before trading.\n'
            );
        }

        if (polymarketAllowance.lt(polymarketBalance) || polymarketAllowance.isZero()) {
            console.log('⚠️  Allowance is insufficient or zero!');
            console.log('📝 Setting unlimited allowance for Polymarket...\n');

            // Approve unlimited amount (max uint256)
            const maxAllowance = ethers.constants.MaxUint256;

            // Get current gas price and add 50% buffer
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice
                ? feeData.gasPrice.mul(150).div(100)
                : ethers.utils.parseUnits('50', 'gwei');

            console.log(`⛽ Gas Price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} Gwei`);

            const approveTx = await polymarketContract.approve(POLYMARKET_EXCHANGE, maxAllowance, {
                gasPrice: gasPrice,
                gasLimit: 100000,
            });

            console.log(`⏳ Transaction sent: ${approveTx.hash}`);
            console.log('⏳ Waiting for confirmation...\n');

            const receipt = await approveTx.wait();

            if (receipt.status === 1) {
                console.log('✅ Allowance set successfully!');
                console.log(`🔗 Transaction: https://polygonscan.com/tx/${approveTx.hash}\n`);

                // Verify new allowance
                const newAllowance = await polymarketContract.allowance(
                    PROXY_WALLET,
                    POLYMARKET_EXCHANGE
                );
                const newAllowanceFormatted = ethers.utils.formatUnits(
                    newAllowance,
                    polymarketDecimals
                );
                console.log(`✅ New Allowance: ${newAllowanceFormatted} USDC`);
            } else {
                console.log('❌ Transaction failed!');
            }
        } else {
            console.log('✅ Allowance is already sufficient! No action needed.');
        }

        await syncPolymarketAllowanceCache(polymarketDecimals);
    } catch (error: any) {
        console.error('❌ Error:', error.message);
        if (error.code === 'INSUFFICIENT_FUNDS') {
            console.log('\n⚠️  You need MATIC for gas fees on Polygon!');
        }
    }
}

checkAndSetAllowance()
    .then(() => {
        console.log('\n✅ Done!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
