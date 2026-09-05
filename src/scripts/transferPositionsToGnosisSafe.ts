import { ethers } from 'ethers';
import { ENV } from '../config/env';
import publicClient from '../utils/publicClient';

const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL;

const EOA_ADDRESS = '0x4fbBe5599c06e846D2742014c9eB04A8a3d1DE8C';
const GNOSIS_SAFE_ADDRESS = '0xd62531bc536bff72394fc5ef715525575787e809';

// Polymarket Conditional Tokens contract на Polygon (ERC1155)
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    curPrice: number;
    title?: string;
    slug?: string;
    outcome?: string;
}

async function transferPositions() {
    console.log('\n🔄 ПЕРЕНОС ПОЗИЦИЙ С EOA НА GNOSIS SAFE\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📍 Адреса:\n');
    console.log(`   FROM (EOA):          ${EOA_ADDRESS}`);
    console.log(`   TO (Gnosis Safe):    ${GNOSIS_SAFE_ADDRESS}\n`);

    // 1. Получаем все позиции на EOA
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📋 ШАГ 1: Получение позиций на EOA\n');

    const positions = (await publicClient.getPositions(EOA_ADDRESS)) as unknown as Position[];

    if (!positions || positions.length === 0) {
        console.log('❌ Нет позиций на EOA для переноса\n');
        return;
    }

    console.log(`✅ Найдено позиций: ${positions.length}`);
    console.log(
        `💰 Общая стоимость: $${positions.reduce((s, p) => s + p.currentValue, 0).toFixed(2)}\n`
    );

    // 2. Подключаемся к сети
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📋 ШАГ 2: Подключение к Polygon\n');

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`✅ Подключено к Polygon\n`);
    console.log(`   Wallet: ${wallet.address}\n`);

    // Проверяем что это правильный кошелек
    if (wallet.address.toLowerCase() !== EOA_ADDRESS.toLowerCase()) {
        console.log('❌ ОШИБКА: Приватный ключ не соответствует EOA адресу!\n');
        console.log(`   Ожидается: ${EOA_ADDRESS}`);
        console.log(`   Получен:   ${wallet.address}\n`);
        return;
    }

    // 3. ERC1155 ABI для safeTransferFrom
    const erc1155Abi = [
        'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
        'function balanceOf(address account, uint256 id) view returns (uint256)',
        'function isApprovedForAll(address account, address operator) view returns (bool)',
        'function setApprovalForAll(address operator, bool approved)',
    ];

    // 4. Переносим каждую позицию
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📋 ШАГ 3: Перенос позиций\n');

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];

        console.log(`\n📦 Позиция ${i + 1}/${positions.length}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`Market: ${pos.title || 'Unknown'}`);
        console.log(`Outcome: ${pos.outcome || 'Unknown'}`);
        console.log(`Size: ${pos.size.toFixed(2)} shares`);
        console.log(`Value: $${pos.currentValue.toFixed(2)}`);
        console.log(`Token ID: ${pos.asset.slice(0, 20)}...`);

        try {
            // Conditional Tokens контракт (хранит ERC1155 токены)
            const ctfContract = new ethers.Contract(CONDITIONAL_TOKENS, erc1155Abi, wallet);

            // Проверяем баланс на EOA
            const balance = await ctfContract.balanceOf(EOA_ADDRESS, pos.asset);
            console.log(`\n📊 Баланс на EOA: ${ethers.utils.formatUnits(balance, 0)} tokens`);

            if (balance.isZero()) {
                console.log('⚠️  Пропуск: Баланс равен нулю\n');
                failureCount++;
                continue;
            }

            // Получаем gas price
            const gasPrice = await provider.getGasPrice();
            const gasPriceWithBuffer = gasPrice.mul(150).div(100); // +50% buffer

            console.log(
                `⛽ Gas price: ${ethers.utils.formatUnits(gasPriceWithBuffer, 'gwei')} Gwei\n`
            );

            // Проверяем approval
            const isApproved = await ctfContract.isApprovedForAll(EOA_ADDRESS, GNOSIS_SAFE_ADDRESS);
            if (!isApproved) {
                console.log('🔓 Установка approval для Gnosis Safe...');
                const approveTx = await ctfContract.setApprovalForAll(GNOSIS_SAFE_ADDRESS, true, {
                    gasPrice: gasPriceWithBuffer,
                    gasLimit: 100000,
                });
                await approveTx.wait();
                console.log('✅ Approval установлен\n');
            }

            // Переносим токены
            console.log(`🔄 Перенос ${ethers.utils.formatUnits(balance, 0)} токенов...`);

            const transferTx = await ctfContract.safeTransferFrom(
                EOA_ADDRESS,
                GNOSIS_SAFE_ADDRESS,
                pos.asset,
                balance,
                '0x', // empty data
                {
                    gasPrice: gasPriceWithBuffer,
                    gasLimit: 200000,
                }
            );

            console.log(`⏳ TX отправлена: ${transferTx.hash}`);
            console.log('⏳ Ожидание подтверждения...');

            const receipt = await transferTx.wait();

            console.log(`✅ УСПЕШНО! Block: ${receipt.blockNumber}`);
            console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

            successCount++;

            // Пауза между переносами
            if (i < positions.length - 1) {
                console.log('\n⏳ Пауза 3 секунды...\n');
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        } catch (error: any) {
            console.log(`\n❌ ОШИБКА при переносе:`);
            console.log(`   ${error.message}\n`);
            failureCount++;
        }
    }

    // 5. Итоги
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 ИТОГИ ПЕРЕНОСА');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`✅ Успешно перенесено: ${successCount}/${positions.length}`);
    console.log(`❌ Ошибок: ${failureCount}/${positions.length}\n`);

    // 6. Проверяем результат
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📋 ШАГ 4: Проверка результата\n');

    console.log('⏳ Ждем 5 секунд для обновления данных API...\n');
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const eoaPositionsAfter = (await publicClient.getPositions(
        EOA_ADDRESS
    )) as unknown as Position[];

    const gnosisPositionsAfter = (await publicClient.getPositions(
        GNOSIS_SAFE_ADDRESS
    )) as unknown as Position[];

    console.log('📊 ПОСЛЕ ПЕРЕНОСА:\n');
    console.log(`   EOA:          ${eoaPositionsAfter?.length || 0} позиций`);
    console.log(`   Gnosis Safe:  ${gnosisPositionsAfter?.length || 0} позиций\n`);

    if (gnosisPositionsAfter && gnosisPositionsAfter.length > 0) {
        console.log('✅ Позиции успешно перенесены на Gnosis Safe!\n');
        console.log('🔗 Проверьте на Polymarket:\n');
        console.log(`   https://polymarket.com/profile/${GNOSIS_SAFE_ADDRESS}\n`);
    } else {
        console.log('⚠️  API еще не обновилось. Подождите несколько минут и проверьте вручную.\n');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('✅ Скрипт завершен!\n');
}

transferPositions().catch((error) => {
    console.error('\n❌ Критическая ошибка:', error);
    process.exit(1);
});
