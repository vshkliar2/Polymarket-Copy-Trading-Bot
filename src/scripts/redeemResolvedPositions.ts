import { ethers } from 'ethers';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import MY_EOA_ADDRESS from '../utils/getMyEOA';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL || 'https://polygon-rpc.com';

// Contract addresses on Polygon
const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
// Must match Polymarket's actual collateral token (USDC.e), not native USDC —
// the CTF contract validates this against the condition's real collateral
// and reverts redeemPositions() on a mismatch.
const USDC_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

// Thresholds for considering a position "resolved"
const RESOLVED_HIGH = 0.99; // Position won (price ~$1)
const RESOLVED_LOW = 0.01; // Position lost (price ~$0)
const ZERO_THRESHOLD = 0.0001;

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

// CTF Contract ABI (only the functions we need)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
];

const loadPositions = async (address: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const data = await fetchData(url);
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

const redeemPosition = async (
    ctfContract: ethers.Contract,
    position: Position
): Promise<{ success: boolean; error?: string }> => {
    try {
        // Convert conditionId to bytes32 format
        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(position.conditionId).toHexString(),
            32
        );

        // parentCollectionId is always zero for Polymarket
        const parentCollectionId = ethers.constants.HashZero;

        // indexSets: [1, 2] represents both outcome collections
        // We use [1, 2] to redeem all positions for this condition
        const indexSets = [1, 2];

        console.log(`   Attempting redemption...`);
        console.log(`   Condition ID: ${conditionIdBytes32}`);
        console.log(`   Index Sets: [${indexSets.join(', ')}]`);

        // Get current gas price from network
        const feeData = await ctfContract.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

        if (!gasPrice) {
            throw new Error('Could not determine gas price');
        }

        // Add 20% buffer to ensure transaction goes through
        const adjustedGasPrice = gasPrice.mul(120).div(100);

        console.log(`   Gas price: ${ethers.utils.formatUnits(adjustedGasPrice, 'gwei')} Gwei`);

        const tx = await ctfContract.redeemPositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            {
                gasLimit: 500000, // Set a reasonable gas limit
                gasPrice: adjustedGasPrice,
            }
        );

        console.log(`   ⏳ Transaction submitted: ${tx.hash}`);
        console.log(`   ⏳ Waiting for confirmation...`);

        const receipt = await tx.wait();

        if (receipt.status === 1) {
            console.log(`   ✅ Redemption successful! Gas used: ${receipt.gasUsed.toString()}`);
            return { success: true };
        } else {
            console.log(`   ❌ Transaction failed`);
            return { success: false, error: 'Transaction reverted' };
        }
    } catch (error: any) {
        const errorMessage = error.message || String(error);
        console.log(`   ❌ Redemption failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
};

const logPositionHeader = (position: Position, index: number, total: number) => {
    const status = position.curPrice >= RESOLVED_HIGH ? '🎉 WIN' : '❌ LOSS';
    console.log(
        `\n${index + 1}/${total} ▶ ${status} | ${position.title || position.slug || position.asset}`
    );
    if (position.outcome) {
        console.log(`   Outcome: ${position.outcome}`);
    }
    console.log(`   Size: ${position.size.toFixed(2)} tokens`);
    console.log(`   Current price: $${position.curPrice.toFixed(4)}`);
    console.log(`   Expected value: $${position.currentValue.toFixed(2)}`);
    console.log(`   Redeemable: ${position.redeemable ? 'YES' : 'NO'}`);
};

const main = async () => {
    console.log('🚀 Redeeming resolved positions');
    console.log('════════════════════════════════════════════════════');
    console.log(`Wallet: ${PROXY_WALLET}`);
    console.log(`CTF Contract: ${CTF_CONTRACT_ADDRESS}`);
    console.log(`Win threshold: price >= $${RESOLVED_HIGH}`);
    console.log(`Loss threshold: price <= $${RESOLVED_LOW}`);

    // Setup provider and signer
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`\n✅ Connected to Polygon RPC`);
    console.log(`Signer address: ${wallet.address}`);

    // Check if signer is proxy wallet or owner
    if (wallet.address.toLowerCase() !== PROXY_WALLET.toLowerCase()) {
        console.log(
            `⚠️  Note: Signer (${wallet.address}) differs from proxy wallet (${PROXY_WALLET})`
        );
        console.log(`   Make sure signer has permission to execute transactions on proxy wallet`);
    }

    // Create contract instance
    const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

    // Load positions
    const allPositions = await loadPositions(MY_EOA_ADDRESS);

    if (allPositions.length === 0) {
        console.log('\n🎉 No open positions detected.');
        return;
    }

    // Filter for resolved and redeemable positions
    const redeemablePositions = allPositions.filter(
        (pos) =>
            (pos.curPrice >= RESOLVED_HIGH || pos.curPrice <= RESOLVED_LOW) &&
            pos.redeemable === true
    );

    const activePositions = allPositions.filter(
        (pos) => pos.curPrice > RESOLVED_LOW && pos.curPrice < RESOLVED_HIGH
    );

    console.log(`\n📊 Position statistics:`);
    console.log(`   Total positions: ${allPositions.length}`);
    console.log(`   ✅ Resolved and redeemable: ${redeemablePositions.length}`);
    console.log(`   ⏳ Active (not touching): ${activePositions.length}`);

    if (redeemablePositions.length === 0) {
        console.log('\n✅ No positions to redeem.');
        return;
    }

    console.log(`\n🔄 Redeeming ${redeemablePositions.length} positions...`);
    console.log(`⚠️  WARNING: Each redemption requires gas fees on Polygon`);

    let successCount = 0;
    let failCount = 0;
    let totalValue = 0;

    // Group positions by conditionId to avoid duplicate redemptions
    const positionsByCondition = new Map<string, Position[]>();
    redeemablePositions.forEach((pos) => {
        const existing = positionsByCondition.get(pos.conditionId) || [];
        existing.push(pos);
        positionsByCondition.set(pos.conditionId, existing);
    });

    console.log(`\n📦 Grouped into ${positionsByCondition.size} unique conditions`);

    let conditionIndex = 0;
    for (const [conditionId, positions] of positionsByCondition.entries()) {
        conditionIndex++;
        const totalPositionValue = positions.reduce((sum, pos) => sum + pos.currentValue, 0);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Condition ${conditionIndex}/${positionsByCondition.size}`);
        console.log(`Condition ID: ${conditionId}`);
        console.log(`Positions in this condition: ${positions.length}`);
        console.log(`Total expected value: $${totalPositionValue.toFixed(2)}`);

        // Show all positions for this condition
        positions.forEach((pos, idx) => {
            const status = pos.curPrice >= RESOLVED_HIGH ? '🎉' : '❌';
            console.log(
                `   ${status} ${pos.title || pos.slug} | ${pos.outcome} | ${pos.size.toFixed(2)} tokens | $${pos.currentValue.toFixed(2)}`
            );
        });

        // Redeem once for this condition (redeems all positions)
        const firstPosition = positions[0];
        if (!firstPosition) {
            console.log('   ⚠️ No position found, skipping...');
            continue;
        }
        const result = await redeemPosition(ctfContract, firstPosition);

        if (result.success) {
            successCount++;
            totalValue += totalPositionValue;
        } else {
            failCount++;
        }

        // Small delay between transactions
        if (conditionIndex < positionsByCondition.size) {
            console.log(`   ⏳ Waiting 2s before next transaction...`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    console.log('\n════════════════════════════════════════════════════');
    console.log('✅ Summary of position redemption');
    console.log(`Conditions processed: ${positionsByCondition.size}`);
    console.log(`Successful redemptions: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Expected value of redeemed positions: $${totalValue.toFixed(2)}`);
    console.log('════════════════════════════════════════════════════\n');
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Script aborted due to error:', error);
        process.exit(1);
    });
