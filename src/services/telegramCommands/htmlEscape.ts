// src/services/telegramCommands/htmlEscape.ts

/**
 * Escapes text for safe interpolation into a Telegram HTML-mode message.
 * Polymarket market titles/questions/outcomes routinely contain &, <, >
 * (e.g. "Bitcoin > $150k by...?") — under parse_mode: 'HTML', Telegram
 * rejects the WHOLE message with a 400 if any interpolated text isn't
 * valid HTML, not just that one field. Escape every API-sourced string
 * before interpolating it into message text.
 */
export const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
