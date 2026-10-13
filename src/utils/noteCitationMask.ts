import {
    CITATION_TAG_PATTERN,
    parseRawCitationAttributes,
    unwrapBacktickedCitations,
} from '@beaver/agent-core/citations/citationGrammar';

/**
 * Text with its citation tags lifted out.
 *
 * Note writes never let the Markdown renderer format citations: the chat
 * renderer's export form depends on thread metadata and drops citations it
 * cannot resolve. The renderer swaps each tag for an inert placeholder,
 * renders, and puts the tags back; the plugin realm then expands them with the
 * note citation builder, so `create_note` and `edit_note` store the same
 * citation HTML for the same tag.
 */
export interface MaskedNoteCitations {
    /** The input with every citation tag replaced by a placeholder. */
    text: string;
    /** Original tags in placeholder order, normalized to `<citation …/>`. */
    tags: string[];
    /**
     * Tags inside code or escaped with a backslash, verbatim. They are masked
     * too, so the renderer's own citation preprocessing cannot rewrite them,
     * and come back as escaped text.
     */
    literals: string[];
    /** Placeholder prefix; chosen so it never occurs in the input. */
    prefix: string;
}

/**
 * Rebuild a tag's attributes in the double-quoted form the note expander
 * reads. Parsing matches the Markdown renderer's (`parseRawCitationAttributes`),
 * so a single-quoted or JSON-escaped tag it accepts stays valid here.
 */
function canonicalCitationTag(attrs: string | undefined): string {
    const serialized = Object.entries(parseRawCitationAttributes(attrs))
        .map(([name, value]) => `${name}="${value.replace(/"/g, '&quot;')}"`)
        .join(' ');
    return `<citation ${serialized}/>`;
}

/** Source ranges (`[start, end)`) of the code in a text, sorted by start. */
export type CodeRangeFinder = (text: string) => Array<[number, number]>;

/**
 * Swap each citation tag for a placeholder: a citation placeholder, or a
 * literal one for a tag inside `codeRanges` or, with `markdownEscapes`, one
 * written as `\<citation …>`. Markdown shows an escaped tag as text, so its
 * literal absorbs the escaping backslash and comes back as that text.
 */
function maskTags(text: string, codeRanges: Array<[number, number]>, markdownEscapes: boolean): MaskedNoteCitations {
    let prefix = 'BEAVERNOTECITATION';
    for (let n = 1; text.includes(prefix); n++) {
        prefix = `BEAVERNOTECITATION${n}N`;
    }
    const inCode = (offset: number) => codeRanges.some(([start, end]) => offset >= start && offset < end);
    const tags: string[] = [];
    const literals: string[] = [];
    const literal = (tag: string) => `\u27E6${prefix}L${literals.push(tag) - 1}\u27E7`;
    // Backslashes before a tag are captured to tell an escaped `<` (odd run)
    // from escaped backslashes followed by a real tag (even run).
    const pattern = new RegExp(`(\\\\*)(?:${CITATION_TAG_PATTERN.source})`, CITATION_TAG_PATTERN.flags);
    const masked = text.replace(pattern, (match: string, slashes: string, attrs: string | undefined, offset: number) => {
        const tag = match.slice(slashes.length);
        if (inCode(offset + slashes.length)) return slashes + literal(tag);
        if (markdownEscapes && slashes.length % 2 === 1) return slashes.slice(1) + literal(tag);
        const index = tags.push(canonicalCitationTag(attrs)) - 1;
        return `${slashes}\u27E6${prefix}${index}\u27E7`;
    });
    return { text: masked, tags, literals, prefix };
}

/**
 * Replace the citation tags of note Markdown (self-closing, open-only,
 * open+close and backtick-wrapped forms, as the renderer accepts) with
 * placeholders, before rendering.
 *
 * Tags inside code, and tags escaped as `\<citation …>`, are examples, not
 * citations, and stay as written.
 * `findCodeRanges` is the Markdown grammar the chat renders with, so fenced,
 * indented and inline code are recognized exactly as rendered; it runs after
 * tag-only backtick spans are unwrapped, as the renderer does.
 *
 * Placeholders are alphanumerics between `⟦` and `⟧`: Markdown and the note
 * normalizer pass them through unchanged, and because both delimiters are
 * punctuation (like the `<` and `>` they replace) emphasis next to a citation
 * parses as before.
 */
export function maskNoteCitationTags(content: string, findCodeRanges: CodeRangeFinder): MaskedNoteCitations {
    const unwrapped = unwrapBacktickedCitations(content);
    return maskTags(unwrapped, findCodeRanges(unwrapped), true);
}

/**
 * Replace the citation tags in rendered note HTML with placeholders. Code
 * examples there are already escaped text, so every tag is a citation.
 */
export function maskRenderedCitationTags(html: string): MaskedNoteCitations {
    return maskTags(html, [], false);
}

/** Escape text for HTML, the way the Markdown renderer escapes code text. */
function escapeHtmlText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * Put citations back in place of their placeholders. `replace` maps each
 * original tag to its stored form; by default the tag itself is restored.
 * Tags that were inside code come back as their escaped original text.
 */
export function unmaskNoteCitationTags(
    text: string,
    masked: MaskedNoteCitations,
    replace: (tag: string, index: number) => string = (tag) => tag,
): string {
    if (masked.tags.length === 0 && masked.literals.length === 0) return text;
    return text.replace(new RegExp(`\u27E6${masked.prefix}(L?)(\\d+)\u27E7`, 'g'), (match, literal: string, index: string) => {
        if (literal) {
            const original = masked.literals[Number(index)];
            return original === undefined ? match : escapeHtmlText(original);
        }
        const tag = masked.tags[Number(index)];
        return tag === undefined ? match : replace(tag, Number(index));
    });
}
