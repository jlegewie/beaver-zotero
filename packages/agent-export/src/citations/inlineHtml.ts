/**
 * Convert the small HTML subset a CSL processor emits (citeproc-js `html`
 * output mode) into styled text segments that any writer can map to its own
 * markup.
 *
 * Handled: `<i>`, `<b>`, `<sup>`, `<sub>`, `<span style="…">` (italic, bold,
 * small caps, underline, normal/baseline resets), `<a href>`, and the
 * bibliography layout divs (`csl-left-margin` ends with a tab so the entry
 * aligns on the style's tab stop; `csl-block`/`csl-indent` start a new line).
 */

export interface StyledSegment {
    text: string;
    italic?: boolean;
    bold?: boolean;
    smallCaps?: boolean;
    underline?: boolean;
    superscript?: boolean;
    subscript?: boolean;
    link?: string;
    /** A line break before this segment's text. */
    lineBreak?: boolean;
}

type Style = Omit<StyledSegment, 'text' | 'lineBreak'>;

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', hellip: '…',
};

/** Decode the HTML entities a CSL processor emits. */
export function decodeHtmlEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
        if (entity[0] === '#') {
            const code = entity[1] === 'x' || entity[1] === 'X'
                ? Number.parseInt(entity.slice(2), 16)
                : Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function styleFromSpan(attributes: string): Style {
    const style: Style = {};
    const css = /style\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '';
    for (const declaration of css.split(';')) {
        const [property, rawValue] = declaration.split(':').map(part => part?.trim().toLowerCase());
        if (!property || !rawValue) continue;
        if (property === 'font-style') style.italic = rawValue === 'italic' || rawValue === 'oblique';
        else if (property === 'font-weight') style.bold = rawValue === 'bold' || Number(rawValue) >= 600;
        else if (property === 'font-variant') style.smallCaps = rawValue === 'small-caps';
        else if (property === 'text-decoration') style.underline = rawValue.includes('underline');
        else if (property === 'vertical-align' && rawValue === 'baseline') {
            style.superscript = false;
            style.subscript = false;
        }
    }
    return style;
}

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g;

/** Parse CSL processor HTML into styled segments. */
export function parseCslHtml(html: string): StyledSegment[] {
    const segments: StyledSegment[] = [];
    const stack: Array<{ tag: string; style: Style; after?: string }> = [];
    let pendingBreak = false;

    const current = (): Style => Object.assign({}, ...stack.map(entry => entry.style));
    const push = (text: string) => {
        if (!text) return;
        const segment: StyledSegment = { text, ...current() };
        if (pendingBreak && segments.length > 0) segment.lineBreak = true;
        pendingBreak = false;
        for (const key of Object.keys(segment) as Array<keyof StyledSegment>) {
            if (segment[key] === false || segment[key] === undefined) delete segment[key];
        }
        segments.push(segment);
    };

    for (const match of html.matchAll(TAG_PATTERN)) {
        const [, closing, rawTag, attributes = '', selfClosing, text] = match;
        if (text !== undefined) {
            // Whitespace between block-level divs is layout, not content.
            if (!text.trim() && /\n/.test(text)) continue;
            push(decodeHtmlEntities(text));
            continue;
        }
        const tag = rawTag.toLowerCase();
        if (tag === 'br') {
            pendingBreak = true;
            continue;
        }
        if (closing) {
            const index = stack.map(entry => entry.tag).lastIndexOf(tag);
            if (index >= 0) {
                const [entry] = stack.splice(index, 1);
                if (entry.after) push(entry.after);
            }
            continue;
        }
        if (selfClosing) continue;
        let style: Style = {};
        let after: string | undefined;
        if (tag === 'i' || tag === 'em') style = { italic: true };
        else if (tag === 'b' || tag === 'strong') style = { bold: true };
        else if (tag === 'sup') style = { superscript: true };
        else if (tag === 'sub') style = { subscript: true };
        else if (tag === 'span') style = styleFromSpan(attributes);
        else if (tag === 'a') {
            const href = /href\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
            if (href) style = { link: decodeHtmlEntities(href) };
        } else if (tag === 'div') {
            const className = /class\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '';
            if (className.includes('csl-left-margin')) after = '\t';
            else if (className.includes('csl-block') || className.includes('csl-indent')) pendingBreak = true;
        }
        stack.push({ tag, style, after });
    }
    return mergeSegments(segments);
}

function sameStyle(a: StyledSegment, b: StyledSegment): boolean {
    const keys: Array<keyof Style> = ['italic', 'bold', 'smallCaps', 'underline', 'superscript', 'subscript', 'link'];
    return keys.every(key => a[key] === b[key]);
}

function mergeSegments(segments: StyledSegment[]): StyledSegment[] {
    const merged: StyledSegment[] = [];
    for (const segment of segments) {
        const last = merged[merged.length - 1];
        if (last && !segment.lineBreak && sameStyle(last, segment)) {
            last.text += segment.text;
        } else {
            merged.push({ ...segment });
        }
    }
    return merged;
}

/** The visible text of CSL processor HTML. */
export function cslHtmlToText(html: string): string {
    return parseCslHtml(html)
        .map(segment => (segment.lineBreak ? '\n' : '') + segment.text)
        .join('');
}
