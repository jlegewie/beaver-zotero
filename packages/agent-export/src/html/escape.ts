/**
 * HTML escaping and the citation processor's HTML, made safe to embed.
 *
 * Citation processor output is HTML built from item metadata, including
 * metadata the backend supplied for external references. Rather than trusting
 * it, `sanitizeCslHtml` re-serializes the small subset a CSL processor emits
 * (see `citations/inlineHtml.ts`) and drops everything else, keeping the text.
 */

import { decodeHtmlEntities } from '../citations/inlineHtml';

/** Escape text for HTML content and double-quoted attribute values. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Whether a URL may be a link target in an exported document. */
export function isWebLink(url: string): boolean {
    return /^(https?:|mailto:)/i.test(url.trim());
}

/** CSS a CSL processor sets on `<span>`, by property, with the values kept. */
const SPAN_STYLES: Record<string, RegExp> = {
    'font-style': /^(normal|italic|oblique)$/,
    'font-weight': /^(normal|bold|[1-9]00)$/,
    'font-variant': /^(normal|small-caps)$/,
    'text-decoration': /^(none|underline)$/,
    'vertical-align': /^(baseline|sub|super)$/,
};

function spanStyle(attributes: string): string {
    const css = /style\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '';
    const kept: string[] = [];
    for (const declaration of decodeHtmlEntities(css).split(';')) {
        const [property, value] = declaration.split(':').map(part => part?.trim().toLowerCase());
        if (property && value && SPAN_STYLES[property]?.test(value)) kept.push(`${property}:${value}`);
    }
    return kept.join(';');
}

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g;

/** Tags whose meaning is kept, with the tag written for them. */
const INLINE_TAGS: Record<string, string> = { i: 'i', em: 'i', b: 'b', strong: 'b', sup: 'sup', sub: 'sub' };

export interface SanitizeOptions {
    /** Keep `<a href>` to web addresses (false inside a link, where anchors cannot nest). */
    links?: boolean;
}

/**
 * Citation processor HTML with only its formatting subset left: emphasis,
 * super/subscript, styled spans, web links, line breaks and the
 * bibliography's `csl-*` layout divs. Text is re-escaped; other markup is
 * dropped. The result is always balanced.
 */
export function sanitizeCslHtml(html: string, options: SanitizeOptions = {}): string {
    const links = options.links ?? true;
    let out = '';
    // Each open source tag and the tag written for it (null: nothing written).
    const stack: Array<{ tag: string; written: string | null }> = [];

    for (const match of html.matchAll(TAG_PATTERN)) {
        const [, closing, rawTag, attributes = '', selfClosing, text] = match;
        if (text !== undefined) {
            // Whitespace between block-level divs is layout, not content.
            if (!text.trim() && /\n/.test(text)) continue;
            out += escapeHtml(decodeHtmlEntities(text));
            continue;
        }
        const tag = rawTag.toLowerCase();
        if (tag === 'br') {
            out += '<br>';
            continue;
        }
        if (closing) {
            const index = stack.map(entry => entry.tag).lastIndexOf(tag);
            if (index < 0) continue;
            for (const entry of stack.splice(index).reverse()) {
                if (entry.written) out += `</${entry.written}>`;
            }
            continue;
        }
        if (selfClosing) continue;

        let written: string | null = null;
        let open = '';
        if (INLINE_TAGS[tag]) {
            written = INLINE_TAGS[tag];
            open = `<${written}>`;
        } else if (tag === 'span') {
            const style = spanStyle(attributes);
            if (style) {
                written = 'span';
                open = `<span style="${style}">`;
            }
        } else if (tag === 'a') {
            const href = decodeHtmlEntities(/href\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '');
            if (links && isWebLink(href)) {
                written = 'a';
                open = `<a href="${escapeHtml(href.trim())}">`;
            }
        } else if (tag === 'div') {
            const classes = (/class\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '')
                .split(/\s+/)
                .filter(name => /^csl-[a-z-]+$/.test(name));
            written = 'div';
            open = classes.length > 0 ? `<div class="${classes.join(' ')}">` : '<div>';
        }
        out += open;
        stack.push({ tag, written });
    }
    for (const entry of stack.reverse()) {
        if (entry.written) out += `</${entry.written}>`;
    }
    return out;
}
