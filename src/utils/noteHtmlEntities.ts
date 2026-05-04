/**
 * Small HTML encoding/decoding utilities shared across the note-editing code.
 *
 * Entity helpers (`decodeHtmlEntities`, `encodeTextEntities`) are used both by
 * the simplifier (so inline formatting matches PM's canonical output) and by
 * the edit-note matcher (for the entity_decode / entity_encode fallback
 * strategies). `escapeAttr` / `unescapeAttr` are the minimal attribute
 * encoding/decoding used when rebuilding citation tags. `hexToRgb` is the
 * color helper used by PM normalization. `normalizeWS` is the whitespace
 * collapse used by fuzzy matching and annotation content verification.
 */

// =============================================================================
// Color
// =============================================================================

/**
 * Convert a CSS hex color to rgb()/rgba() notation.
 * Handles 3-digit (#RGB), 4-digit (#RGBA), 6-digit (#RRGGBB), 8-digit (#RRGGBBAA).
 */
export function hexToRgb(hex: string): string {
    const h = hex.replace('#', '');
    let r: number, g: number, b: number, a: number | undefined;

    if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 4) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
        a = parseInt(h[3] + h[3], 16);
    } else if (h.length === 6) {
        r = parseInt(h.substring(0, 2), 16);
        g = parseInt(h.substring(2, 4), 16);
        b = parseInt(h.substring(4, 6), 16);
    } else if (h.length === 8) {
        r = parseInt(h.substring(0, 2), 16);
        g = parseInt(h.substring(2, 4), 16);
        b = parseInt(h.substring(4, 6), 16);
        a = parseInt(h.substring(6, 8), 16);
    } else {
        return hex; // unrecognized format — return as-is
    }

    if (a !== undefined) {
        // Round alpha to 3 decimal places to match browser output
        return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
    }
    return `rgb(${r}, ${g}, ${b})`;
}

// =============================================================================
// Attribute encoding
// =============================================================================

/** Escape a string for use as an HTML attribute value */
export function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Unescape HTML attribute value */
export function unescapeAttr(s: string): string {
    return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// =============================================================================
// Text entity decode / encode
// =============================================================================

/**
 * Decode HTML entities that ProseMirror normalizes in text content.
 * PM decodes quote/apostrophe entities (&#x27; → ', &quot; → ") but
 * preserves structural entities (&lt;, &gt;, &amp;) since decoding
 * those would create actual markup or bare ampersands.
 *
 * Double-quote entities are only decoded in text segments (outside HTML tags)
 * to avoid corrupting attribute values like title="a &quot;b&quot;" or
 * title="a &#34;b&#34;".
 * Numeric entities other than structural chars and " are decoded globally
 * since they do not change tag boundaries.
 */
export function decodeHtmlEntities(s: string): string {
    const decodeNumericEntities = (segment: string, preserveDoubleQuote: boolean): string => segment
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
            const code = parseInt(hex, 16);
            // Preserve structural HTML characters: & (0x26), < (0x3C), > (0x3E)
            if (code === 0x26 || code === 0x3C || code === 0x3E) return match;
            if (preserveDoubleQuote && code === 0x22) return match;
            return String.fromCodePoint(code);
        })
        .replace(/&#(\d+);/g, (match, dec) => {
            const code = parseInt(dec, 10);
            if (code === 38 || code === 60 || code === 62) return match;
            if (preserveDoubleQuote && code === 34) return match;
            return String.fromCodePoint(code);
        });

    // Decode text and tags separately so quote entities inside attributes stay encoded.
    // split(/(<[^>]*>)/) puts text at even indices, tags at odd indices.
    const parts = s.split(/(<[^>]*>)/);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = decodeNumericEntities(parts[i], false)
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"');
    }
    for (let i = 1; i < parts.length; i += 2) {
        parts[i] = decodeNumericEntities(parts[i], true)
            .replace(/&apos;/g, "'");
    }
    // Note: &lt;, &gt;, &amp; intentionally NOT decoded — PM preserves these
    return parts.join('');
}

/** Entity encoding forms for apostrophe/quote characters */
export type EntityForm = 'hex' | 'decimal' | 'named';
/** All entity forms to try during reverse matching */
export const ENTITY_FORMS: readonly EntityForm[] = ['hex', 'decimal', 'named'];

/**
 * Encode apostrophes and quotes back to HTML entities in text segments.
 * This is the reverse of what PM normalizes: ' → entity and " → entity
 * (only in text content, not inside HTML tags).
 * Used when the model's old_string has literal chars but the note still
 * has entity-encoded forms (before PM normalization).
 *
 * Supports multiple entity spellings (hex, decimal, named) because
 * imported/pasted HTML may use any form:
 *   hex:     &#x27; / &quot;   (most common)
 *   decimal: &#39;  / &#34;
 *   named:   &apos; / &quot;   (HTML5; &quot; is the only named form for ")
 */
export function encodeTextEntities(s: string, form: EntityForm = 'hex'): string {
    const apos = form === 'hex' ? '&#x27;' : form === 'decimal' ? '&#39;' : '&apos;';
    const quot = form === 'hex' ? '&quot;' : form === 'decimal' ? '&#34;' : '&quot;';
    const parts = s.split(/(<[^>]*>)/);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i].replace(/'/g, apos).replace(/"/g, quot);
    }
    return parts.join('');
}

// =============================================================================
// Typographic quote folding
// =============================================================================

// Double-quote variants → "
//   U+201C left double, U+201D right double, U+201E German low-9,
//   U+00AB « guillemet, U+00BB » guillemet, U+2033 double prime.
// Single-quote variants → '
//   U+2018 left single, U+2019 right single / apostrophe, U+201A single low-9,
//   U+2032 prime.
const TYPOGRAPHIC_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u00AB\u00BB\u2033]/g;
const TYPOGRAPHIC_SINGLE_QUOTES = /[\u2018\u2019\u201A\u2032]/g;

/**
 * Fold typographic / curly / guillemet quote characters to their ASCII
 * equivalents. Used by the edit_note matcher so the model can write ASCII
 * quotes in `old_string` and still match notes whose prose uses German low
 * quotes (`„…"`), English curly quotes (`"…"`), French guillemets (`«…»`),
 * etc. The transformation is 1:1 per codepoint, so byte positions in the
 * folded form map directly back to positions in the original string.
 */
export function foldTypographicQuotes(s: string): string {
    return s
        .replace(TYPOGRAPHIC_DOUBLE_QUOTES, '"')
        .replace(TYPOGRAPHIC_SINGLE_QUOTES, "'");
}

// =============================================================================
// Whitespace
// =============================================================================

// Treat the literal HTML entity `&nbsp;` as part of the whitespace class so the
// edit_note matcher can fold drift between a model-supplied regular space and
// note HTML PM stored as `&nbsp;` verbatim (and the symmetric reverse case).
// Decoding `&nbsp;` to U+00A0 in `decodeHtmlEntities` is intentionally NOT done
// because PM preserves the entity form in source.
//
// `WS_OR_NBSP_CLASS` is the source string (no flags, no anchors) so callers can
// splice it into larger regex constructions. Use `+` for "one or more", `*` for
// "zero or more", etc.
export const WS_OR_NBSP_CLASS = '(?:\\s|&nbsp;)';
const WS_OR_NBSP_RUN = new RegExp(`${WS_OR_NBSP_CLASS}+`, 'g');

/** Normalize whitespace: collapse runs (incl. literal `&nbsp;`) to a single space and trim */
export function normalizeWS(s: string): string {
    return s.replace(WS_OR_NBSP_RUN, ' ').trim();
}

/** True if `s` contains at least one whitespace char OR a literal `&nbsp;` entity. */
export function hasWhitespaceOrNbsp(s: string): boolean {
    return new RegExp(WS_OR_NBSP_CLASS).test(s);
}
