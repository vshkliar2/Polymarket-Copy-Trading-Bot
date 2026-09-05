// src/services/telegramCommands/__tests__/htmlEscape.test.ts
import { escapeHtml } from '../htmlEscape';

describe('escapeHtml', () => {
    it('escapes &, <, >, and " so the text is safe inside HTML-mode Telegram messages', () => {
        expect(escapeHtml('Fed cuts & CPI < 3% > 2%? "really"')).toBe(
            'Fed cuts &amp; CPI &lt; 3% &gt; 2%? &quot;really&quot;'
        );
    });

    it('leaves plain text without HTML-significant characters unchanged', () => {
        expect(escapeHtml('Trump meets with Putin by December 31?')).toBe(
            'Trump meets with Putin by December 31?'
        );
    });
});
