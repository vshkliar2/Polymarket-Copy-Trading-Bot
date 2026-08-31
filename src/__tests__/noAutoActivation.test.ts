import * as fs from 'fs';
import * as path from 'path';

/**
 * Safety invariant: ONLY addManualTrader (reached via the Telegram /add command
 * or an Approve button tap) may ever set a trader to status 'active'. The
 * discovery workers propose candidates as 'pending' and must never activate
 * one on their own — an auto-activated address would start having its trades
 * copied with real money, with no operator in the loop.
 *
 * This is a source-text assertion because the invariant itself is textual:
 * this specific string must never appear in these specific files.
 */
describe('discovery workers never auto-activate a trader', () => {
    const workerFiles = ['discoveryWorker.ts', 'newWalletWorker.ts'];

    for (const file of workerFiles) {
        it(`${file} never writes status: 'active'`, () => {
            const filePath = path.join(__dirname, '..', file);
            expect(fs.existsSync(filePath)).toBe(true);

            const source = fs.readFileSync(filePath, 'utf-8');
            expect(source).not.toMatch(/status:\s*['"]active['"]/);
        });

        it(`${file} does not import addManualTrader`, () => {
            const filePath = path.join(__dirname, '..', file);
            const source = fs.readFileSync(filePath, 'utf-8');
            expect(source).not.toMatch(/addManualTrader/);
        });
    }
});
