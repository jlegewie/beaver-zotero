/**
 * CSS colors of Zotero notes as opaque `#rrggbb`.
 *
 * Word and LaTeX have no transparency, and the note editor's highlight colors
 * are half transparent (`#ffd40080`), so a translucent color is blended onto
 * the white page it is shown on.
 */

const NAMED: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
    magenta: '#ff00ff', cyan: '#00ffff', pink: '#ffc0cb', brown: '#a52a2a', navy: '#000080',
    teal: '#008080', maroon: '#800000', olive: '#808000', lime: '#00ff00', silver: '#c0c0c0',
};

function hex(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/** `rgb` blended onto white at `alpha` (0–1), as `#rrggbb`. */
function opaque(red: number, green: number, blue: number, alpha: number): string {
    const blend = (channel: number) => channel * alpha + 255 * (1 - alpha);
    return `#${hex(blend(red))}${hex(blend(green))}${hex(blend(blue))}`;
}

/**
 * A CSS color as opaque `#rrggbb`, or null when it is not a color this
 * understands (or fully transparent). Accepts `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`, `rgba()` and common color names.
 */
export function opaqueColor(value: string | null | undefined): string | null {
    const color = value?.trim().toLowerCase();
    if (!color || color === 'transparent' || color === 'inherit' || color === 'initial') return null;
    if (NAMED[color]) return NAMED[color];
    let match = /^#([0-9a-f]{3,4})$/.exec(color);
    if (match) {
        const [r, g, b, a] = [...match[1]].map(digit => parseInt(digit + digit, 16));
        const alpha = a === undefined ? 1 : a / 255;
        return alpha > 0 ? opaque(r, g, b, alpha) : null;
    }
    match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(color);
    if (match) {
        const [r, g, b] = [0, 2, 4].map(offset => parseInt(match![1].slice(offset, offset + 2), 16));
        const alpha = match[2] ? parseInt(match[2], 16) / 255 : 1;
        return alpha > 0 ? opaque(r, g, b, alpha) : null;
    }
    match = /^rgba?\(\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(color);
    if (match) {
        const percent = color.includes('%') && !match[5];
        const channel = (raw: string) => (percent ? Number(raw) * 2.55 : Number(raw));
        let alpha = match[4] === undefined ? 1 : Number(match[4]);
        if (match[5]) alpha /= 100;
        if (!Number.isFinite(alpha) || alpha <= 0) return null;
        return opaque(channel(match[1]), channel(match[2]), channel(match[3]), Math.min(alpha, 1));
    }
    return null;
}

/** A `#rrggbb` color as the six uppercase hex digits Word and xcolor take. */
export function hexDigits(color: string): string {
    return color.replace(/^#/, '').toUpperCase();
}
